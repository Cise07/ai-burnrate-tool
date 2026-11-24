import { useId, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { ENV_OVERRIDES, HOOK_MATRIX } from '../data/siteData';

interface ArchitectureFlowProps {
  onAnnounce: (msg: string) => void;
}

type StageId = 'ingest' | 'engine' | 'surfaces';

const STAGES: Array<{
  id: StageId;
  tag: string;
  accent: 'cyan' | 'teal' | 'flame';
  title: string;
  subtitle: string;
  command: string;
  facts: Array<{ label: string; value: string }>;
}> = [
  {
    id: 'ingest',
    tag: 'Read-only disk scan',
    accent: 'cyan',
    title: 'Local AI transcripts',
    subtitle: 'Watches ~/.gemini, ~/.claude, and ~/.codex read-only without mutating a single log file.',
    command: 'burn',
    facts: [
      { label: 'Archive store', value: '~/.burnrate/sessions-ledger.json' },
      { label: 'Deleted chats', value: 'Preserved automatically in local archive' },
      { label: 'Side-chats', value: 'Full subagent & /btw turn attribution' },
    ],
  },
  {
    id: 'engine',
    tag: 'Zero-daemon hooks',
    accent: 'teal',
    title: 'ETag pricing & resets',
    subtitle: 'Hooks snapshot turns in milliseconds, sync LiteLLM tariffs via O_CREAT|O_EXCL lock, and support per-tool resets.',
    command: 'burn --reset-tool claude && burn --export-backup',
    facts: [
      { label: 'Pricing sync', value: '30m LiteLLM ETag (304 Not Modified) + 60s stale lock recovery' },
      { label: 'Per-tool reset', value: 'trackingStartAt zeroes older turns; reversible from any date' },
      { label: 'Portable backup', value: 'Validated JSON bundle · Merge or Replace restore' },
    ],
  },
  {
    id: 'surfaces',
    tag: 'Local + LAN mDNS',
    accent: 'flame',
    title: 'Web UI, CLI & mobile PIN',
    subtitle: 'Streams live SSE updates to localhost:4321, prints ANSI CLI reports, or pairs your phone over local Wi-Fi.',
    command: 'burn --cli --eur',
    facts: [
      { label: 'mDNS discovery', value: 'RFC 6762 http://ai-burnrate.local:<port> + QR code' },
      { label: 'LAN security', value: '6-digit PIN via crypto.timingSafeEqual + 5-try lockout' },
      { label: 'Headless / CI', value: 'burn --cli --json or burn --no-open' },
    ],
  },
];

export function ArchitectureFlow({ onAnnounce }: ArchitectureFlowProps) {
  const baseId = useId();
  const [activeStage, setActiveStage] = useState<StageId>('ingest');
  const [copiedCmd, setCopiedCmd] = useState<boolean>(false);

  const stage = STAGES.find((s) => s.id === activeStage) ?? STAGES[0];

  const copyStageCommand = async () => {
    try {
      await navigator.clipboard.writeText(stage.command);
      setCopiedCmd(true);
      onAnnounce(`Copied ${stage.command} to clipboard`);
      setTimeout(() => setCopiedCmd(false), 1600);
    } catch {
      onAnnounce('Could not copy automatically.');
    }
  };

  return (
    <section id="pipeline" className="py-16 sm:py-20 border-t border-hairline">
      <div className="max-w-[74rem] mx-auto px-4 sm:px-8">
        <div className="scroll-arrive max-w-2xl">
          <h2 className="text-2xl sm:text-[2rem] font-bold tracking-[-0.03em] text-ink">
            How every turn flows on your machine
          </h2>
          <p className="mt-2 text-sm sm:text-[15px] text-muted leading-relaxed">
            No cloud account and no background OS daemon. Select any stage below to inspect the exact files, hooks, locks, and terminal output.
          </p>
        </div>

        {/* Frosted-Glass 3-Stage Pipeline Track (staggered scroll convergence) */}
        <div
          role="tablist"
          aria-label="Local telemetry architecture stages"
          className="mt-8 grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-3 lg:gap-0"
        >
          {STAGES.map((item, idx) => {
            const active = activeStage === item.id;
            const accentText =
              item.accent === 'flame'
                ? 'text-flame'
                : item.accent === 'cyan'
                  ? 'text-cyanTool'
                  : 'text-brand';
            const accentBar =
              item.accent === 'flame'
                ? 'bg-flame'
                : item.accent === 'cyan'
                  ? 'bg-cyanTool'
                  : 'bg-brand';

            return (
              <div key={item.id} className="contents">
                <button
                  id={`${baseId}-stage-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveStage(item.id)}
                  className={`pipeline-stage-card scroll-stage-${idx} glass-panel glass-sheen relative text-left rounded-xl p-5 cursor-pointer flex flex-col justify-between gap-3 overflow-hidden ${
                    active ? 'border-hairlineStrong' : 'hover:border-hairlineStrong'
                  }`}
                >
                  <span
                    className={`scroll-stage-accent absolute inset-x-0 top-0 h-[2.5px] transition-opacity ${accentBar} ${
                      active ? 'opacity-100' : 'opacity-25'
                    }`}
                    aria-hidden="true"
                  />
                  <div>
                    <div className={`font-mono text-[11px] font-semibold ${accentText}`}>
                      {item.tag}
                    </div>
                    <h3 className="mt-1.5 text-base font-bold text-ink">{item.title}</h3>
                    <p className="mt-1.5 text-xs sm:text-[13px] text-muted leading-relaxed">
                      {item.subtitle}
                    </p>
                  </div>
                  <div className="pt-2.5 border-t border-hairline font-mono text-[11px] text-subtle flex items-center justify-between">
                    <span className="truncate">$ {item.command}</span>
                    <span className={active ? `${accentText} font-semibold shrink-0 ml-2` : 'shrink-0 ml-2'}>
                      {active ? 'Active' : 'Inspect →'}
                    </span>
                  </div>
                </button>

                {idx < STAGES.length - 1 && (
                  <div
                    className="hidden lg:flex items-center justify-center w-10 shrink-0"
                    aria-hidden="true"
                  >
                    <svg width="40" height="24" viewBox="0 0 40 24" fill="none">
                      <path
                        d="M2 12H34"
                        stroke="var(--accent-teal)"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        className="pipeline-flow-line"
                      />
                      <path
                        d="M29 6L36 12L29 18"
                        stroke="var(--accent-flame)"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Synchronized Inspector: Smoked Glass Dark Terminal (7 cols) + Frosted Glass Specs (5 cols) */}
        <div
          role="tabpanel"
          aria-labelledby={`${baseId}-stage-${activeStage}`}
          className="scroll-glass-card mt-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch"
        >
          <div className="lg:col-span-7 terminal-surface rounded-2xl overflow-hidden flex flex-col">
            <div className="px-4 py-2.5 bg-[#0b1721]/80 border-b border-[#253e52] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-mono text-xs text-[#a4bdd1] min-w-0">
                <span className="h-2 w-2 rounded-full bg-[#2dd4bf] shrink-0" aria-hidden="true" />
                <span className="truncate">{stage.title} — terminal</span>
              </div>
              <button
                type="button"
                onClick={() => void copyStageCommand()}
                aria-label={`Copy ${stage.command}`}
                className="inline-flex items-center gap-1.5 min-h-[28px] px-2.5 rounded-md border border-[#2d485e] bg-[#162a3a]/80 hover:border-[#4b7291] font-mono text-[11px] text-[#dbe8f2] hover:text-white cursor-pointer shrink-0"
              >
                {copiedCmd ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#2dd4bf]" aria-hidden="true" />
                    <span className="text-[#2dd4bf]">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>

            <div key={activeStage} className="panel-swap-enter p-5 font-mono text-xs leading-relaxed overflow-x-auto flex-1">
              {activeStage === 'ingest' && (
                <>
                  <div className="text-[#92adc2] mb-3">
                    <span className="text-[#fb7349] font-semibold">$</span> burn
                  </div>
                  <pre className="m-0 text-[#edf5f9] whitespace-pre">
                    <span className="text-[#2dd4bf] font-semibold">AI-BURNRATE-TOOL</span>{'  '}
                    <span className="text-[#34d399]">● LIVE</span>{'  '}
                    <span className="text-[#a4bdd1]">Real-Time Token &amp; Cost Tracker</span>
                    {'\n──────────────────────────────────────────────────────────\n'}
                    {'Dashboard URL:  '}
                    <span className="text-[#38bdf8]">http://localhost:4321</span>
                    {'\nMobile URL:     '}
                    <span className="text-[#2dd4bf]">http://ai-burnrate.local:4321</span>{'  (mDNS · Bonjour)\n'}
                    {'Fallback IP:    http://192.168.1.42:4321       (0.0.0.0)\n'}
                    {'Phone Code:     '}
                    <span className="text-[#fbbf24] font-semibold">[ 482916 ]</span>{'  (enter on phone or scan QR)\n'}
                    {'SSE Stream:     http://localhost:4321/api/events\n'}
                    {'Watching:       ~/.gemini & ~/.claude & ~/.codex\n'}
                    {'Sessions Found: 14\n\n'}
                    <span className="text-[#92adc2]">[14:08:12]</span>{' '}
                    <span className="text-[#2dd4bf]">● SSE Sync</span>{' <- ~/.claude/projects/saas-billing/session.jsonl'}
                  </pre>
                </>
              )}

              {activeStage === 'engine' && (
                <pre className="m-0 text-[#edf5f9] whitespace-pre">
                  <span className="text-[#fb7349] font-semibold">$</span>{' burn --reset-tool claude\n'}
                  <span className="text-[#2dd4bf]">  ok</span>{'  Tracking reset active for claude from 11/24/2026, 2:05 PM.\n'}
                  <span className="text-[#92adc2]">      Prior turns excluded; tool transcripts untouched.</span>
                  {'\n\n'}
                  <span className="text-[#fb7349] font-semibold">$</span>{' burn --restore-tool claude --since 2026-11-15\n'}
                  <span className="text-[#2dd4bf]">  ok</span>{'  Restored tracking history for claude from 11/15/2026.\n\n'}
                  <span className="text-[#fb7349] font-semibold">$</span>{' burn --export-backup\n'}
                  <span className="text-[#2dd4bf]">  ok</span>{'  Exported ./burnrate-backup-2026-11-24.json (142.8 KB)\n'}
                  <span className="text-[#92adc2]">      48 sessions · 4 pricing snapshots · user settings</span>
                  {'\n\n'}
                  <span className="text-[#fb7349] font-semibold">$</span>{' burn --import-backup burnrate-backup-2026-11-24.json\n'}
                  <span className="text-[#2dd4bf]">  ok</span>{'  Imported backup (merge mode) — +48 sessions restored'}
                </pre>
              )}

              {activeStage === 'surfaces' && (
                <>
                  <div className="text-[#92adc2] mb-3">
                    <span className="text-[#fb7349] font-semibold">$</span> burn --cli --eur
                  </div>
                  <pre className="m-0 text-[#edf5f9] whitespace-pre">
                    <span className="text-[#2dd4bf] font-semibold">AI-BURNRATE-TOOL</span>{'  Local Token & API Cost Report  '}
                    <span className="text-[#fbbf24]">[EUR]</span>
                    {'\n────────────────────────────────────────────────────────────────────\n'}
                    {'API Equiv. Spend: '}
                    <span className="text-[#fb7349] font-semibold">€220.05</span>
                    {'   Cache Saved: '}
                    <span className="text-[#2dd4bf] font-semibold">€395.08</span>
                    {'   Tokens: 66.95M\n\n'}
                    <span className="text-[#92adc2]">TOOL BREAKDOWN     Chats   Turns   Cache Read   Output   API Cost</span>
                    {'\n────────────────────────────────────────────────────────────────────\n'}
                    <span className="text-[#38bdf8]">Antigravity CLI</span>{'        4      41       20.41M    0.64M     €68.21\n'}
                    <span className="text-[#c084fc]">Claude Code</span>{'            4      86       33.12M    1.12M    €139.92\n'}
                    <span className="text-[#fbbf24]">Codex CLI</span>{'              1      24        6.27M    0.28M     €11.92\n\n'}
                    <span className="text-[#92adc2]">WORKSPACES &amp; CHATS</span>
                    {'\n'}
                    <span className="text-[#c084fc]">Claude Code</span>{'  saas-billing-engine  Claude Opus 4.5+   19t   €52.48\n'}
                    {'  └─ '}
                    <span className="text-[#2dd4bf]">[BTW]</span>{' Check Stripe webhook retry backoff         1t    €0.31\n'}
                    {'  └─ '}
                    <span className="text-[#2dd4bf]">[BTW]</span>{' Verify EU VAT proration rounding           1t    €0.29'}
                  </pre>
                </>
              )}
            </div>
          </div>

          <div className="lg:col-span-5 rounded-2xl glass-panel divide-y divide-hairline flex flex-col">
            <div className="p-5">
              <h3 className="text-xs font-mono font-semibold text-ink">
                Stage guarantees — {stage.tag}
              </h3>
              <dl className="mt-3 space-y-2.5 text-xs">
                {stage.facts.map((f) => (
                  <div key={f.label} className="flex flex-col gap-0.5">
                    <dt className="font-mono text-[11px] font-semibold text-brand">{f.label}</dt>
                    <dd className="text-muted leading-snug">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="p-5">
              <h3 className="text-xs font-mono font-semibold text-ink">
                Offline hooks &amp; directory overrides
              </h3>
              <ul className="mt-2.5 space-y-1.5 list-none p-0 m-0 font-mono text-[11px]">
                {HOOK_MATRIX.map((h) => (
                  <li key={h.tool} className="flex items-baseline justify-between gap-2">
                    <span className="text-ink font-medium">{h.tool}</span>
                    <code className="text-muted truncate">{h.configPath}</code>
                  </li>
                ))}
              </ul>
              <ul className="mt-3 pt-3 border-t border-hairline grid grid-cols-1 sm:grid-cols-2 gap-1.5 list-none p-0 m-0 font-mono text-[10.5px]">
                {ENV_OVERRIDES.map((env) => (
                  <li key={env.name} className="truncate">
                    <code title={env.desc} className="text-flame font-medium">
                      {env.name.split(' / ')[0]}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
