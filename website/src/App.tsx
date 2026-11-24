import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { AmbientBackdrop } from './components/AmbientBackdrop';
import { Navbar } from './components/Navbar';
import { HeroSandbox } from './components/HeroSandbox';
import { ArchitectureFlow } from './components/ArchitectureFlow';
import { HeatmapShowcase } from './components/HeatmapShowcase';
import { PricingAndCliTables } from './components/PricingAndCliTables';
import { FaqAccordion } from './components/FaqAccordion';
import type { Currency } from './data/siteData';

const INSTALL_COMMANDS = [
  { id: 'npm', label: 'npm', cmd: 'npm install -g ai-burnrate-tool' },
  { id: 'npx', label: 'npx', cmd: 'npx ai-burnrate-tool' },
  { id: 'cli', label: '--cli', cmd: 'npx ai-burnrate-tool --cli' },
];

type ResolvedScheme = 'light' | 'dark';

function readMetaScheme(): 'light' | 'dark' | 'light dark' {
  if (typeof document === 'undefined') return 'light dark';
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  const val = meta?.content?.trim();
  if (val === 'light' || val === 'dark') return val;
  return 'light dark';
}

function resolveRenderedScheme(): ResolvedScheme {
  if (typeof window === 'undefined') return 'light';
  const current = readMetaScheme();
  if (current === 'light' || current === 'dark') return current;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const [currency, setCurrency] = useState<Currency>('USD');
  const [installMode, setInstallMode] = useState<string>('npm');
  const [heroCopied, setHeroCopied] = useState<boolean>(false);
  const [footerCopied, setFooterCopied] = useState<boolean>(false);
  const [announcement, setAnnouncement] = useState<string>('');
  const [resolvedScheme, setResolvedScheme] = useState<ResolvedScheme>(() => resolveRenderedScheme());

  const currentInstall =
    INSTALL_COMMANDS.find((c) => c.id === installMode) ?? INSTALL_COMMANDS[0];

  const announce = (msg: string) => {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(msg));
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => setResolvedScheme(resolveRenderedScheme());
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'color-scheme') return;
      const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
      const nextMeta = e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : 'light dark';
      if (meta) meta.content = nextMeta;
      setResolvedScheme(resolveRenderedScheme());
    };

    mq.addEventListener('change', onSystemChange);
    window.addEventListener('storage', onStorage);
    return () => {
      mq.removeEventListener('change', onSystemChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const handleThemeToggle = () => {
    const rendered = resolveRenderedScheme();
    const target: ResolvedScheme = rendered === 'dark' ? 'light' : 'dark';
    const system: ResolvedScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';

    let nextMetaContent: 'light' | 'dark' | 'light dark' = 'light dark';
    try {
      if (target !== system) {
        localStorage.setItem('color-scheme', target);
        nextMetaContent = target;
      } else {
        localStorage.removeItem('color-scheme');
        nextMetaContent = 'light dark';
      }
    } catch {
      nextMetaContent = target;
    }

    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (meta) meta.content = nextMetaContent;
    setResolvedScheme(target);
    announce(`Switched to ${target} theme`);
  };

  const handleCopy = async (text: string, which: 'hero' | 'footer') => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'hero') {
        setHeroCopied(true);
        setTimeout(() => setHeroCopied(false), 1800);
      } else {
        setFooterCopied(true);
        setTimeout(() => setFooterCopied(false), 1800);
      }
      announce(`Copied ${text} to clipboard`);
    } catch {
      announce('Clipboard copy unavailable. Select the command to copy.');
    }
  };

  return (
    <div id="top" className="relative isolate min-h-dvh flex flex-col">
      <AmbientBackdrop />

      <a href="#main-content" className="skip-link visually-hidden">
        Skip to main content
      </a>

      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <Navbar
        currency={currency}
        onCurrencyChange={setCurrency}
        onThemeToggle={handleThemeToggle}
      />

      <main id="main-content" className="flex-1">
        {/* Centered Hero + Translucent Frosted Glass Workbench */}
        <section id="workbench" className="pt-5 pb-14 sm:pt-8 sm:pb-20 overflow-x-clip">
          <div className="max-w-[74rem] mx-auto px-4 sm:px-8">
            <div className="hero-lead max-w-3xl mx-auto text-center">
              <h1
                tabIndex={-1}
                className="text-[1.85rem] sm:text-[2.95rem] font-extrabold tracking-[-0.035em] leading-[1.06] text-ink"
              >
                Know what every AI turn{' '}
                <span className="relative inline-block whitespace-nowrap">
                  <span className="relative z-10 text-brand">actually costs</span>
                  <svg
                    viewBox="0 0 220 12"
                    fill="none"
                    aria-hidden="true"
                    className="pointer-events-none absolute -bottom-1 left-0 w-full h-2.5"
                    preserveAspectRatio="none"
                  >
                    <path
                      d="M3 8.5C58 2.5 148 2 217 7.5"
                      stroke="var(--accent-flame)"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      className="hero-brush-path"
                    />
                  </svg>
                </span>
                .
              </h1>

              <p className="mt-3 text-[13.5px] sm:text-[15.5px] text-muted leading-relaxed max-w-[58ch] mx-auto">
                Real-time local telemetry for <span className="text-ink font-semibold">Antigravity</span>,{' '}
                <span className="text-ink font-semibold">Claude Code</span>, and{' '}
                <span className="text-ink font-semibold">Codex CLI</span> — net API spend, cache savings, subagents, and{' '}
                <code className="font-mono text-xs sm:text-[13px] text-flame font-semibold">/btw</code> side-chats straight from disk.
              </p>

              {/* Translucent glass command bar */}
              <div className="mt-4 sm:mt-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2.5">
                <div className="glass-panel inline-flex items-center justify-between gap-2 rounded-xl p-1.5 max-w-full">
                  <div
                    role="group"
                    aria-label="Install method"
                    className="hidden sm:inline-flex items-center rounded-lg bg-elevated p-0.5 font-mono text-[11px] shrink-0"
                  >
                    {INSTALL_COMMANDS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={installMode === item.id}
                        onClick={() => setInstallMode(item.id)}
                        className={`min-h-[26px] px-2 rounded-md transition-colors cursor-pointer ${
                          installMode === item.id
                            ? 'bg-surface text-ink font-semibold shadow-sm'
                            : 'text-muted hover:text-ink'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>

                  <code className="font-mono text-xs sm:text-[13px] text-ink px-2 overflow-x-auto whitespace-nowrap">
                    <span className="text-flame font-semibold select-none mr-1.5">$</span>
                    {currentInstall.cmd}
                  </code>

                  <button
                    id="hero-copy-btn"
                    type="button"
                    onClick={() => void handleCopy(currentInstall.cmd, 'hero')}
                    aria-label={`Copy ${currentInstall.cmd}`}
                    className="btn-primary-brand inline-flex items-center gap-1.5 min-h-[32px] px-3 rounded-lg font-semibold text-xs transition-colors shrink-0 cursor-pointer"
                  >
                    {heroCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>

                <a
                  href="https://github.com/Cise07/ai-burnrate-tool"
                  target="_blank"
                  rel="noreferrer"
                  className="glass-control hidden sm:inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 rounded-xl hover:border-hairlineStrong text-xs font-semibold text-ink transition-colors shrink-0"
                >
                  <span>GitHub</span>
                  <ArrowUpRight className="w-3.5 h-3.5 text-brand" aria-hidden="true" />
                </a>
              </div>

              <div className="hidden sm:flex mt-3.5 items-center justify-center flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-cyanTool" aria-hidden="true" />
                  Antigravity <span className="text-subtle">~/.gemini</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-claudeTool" aria-hidden="true" />
                  Claude Code <span className="text-subtle">~/.claude</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-codexTool" aria-hidden="true" />
                  Codex CLI <span className="text-subtle">~/.codex</span>
                </span>
                <span className="text-subtle">· Zero cloud uploads · MIT</span>
              </div>
            </div>

            <div className="mt-5 sm:mt-7">
              <HeroSandbox currency={currency} resolvedScheme={resolvedScheme} />
            </div>
          </div>
        </section>

        <ArchitectureFlow onAnnounce={announce} />

        <HeatmapShowcase currency={currency} />

        <PricingAndCliTables currency={currency} onAnnounce={announce} />

        <FaqAccordion />
      </main>

      <footer className="border-t border-hairline py-8">
        <div className="max-w-[74rem] mx-auto px-4 sm:px-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs text-muted">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex items-center gap-2 font-mono font-semibold text-ink">
              <img src="./logo.svg" alt="" width={18} height={18} className="w-4 h-4 rounded border border-hairline" />
              <span>ai-burnrate-tool</span>
            </span>
            <span className="text-subtle">MIT License · Cise07</span>
            <button
              type="button"
              onClick={() => void handleCopy('npm install -g ai-burnrate-tool', 'footer')}
              aria-label="Copy global install command"
              className="glass-control inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:border-hairlineStrong font-mono text-[11px] text-ink transition-colors cursor-pointer"
            >
              <span>
                <span className="text-flame mr-1">$</span>npm i -g ai-burnrate-tool
              </span>
              {footerCopied ? (
                <Check className="w-3 h-3 text-brand" aria-hidden="true" />
              ) : (
                <Copy className="w-3 h-3 text-subtle" aria-hidden="true" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-5 font-mono text-[11.5px]">
            <a
              href="https://github.com/Cise07/ai-burnrate-tool"
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-brand transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/ai-burnrate-tool"
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-brand transition-colors"
            >
              npm
            </a>
            <a
              href="https://github.com/Cise07/ai-burnrate-tool/releases"
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-brand transition-colors"
            >
              Releases
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
