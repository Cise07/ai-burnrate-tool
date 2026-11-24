import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Menu, Moon, Sun } from 'lucide-react';
import type { Currency } from '../data/siteData';
import { useToolVersion } from '../hooks/useToolVersion';

interface NavbarProps {
  currency: Currency;
  onCurrencyChange: (next: Currency) => void;
  onThemeToggle: () => void;
}

const NAV_LINKS = [
  { href: '#workbench', label: 'Workbench' },
  { href: '#pipeline', label: 'Pipeline' },
  { href: '#activity', label: 'Heatmap' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#reference', label: 'CLI' },
  { href: '#faq', label: 'FAQ' },
];

export function Navbar({ currency, onCurrencyChange, onThemeToggle }: NavbarProps) {
  const headerRef = useRef<HTMLElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const lastHeaderWidthRef = useRef<number>(0);
  const [activeHash, setActiveHash] = useState<string>('#workbench');
  const toolVersion = useToolVersion();

  useEffect(() => {
    if (typeof window !== 'undefined' && !Object.hasOwn(HTMLElement.prototype, 'popover')) {
      void import('@oddbird/popover-polyfill');
    }
  }, []);

  useEffect(() => {
    const bar = progressRef.current;
    if (!bar) return;
    if (
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('animation-timeline', 'scroll()')
    ) {
      return;
    }
    if (!window.matchMedia('(prefers-reduced-motion: no-preference)').matches) {
      return;
    }

    const onScroll = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const pct = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
      bar.style.transform = `scaleX(${pct})`;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const inner = innerRef.current;
    const menu = menuRef.current;
    if (!header || !inner || !menu) return;

    const syncLayout = (forceMeasure: boolean) => {
      const currentWidth = header.clientWidth;
      const isCurrentlyWide = header.classList.contains('is-wide');
      if (!forceMeasure && !isCurrentlyWide && currentWidth <= lastHeaderWidthRef.current) {
        lastHeaderWidthRef.current = currentWidth;
        return;
      }
      lastHeaderWidthRef.current = currentWidth;

      const wasPopoverOpen =
        !isCurrentlyWide &&
        (menu.matches(':popover-open') || menu.classList.contains(':popover-open'));

      header.classList.add('is-measuring');
      header.classList.add('is-wide');
      menu.removeAttribute('popover');

      const fitsInline = inner.scrollWidth <= inner.clientWidth;

      if (!fitsInline) {
        header.classList.remove('is-wide');
        menu.setAttribute('popover', 'auto');
        if (
          wasPopoverOpen &&
          typeof (menu as HTMLElement & { showPopover?: () => void }).showPopover === 'function'
        ) {
          try {
            (menu as HTMLElement & { showPopover: () => void }).showPopover();
          } catch {
            // ignore if already open
          }
        }
      }

      requestAnimationFrame(() => {
        header.classList.remove('is-measuring');
      });
    };

    syncLayout(true);

    // Smooth scroll-linked scale (1 -> 0.988 over 0..100px) driven via rAF instead of
    // CSS animation-timeline: scroll() to avoid Chromium's reload compositor blur bug.
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let scaleRaf = 0;
    const applyScrollScale = () => {
      scaleRaf = 0;
      if (reducedMotion.matches) {
        inner.style.transform = '';
        return;
      }
      const p = Math.min(1, Math.max(0, window.scrollY / 100));
      if (p <= 0) {
        inner.style.transform = '';
      } else {
        const ty = (-3 * p).toFixed(2);
        const sc = (1 - 0.012 * p).toFixed(4);
        inner.style.transform = `translateY(${ty}px) scale(${sc})`;
      }
    };
    const onScroll = () => {
      if (!scaleRaf) scaleRaf = requestAnimationFrame(applyScrollScale);
    };
    applyScrollScale();
    window.addEventListener('scroll', onScroll, { passive: true });
    reducedMotion.addEventListener?.('change', applyScrollScale);

    const observer = new ResizeObserver(() => {
      syncLayout(false);
    });
    observer.observe(header);
    observer.observe(menu);

    return () => {
      cancelAnimationFrame(scaleRaf);
      window.removeEventListener('scroll', onScroll);
      reducedMotion.removeEventListener?.('change', applyScrollScale);
      inner.style.transform = '';
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const ids = NAV_LINKS.map((l) => l.href.slice(1));
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (sections.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]?.target.id) {
          setActiveHash(`#${visible[0].target.id}`);
        }
      },
      { rootMargin: '-22% 0px -58% 0px', threshold: [0.1, 0.35] }
    );

    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  const closeMenuIfPopover = () => {
    const menu = menuRef.current as (HTMLUListElement & { hidePopover?: () => void }) | null;
    if (menu && menu.hasAttribute('popover') && typeof menu.hidePopover === 'function') {
      try {
        menu.hidePopover();
      } catch {
        // ignore if already closed
      }
    }
  };

  return (
    <>
      <div ref={progressRef} className="scroll-progress-bar" aria-hidden="true" />
      <header ref={headerRef} className="site-header">
        <div ref={innerRef} className="header-inner">
          <a href="#top" className="inline-flex items-center gap-2 text-ink no-underline">
            <img
              src="./logo.svg"
              alt=""
              width={24}
              height={24}
              className="w-6 h-6 rounded-md border border-hairline shrink-0"
            />
            <span className="font-mono font-semibold text-xs sm:text-[13px] tracking-tight text-ink">
              ai-burnrate-tool
            </span>
            <span className="hidden sm:inline font-mono text-[11px] text-subtle tabular">
              {toolVersion}
            </span>
          </a>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <nav aria-label="Primary" className="flex items-center">
              <button
                type="button"
                className="menu-button glass-control inline-flex items-center gap-1.5 min-h-[34px] px-2.5 rounded-md text-xs font-medium text-ink cursor-pointer"
                aria-controls="site-menu"
                {...({ popovertarget: 'site-menu', popovertargetaction: 'toggle' } as Record<
                  string,
                  string
                >)}
              >
                <Menu className="w-3.5 h-3.5 text-brand" aria-hidden="true" />
                <span>Menu</span>
              </button>

              <ul
                ref={menuRef}
                id="site-menu"
                className="site-menu"
                {...({ popover: 'auto' } as Record<string, string>)}
              >
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      aria-current={activeHash === link.href ? 'location' : undefined}
                      onClick={() => {
                        setActiveHash(link.href);
                        closeMenuIfPopover();
                      }}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
                <li>
                  <a
                    href="https://github.com/Cise07/ai-burnrate-tool"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1"
                    onClick={closeMenuIfPopover}
                  >
                    <span>GitHub</span>
                    <ArrowUpRight className="w-3.5 h-3.5 text-subtle" aria-hidden="true" />
                  </a>
                </li>
              </ul>
            </nav>

            <div
              role="group"
              aria-label="Display currency"
              className="glass-control inline-flex items-center rounded-md p-0.5 font-mono text-[11px]"
            >
              <button
                type="button"
                aria-pressed={currency === 'USD'}
                onClick={() => onCurrencyChange('USD')}
                className={`min-h-[28px] px-2 rounded transition-colors cursor-pointer ${
                  currency === 'USD'
                    ? 'bg-surface text-ink font-semibold shadow-sm'
                    : 'text-muted hover:text-ink'
                }`}
              >
                $<span className="hidden sm:inline"> USD</span>
                <span className="visually-hidden sm:hidden"> USD</span>
              </button>
              <button
                type="button"
                aria-pressed={currency === 'EUR'}
                onClick={() => onCurrencyChange('EUR')}
                className={`min-h-[28px] px-2 rounded transition-colors cursor-pointer ${
                  currency === 'EUR'
                    ? 'bg-surface text-ink font-semibold shadow-sm'
                    : 'text-muted hover:text-ink'
                }`}
              >
                €<span className="hidden sm:inline"> EUR</span>
                <span className="visually-hidden sm:hidden"> EUR</span>
              </button>
            </div>

            <button
              id="theme-toggle-btn"
              type="button"
              onClick={onThemeToggle}
              className="glass-control inline-flex items-center justify-center min-h-[34px] px-2.5 rounded-md text-ink text-xs font-medium hover:border-hairlineStrong transition-colors cursor-pointer"
              title="Toggle light and dark theme"
            >
              <span className="theme-opt-dark">
                <Moon className="w-3.5 h-3.5 text-ink" aria-hidden="true" />
                <span className="hidden md:inline font-mono text-[11px] text-muted">Dark</span>
                <span className="visually-hidden">Switch to dark theme</span>
              </span>
              <span className="theme-opt-light">
                <Sun className="w-3.5 h-3.5 text-codexTool" aria-hidden="true" />
                <span className="hidden md:inline font-mono text-[11px] text-muted">Light</span>
                <span className="visually-hidden">Switch to light theme</span>
              </span>
            </button>
          </div>
        </div>
      </header>
    </>
  );
}
