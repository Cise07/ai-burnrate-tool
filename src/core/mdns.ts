import dgram from 'node:dgram';
import os from 'node:os';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_NSEC = 47;
const TYPE_ANY = 255;

const CLASS_IN = 0x0001;
const CLASS_IN_FLUSH = 0x8001;

const DEFAULT_TTL = 120;
const LEGACY_TTL = 10;

export interface MdnsResponderHandle {
  hostname: string;
  ip: string;
  close: () => Promise<void>;
}

function normalizeHostname(name: string): string {
  return name.trim().replace(/\.+$/, '').toLowerCase();
}

function encodeDnsName(hostname: string): Buffer {
  const clean = normalizeHostname(hostname);
  const labels = clean.split('.').filter(Boolean);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const buf = Buffer.from(label, 'utf-8');
    if (buf.length === 0 || buf.length > 63) {
      throw new Error(`Invalid DNS label: ${label}`);
    }
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeIpv4(ip: string): Buffer | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return Buffer.from(bytes);
}

function decodeDnsName(
  msg: Buffer,
  startOffset: number
): { name: string; nextOffset: number } | null {
  const labels: string[] = [];
  let offset = startOffset;
  let nextOffset = -1;
  let jumps = 0;

  while (offset < msg.length) {
    const len = msg[offset];
    if (len === 0) {
      if (nextOffset === -1) nextOffset = offset + 1;
      return { name: labels.join('.').toLowerCase(), nextOffset };
    }

    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= msg.length) return null;
      const pointer = ((len & 0x3f) << 8) | msg[offset + 1];
      if (pointer >= msg.length) return null;
      if (nextOffset === -1) nextOffset = offset + 2;
      offset = pointer;
      jumps += 1;
      if (jumps > 16) return null;
      continue;
    }

    if ((len & 0xc0) !== 0) return null;
    const end = offset + 1 + len;
    if (end > msg.length) return null;
    labels.push(msg.subarray(offset + 1, end).toString('utf-8'));
    offset = end;
  }

  return null;
}

interface ParsedQuestion {
  name: string;
  qtype: number;
  qclass: number;
  raw: Buffer;
}

function parseQuestions(msg: Buffer): { id: number; flags: number; questions: ParsedQuestion[] } | null {
  if (msg.length < 12) return null;
  const id = msg.readUInt16BE(0);
  const flags = msg.readUInt16BE(2);
  // Ignore DNS responses (QR = 1)
  if ((flags & 0x8000) !== 0) return null;

  const qdcount = msg.readUInt16BE(4);
  if (qdcount === 0 || qdcount > 64) return null;

  const questions: ParsedQuestion[] = [];
  let offset = 12;

  for (let i = 0; i < qdcount; i++) {
    const qStart = offset;
    const decoded = decodeDnsName(msg, offset);
    if (!decoded) return null;
    offset = decoded.nextOffset;
    if (offset + 4 > msg.length) return null;
    const qtype = msg.readUInt16BE(offset);
    const qclass = msg.readUInt16BE(offset + 2);
    offset += 4;
    questions.push({
      name: decoded.name,
      qtype,
      qclass,
      raw: msg.subarray(qStart, offset),
    });
  }

  return { id, flags, questions };
}

function buildRecord(
  encodedName: Buffer,
  type: number,
  rrClass: number,
  ttl: number,
  rdata: Buffer
): Buffer {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(rrClass, 2);
  header.writeUInt32BE(ttl, 4);
  header.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodedName, header, rdata]);
}

function buildDnsPacket(params: {
  id: number;
  flags: number;
  questions?: Buffer[];
  answers?: Buffer[];
  additionals?: Buffer[];
}): Buffer {
  const questions = params.questions ?? [];
  const answers = params.answers ?? [];
  const additionals = params.additionals ?? [];

  const header = Buffer.alloc(12);
  header.writeUInt16BE(params.id, 0);
  header.writeUInt16BE(params.flags, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);

  return Buffer.concat([header, ...questions, ...answers, ...additionals]);
}

function getAllIpv4Interfaces(primaryIp: string): string[] {
  const ips = new Set<string>([primaryIp]);
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const info of addrs) {
      const family = String(info.family);
      if (info.internal || (family !== 'IPv4' && family !== '4')) continue;
      if (info.address.startsWith('169.254.')) continue;
      ips.add(info.address);
    }
  }
  return Array.from(ips);
}

export async function startMdnsResponder(
  hostname: string,
  ip: string
): Promise<MdnsResponderHandle | null> {
  const normalizedHost = normalizeHostname(hostname);
  const ipBuf = encodeIpv4(ip);
  if (!normalizedHost || !ipBuf) return null;

  let encodedName: Buffer;
  try {
    encodedName = encodeDnsName(normalizedHost);
  } catch {
    return null;
  }

  // NSEC RDATA declaring only Type 1 (A) exists for this hostname (window 0, len 1, bit 1 = 0x40)
  const nsecRdata = Buffer.concat([encodedName, Buffer.from([0x00, 0x01, 0x40])]);

  const buildStandardAResponse = (ttl: number) =>
    buildDnsPacket({
      id: 0,
      flags: 0x8400, // QR=1, AA=1
      answers: [buildRecord(encodedName, TYPE_A, CLASS_IN_FLUSH, ttl, ipBuf)],
      additionals: [buildRecord(encodedName, TYPE_NSEC, CLASS_IN_FLUSH, ttl, nsecRdata)],
    });

  const buildNegativeAaaaResponse = (ttl: number) =>
    buildDnsPacket({
      id: 0,
      flags: 0x8400,
      answers: [buildRecord(encodedName, TYPE_NSEC, CLASS_IN_FLUSH, ttl, nsecRdata)],
      additionals: [buildRecord(encodedName, TYPE_A, CLASS_IN_FLUSH, ttl, ipBuf)],
    });

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let closed = false;
  let reannounceTimer: NodeJS.Timeout | null = null;

  const safeSend = (packet: Buffer, port: number, address: string): Promise<void> =>
    new Promise((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      try {
        socket.send(packet, port, address, () => resolve());
      } catch {
        resolve();
      }
    });

  const bound = await new Promise<boolean>((resolve) => {
    const onErr = () => {
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(false);
    };
    socket.once('error', onErr);
    try {
      socket.bind(MDNS_PORT, () => {
        socket.off('error', onErr);
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

  if (!bound) return null;

  socket.on('error', () => {
    // Keep server resilient if multicast interface changes transiently
  });

  let joinedAny = false;
  for (const ifaceIp of getAllIpv4Interfaces(ip)) {
    try {
      socket.addMembership(MDNS_ADDR, ifaceIp);
      joinedAny = true;
    } catch {
      // ignore per-interface failure
    }
  }
  if (!joinedAny) {
    try {
      socket.addMembership(MDNS_ADDR);
      joinedAny = true;
    } catch {
      try {
        socket.close();
      } catch {
        // ignore
      }
      return null;
    }
  }

  try {
    socket.setMulticastInterface(ip);
  } catch {
    // ignore if OS picks default interface
  }
  try {
    socket.setMulticastTTL(255);
    socket.setMulticastLoopback(true);
  } catch {
    // ignore
  }

  socket.on('message', (msg, rinfo) => {
    if (closed) return;
    const parsed = parseQuestions(msg);
    if (!parsed) return;

    const matching = parsed.questions.filter((q) => normalizeHostname(q.name) === normalizedHost);
    if (matching.length === 0) return;

    const wantsA = matching.some((q) => q.qtype === TYPE_A || q.qtype === TYPE_ANY);
    const wantsAaaa = matching.some((q) => q.qtype === TYPE_AAAA);
    if (!wantsA && !wantsAaaa) return;

    // Legacy one-shot unicast query from non-5353 port (RFC 6762 §6.7)
    if (rinfo.port !== MDNS_PORT) {
      const targetQ = matching.find((q) => q.qtype === TYPE_A || q.qtype === TYPE_ANY) ?? matching[0];
      const answers =
        targetQ.qtype === TYPE_AAAA
          ? [buildRecord(encodedName, TYPE_NSEC, CLASS_IN, LEGACY_TTL, nsecRdata)]
          : [buildRecord(encodedName, TYPE_A, CLASS_IN, LEGACY_TTL, ipBuf)];
      const packet = buildDnsPacket({
        id: parsed.id,
        flags: 0x8400,
        questions: [targetQ.raw],
        answers,
      });
      void safeSend(packet, rinfo.port, rinfo.address);
      return;
    }

    const packet = wantsA
      ? buildStandardAResponse(DEFAULT_TTL)
      : buildNegativeAaaaResponse(DEFAULT_TTL);

    const wantsUnicast = matching.some((q) => (q.qclass & 0x8000) !== 0);
    if (wantsUnicast) {
      void safeSend(packet, rinfo.port, rinfo.address);
    }
    void safeSend(packet, MDNS_PORT, MDNS_ADDR);
  });

  // Proactive unsolicited announcement (RFC 6762 §8.3)
  const announcePacket = buildStandardAResponse(DEFAULT_TTL);
  void safeSend(announcePacket, MDNS_PORT, MDNS_ADDR);
  reannounceTimer = setTimeout(() => {
    void safeSend(announcePacket, MDNS_PORT, MDNS_ADDR);
  }, 750);
  reannounceTimer.unref();

  return {
    hostname: normalizedHost,
    ip,
    close: async () => {
      if (closed) return;
      if (reannounceTimer) {
        clearTimeout(reannounceTimer);
        reannounceTimer = null;
      }
      // Send RFC 6762 §10.1 goodbye packet (TTL = 0) before closing
      const goodbyePacket = buildStandardAResponse(0);
      await safeSend(goodbyePacket, MDNS_PORT, MDNS_ADDR);
      closed = true;
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}
