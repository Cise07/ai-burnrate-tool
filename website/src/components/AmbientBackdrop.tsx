import { useEffect, useMemo } from 'react';

/* Generates a physically inspired convex rounded-rectangle (squircle) optical
   refraction displacement map (R = dx, G = dy, neutral 128 in the flat interior)
   modeled on Apple iOS Liquid Glass beveled-edge Snell refraction.
   Runs once on mount (< 0.5ms) and outputs a GPU-cached PNG data URI that
   stretches cleanly to any navbar or card aspect ratio via preserveAspectRatio="none". */
function createSquircleLensMap(size: number, bevelRatio: number, cornerRatio: number): string {
  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const img = ctx.createImageData(size, size);
  const data = img.data;
  const half = size / 2;
  const r = cornerRatio * half;
  const bx = half - r;
  const by = half - r;
  const bevelPx = bevelRatio * half;

  for (let y = 0; y < size; y++) {
    const py = y + 0.5 - half;
    const ay = Math.abs(py);
    const sy = py < 0 ? -1 : 1;

    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - half;
      const ax = Math.abs(px);
      const sx = px < 0 ? -1 : 1;

      const qx = ax - bx;
      const qy = ay - by;

      // Signed distance to rounded-rect boundary (<= 0 inside, 0 on border)
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
      } else {
        if (qx > qy) {
          distInside = r - qx;
          nx = sx;
          ny = 0;
        } else {
          distInside = r - qy;
          nx = 0;
          ny = sy;
        }
      }

      let dx = 0;
      let dy = 0;

      if (distInside >= 0 && distInside < bevelPx) {
        // u = 0 right at the glass rim, u = 1 where flat interior begins
        const u = distInside / bevelPx;
        // Smooth convex glass slope (steepest near rim, eases smoothly to 0 in center)
        const curved = Math.pow(1 - u, 1.85);
        // Subtle inward-pulling lens magnification along surface normal
        dx = -nx * curved;
        dy = -ny * curved;
      }

      const idx = (y * size + x) * 4;
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
   - #ios-liquid-glass-bar: strong convex bevel refraction + subtle RGB prism dispersion
     for floating chrome (navbar) where page elements scroll directly underneath.
   - #ios-liquid-glass-card: smooth beveled lens refraction for translucent glass cards. */
export function AmbientBackdrop() {
  const { barLensMap, cardLensMap } = useMemo(
    () => ({
      barLensMap: createSquircleLensMap(128, 0.34, 0.36),
      cardLensMap: createSquircleLensMap(128, 0.22, 0.16),
    }),
    []
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
      document.documentElement.classList.remove('liquid-glass-ready');
    };
  }, [barLensMap, cardLensMap]);

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
          {/* Floating capsule Liquid Glass: convex edge warp + subtle RGB chromatic dispersion */}
          <filter
            id="ios-liquid-glass-bar"
            x="0%"
            y="0%"
            width="100%"
            height="100%"
            colorInterpolationFilters="sRGB"
          >
            {barLensMap && (
              <>
                <feImage
                  href={barLensMap}
                  x="0%"
                  y="0%"
                  width="100%"
                  height="100%"
                  preserveAspectRatio="none"
                  result="barMap"
                />
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

          {/* Card Liquid Glass: single-pass convex rim refraction (crystal-clear interior) */}
          <filter
            id="ios-liquid-glass-card"
            x="0%"
            y="0%"
            width="100%"
            height="100%"
            colorInterpolationFilters="sRGB"
          >
            {cardLensMap && (
              <>
                <feImage
                  href={cardLensMap}
                  x="0%"
                  y="0%"
                  width="100%"
                  height="100%"
                  preserveAspectRatio="none"
                  result="cardMap"
                />
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

        {/* Soft layered SVG curves (no full-viewport CSS blur filter pass) */}
        <svg
          className="ambient-rings absolute inset-0 w-full h-full"
          viewBox="0 0 1440 960"
          preserveAspectRatio="xMidYMid slice"
          fill="none"
        >
          <g className="ambient-ring-group-a">
            <circle cx="220" cy="260" r="260" stroke="var(--ring-teal)" strokeWidth="36" strokeOpacity="0.08" />
            <circle cx="220" cy="260" r="260" stroke="var(--ring-teal)" strokeWidth="16" strokeOpacity="0.14" />
            <circle cx="220" cy="260" r="370" stroke="var(--ring-cyan)" strokeWidth="14" strokeOpacity="0.12" strokeDasharray="18 22" />
          </g>
          <g className="ambient-ring-group-b">
            <circle cx="1240" cy="420" r="290" stroke="var(--ring-flame)" strokeWidth="36" strokeOpacity="0.08" />
            <circle cx="1240" cy="420" r="290" stroke="var(--ring-flame)" strokeWidth="16" strokeOpacity="0.14" />
            <circle cx="1240" cy="420" r="420" stroke="var(--ring-violet)" strokeWidth="14" strokeOpacity="0.11" strokeDasharray="14 20" />
          </g>
          <g className="ambient-wave-arc">
            <path
              d="M-80 640 C 260 480, 560 790, 920 600 C 1180 460, 1360 640, 1540 550"
              stroke="var(--ring-teal)"
              strokeWidth="42"
              strokeOpacity="0.07"
            />
            <path
              d="M-80 640 C 260 480, 560 790, 920 600 C 1180 460, 1360 640, 1540 550"
              stroke="var(--ring-teal)"
              strokeWidth="16"
              strokeOpacity="0.13"
            />
          </g>
          <g className="ambient-wave-arc-b">
            <path
              d="M-60 710 C 310 560, 600 840, 960 660 C 1220 530, 1380 700, 1540 620"
              stroke="var(--ring-flame)"
              strokeWidth="36"
              strokeOpacity="0.07"
            />
            <path
              d="M-60 710 C 310 560, 600 840, 960 660 C 1220 530, 1380 700, 1540 620"
              stroke="var(--ring-flame)"
              strokeWidth="14"
              strokeOpacity="0.12"
            />
          </g>
        </svg>
      </div>
    </>
  );
}
