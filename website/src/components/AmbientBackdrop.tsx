import { useEffect, useMemo, useState } from 'react';

/* Generates a physically inspired convex rounded-rectangle (squircle) optical
   refraction displacement map (R = dx, G = dy, neutral 128 in the flat interior)
   computed at the target element's exact aspect ratio so all 4 edges have uniform
   iOS Liquid Glass bevel thickness and exact corner curvature on both mobile & desktop. */
function createSquircleLensMap(
  cssWidth: number,
  cssHeight: number,
  bevelPx: number,
  radiusPx: number
): string {
  if (typeof document === 'undefined' || cssWidth <= 0 || cssHeight <= 0) return '';
  const maxDim = 320;
  const ratio = Math.min(1, maxDim / Math.max(cssWidth, cssHeight));
  const w = Math.max(32, Math.round(cssWidth * ratio));
  const h = Math.max(24, Math.round(cssHeight * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const img = ctx.createImageData(w, h);
  const data = img.data;
  const halfW = w / 2;
  const halfH = h / 2;
  const r = Math.min(radiusPx * ratio, halfW, halfH);
  const bx = halfW - r;
  const by = halfH - r;
  const bevel = Math.max(2, Math.min(bevelPx * ratio, Math.min(halfW, halfH) * 0.65));

  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - halfH;
    const ay = Math.abs(py);
    const sy = py < 0 ? -1 : 1;

    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - halfW;
      const ax = Math.abs(px);
      const sx = px < 0 ? -1 : 1;

      const qx = ax - bx;
      const qy = ay - by;

      let distInside: number;
      let nx = 0;
      let ny = 0;

      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy);
        distInside = r - len;
        if (len > 1e-4) {
          nx = (qx / len) * sx;
          ny = (qy / len) * sy;
        }
      } else if (qx > qy) {
        distInside = r - qx;
        nx = sx;
        ny = 0;
      } else {
        distInside = r - qy;
        nx = 0;
        ny = sy;
      }

      let dx = 0;
      let dy = 0;

      if (distInside >= 0 && distInside < bevel) {
        const u = distInside / bevel;
        const curved = Math.pow(1 - u, 1.85);
        dx = -nx * curved;
        dy = -ny * curved;
      }

      const idx = (y * w + x) * 4;
      data[idx] = Math.max(0, Math.min(255, Math.round(128 + dx * 127)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(128 + dy * 127)));
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/* GPU-friendly scroll-linked optical backdrop + Apple iOS Liquid Glass SVG filters.
   Uses filterUnits="userSpaceOnUse" matched to live offsetWidth/offsetHeight so the
   squircle lens stays 100% locked inside the top bar at every DPR (1x–4x mobile/desktop). */
export function AmbientBackdrop() {
  const [barSize, setBarSize] = useState<{ w: number; h: number }>({ w: 1184, h: 56 });
  const [cardSize, setCardSize] = useState<{ w: number; h: number }>({ w: 1140, h: 540 });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;

    const attach = () => {
      const barEl = document.querySelector<HTMLElement>('.header-inner');
      const cardEl = document.querySelector<HTMLElement>('.hero-instrument');
      if (!barEl && !cardEl) return false;

      const sync = () => {
        if (barEl && barEl.offsetWidth > 0 && barEl.offsetHeight > 0) {
          const w = barEl.offsetWidth;
          const h = barEl.offsetHeight;
          setBarSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        }
        if (cardEl && cardEl.offsetWidth > 0 && cardEl.offsetHeight > 0) {
          const w = cardEl.offsetWidth;
          const h = cardEl.offsetHeight;
          setCardSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        }
      };

      sync();
      ro = new ResizeObserver(sync);
      if (barEl) ro.observe(barEl);
      if (cardEl) ro.observe(cardEl);
      return Boolean(barEl && cardEl);
    };

    if (!attach()) {
      mo = new MutationObserver(() => {
        if (attach() && mo) {
          mo.disconnect();
          mo = null;
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);

  const barLensMap = useMemo(
    () => createSquircleLensMap(barSize.w, barSize.h, 13, 17),
    [barSize.w, barSize.h]
  );

  const cardLensMap = useMemo(
    () => createSquircleLensMap(cardSize.w, cardSize.h, 24, 16),
    [cardSize.w, cardSize.h]
  );

  // Pre-decode PNG displacement maps before enabling SVG backdrop-filter so Chromium
  // builds a crisp, valid compositor filter graph on reload without requiring a click.
  useEffect(() => {
    if (typeof document === 'undefined' || !barLensMap || !cardLensMap) return;
    let cancelled = false;
    let timerId = 0;

    const preload = (src: string) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const img = new Image();
        img.onload = done;
        img.onerror = done;
        img.src = src;
        if (img.complete) done();
        else if (typeof img.decode === 'function') img.decode().then(done, done);
        window.setTimeout(done, 80);
      });

    void Promise.all([preload(barLensMap), preload(cardLensMap)]).then(() => {
      if (cancelled) return;
      timerId = window.setTimeout(() => {
        if (!cancelled) {
          document.documentElement.classList.add('liquid-glass-ready');
        }
      }, 16);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [barLensMap, cardLensMap]);

  useEffect(() => {
    return () => {
      document.documentElement.classList.remove('liquid-glass-ready');
    };
  }, []);

  return (
    <>
      <svg
        aria-hidden="true"
        width="0"
        height="0"
        className="fixed pointer-events-none"
        style={{ position: 'fixed', width: 0, height: 0, overflow: 'hidden' }}
      >
        <defs>
          {/* Floating capsule Liquid Glass: userSpaceOnUse exact-px bevel + RGB prism dispersion */}
          <filter
            id="ios-liquid-glass-bar"
            filterUnits="userSpaceOnUse"
            primitiveUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={barSize.w}
            height={barSize.h}
            colorInterpolationFilters="sRGB"
          >
            {barLensMap && (
              <>
                <feFlood floodColor="rgb(128,128,128)" floodOpacity="1" result="barNeutral" />
                <feImage
                  href={barLensMap}
                  x="0"
                  y="0"
                  width={barSize.w}
                  height={barSize.h}
                  preserveAspectRatio="none"
                  result="barMapRaw"
                />
                <feComposite in="barMapRaw" in2="barNeutral" operator="over" result="barMap" />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="barMap"
                  scale="31"
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="dispR"
                />
                <feColorMatrix
                  in="dispR"
                  type="matrix"
                  values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
                  result="chanR"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="barMap"
                  scale="28"
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="dispG"
                />
                <feColorMatrix
                  in="dispG"
                  type="matrix"
                  values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
                  result="chanG"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="barMap"
                  scale="25"
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="dispB"
                />
                <feColorMatrix
                  in="dispB"
                  type="matrix"
                  values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
                  result="chanB"
                />
                <feBlend in="chanR" in2="chanG" mode="screen" result="rg" />
                <feBlend in="rg" in2="chanB" mode="screen" />
              </>
            )}
          </filter>

          {/* Card Liquid Glass: exact-px convex rim refraction (crystal-clear interior) */}
          <filter
            id="ios-liquid-glass-card"
            filterUnits="userSpaceOnUse"
            primitiveUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={cardSize.w}
            height={cardSize.h}
            colorInterpolationFilters="sRGB"
          >
            {cardLensMap && (
              <>
                <feFlood floodColor="rgb(128,128,128)" floodOpacity="1" result="cardNeutral" />
                <feImage
                  href={cardLensMap}
                  x="0"
                  y="0"
                  width={cardSize.w}
                  height={cardSize.h}
                  preserveAspectRatio="none"
                  result="cardMapRaw"
                />
                <feComposite in="cardMapRaw" in2="cardNeutral" operator="over" result="cardMap" />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="cardMap"
                  scale="26"
                  xChannelSelector="R"
                  yChannelSelector="G"
                />
              </>
            )}
          </filter>
        </defs>
      </svg>

      {/* Fixed parallax chromatic layer sitting behind all glass surfaces */}
      <div
        aria-hidden="true"
        className="fixed inset-0 -z-10 overflow-hidden pointer-events-none select-none"
        style={{ contain: 'strict' }}
      >
        {/* Multi-stop Gaussian radial orbs — zero filter: blur() GPU cost */}
        <div className="ambient-orb ambient-orb-teal" />
        <div className="ambient-orb ambient-orb-flame" />
        <div className="ambient-orb ambient-orb-cyan" />
        <div className="ambient-orb ambient-orb-violet" />

        {/* Subtle geometric telemetry arcs drifting gently with scroll */}
        <svg
          className="ambient-rings absolute inset-0 w-full h-full"
          viewBox="0 0 1440 900"
          preserveAspectRatio="xMidYMid slice"
          fill="none"
        >
          <g className="ambient-ring-group-a" opacity="0.58">
            <circle cx="220" cy="260" r="240" stroke="var(--ring-teal)" strokeWidth="1.25" strokeDasharray="4 10" />
            <circle cx="220" cy="260" r="350" stroke="var(--ring-teal)" strokeWidth="0.95" opacity="0.65" />
            <circle cx="220" cy="260" r="460" stroke="var(--ring-cyan)" strokeWidth="0.8" strokeDasharray="2 12" opacity="0.55" />
          </g>
          <g className="ambient-ring-group-b" opacity="0.55">
            <circle cx="1240" cy="420" r="220" stroke="var(--ring-flame)" strokeWidth="1.25" strokeDasharray="3 10" />
            <circle cx="1240" cy="420" r="330" stroke="var(--ring-violet)" strokeWidth="0.95" opacity="0.7" />
          </g>
          <path
            className="ambient-wave-arc"
            d="M-140 620 Q 260 440 680 570 T 1580 480"
            stroke="var(--ring-teal)"
            strokeWidth="1.35"
            opacity="0.45"
          />
          <path
            className="ambient-wave-arc ambient-wave-arc-b"
            d="M-120 710 Q 340 540 780 650 T 1580 560"
            stroke="var(--ring-flame)"
            strokeWidth="1.2"
            opacity="0.4"
          />
        </svg>
      </div>
    </>
  );
}
