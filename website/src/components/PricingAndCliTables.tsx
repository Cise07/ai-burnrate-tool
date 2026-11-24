import { useDeferredValue, useState } from 'react';
import { Check, Copy, Search } from 'lucide-react';
import {
  CLI_FLAGS,
  PRICING_CATALOG,
  formatRateMoney,
  type Currency,
} from '../data/siteData';
import { useToolVersion } from '../hooks/useToolVersion';

interface PricingAndCliTablesProps {
  currency: Currency;
  onAnnounce: (msg: string) => void;
}

type ProviderFilter = 'all' | 'anthropic' | 'google' | 'openai';
type FlagFilter = 'all' | 'dashboard' | 'reset' | 'hooks';

export function PricingAndCliTables({ currency, onAnnounce }: PricingAndCliTablesProps) {
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [flagFilter, setFlagFilter] = useState<FlagFilter>('all');
  const [flagQuery, setFlagQuery] = useState<string>('');
  const [copiedFlag, setCopiedFlag] = useState<string | null>(null);
  const toolVersion = useToolVersion();

  const visibleModels = PRICING_CATALOG.filter(
    (m) => providerFilter === 'all' || m.provider === providerFilter
  );

  const deferredQuery = useDeferredValue(flagQuery);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const visibleFlags = CLI_FLAGS.filter((f) => {
    const matchesCategory = flagFilter === 'all' || f.category === flagFilter;
    const matchesQuery =
      !normalizedQuery ||
      f.flag.toLowerCase().includes(normalizedQuery) ||
      f.summary.toLowerCase().includes(normalizedQuery) ||
      f.categoryLabel.toLowerCase().includes(normalizedQuery);
    return matchesCategory && matchesQuery;
  });

  const copyFlag = async (flag: string) => {
    const clean = flag.split(' / ')[0];
    try {
      await navigator.clipboard.writeText(clean);
      setCopiedFlag(flag);
      onAnnounce(`Copied ${clean} to clipboard`);
      setTimeout(() => setCopiedFlag((prev) => (prev === flag ? null : prev)), 1600);
    } catch {
      onAnnounce('Could not copy automatically.');
    }
  };

  return (
    <>
      {/* Pricing Engine & Long-Context Tiers */}
      <section id="pricing" className="py-16 sm:py-20 border-t border-hairline">
        <div className="max-w-[74rem] mx-auto px-4 sm:px-8">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-5 mb-7">
            <div className="scroll-arrive max-w-xl">
              <h2 className="text-2xl sm:text-[2rem] font-bold tracking-[-0.03em] text-ink">
                Time-versioned pricing and long-context tiers
              </h2>
              <p className="mt-2 text-sm text-muted leading-relaxed">
                Rates sync every 30 minutes via LiteLLM <code className="font-mono text-xs text-ink font-semibold">ETag</code> checks without rewriting past turns. Tiered pricing applies per request when prompt context crosses model thresholds.
              </p>
            </div>

            <div
              role="group"
              aria-label="Filter models by provider"
              className="glass-control inline-flex flex-wrap items-center rounded-lg p-0.5 gap-0.5"
            >
              {(
                [
                  { id: 'all', label: 'All providers' },
                  { id: 'anthropic', label: 'Anthropic', dot: 'bg-claudeTool' },
                  { id: 'google', label: 'Google AI', dot: 'bg-cyanTool' },
                  { id: 'openai', label: 'OpenAI', dot: 'bg-codexTool' },
                ] as Array<{ id: ProviderFilter; label: string; dot?: string }>
              ).map((p, idx) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={providerFilter === p.id}
                  onClick={() => setProviderFilter(p.id)}
                  style={{ '--tab-i': idx } as React.CSSProperties}
                  className={`scroll-tab-item inline-flex items-center gap-1.5 min-h-[32px] px-2.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    providerFilter === p.id
                      ? 'bg-surface text-ink font-semibold shadow-sm'
                      : 'text-muted hover:text-ink'
                  }`}
                >
                  {p.dot && <span className={`h-1.5 w-1.5 rounded-full ${p.dot}`} aria-hidden="true" />}
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div
            tabIndex={0}
            role="region"
            aria-labelledby="pricing-table-caption"
            className="scroll-arrive table-wrapper"
          >
            <table className="burn-table">
              <caption id="pricing-table-caption">
                Baseline net tariffs per 1M tokens ({currency}) · config/pricing.json · auto-refreshed via LiteLLM ETag ledger
              </caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Provider</th>
                  <th scope="col" className="text-right">Input / 1M</th>
                  <th scope="col" className="text-right">Cache Read / 1M</th>
                  <th scope="col" className="text-right">Output / 1M</th>
                  <th scope="col">Long-context tier</th>
                </tr>
              </thead>
              <tbody>
                {visibleModels.map((m) => (
                  <tr key={m.id}>
                    <th scope="row">
                      <div className="font-mono text-xs text-ink">{m.label}</div>
                      <div className="text-[11.5px] font-normal text-subtle mt-0.5">{m.note}</div>
                    </th>
                    <td data-label="Provider" className="font-mono text-xs font-semibold">
                      <span
                        className={
                          m.provider === 'anthropic'
                            ? 'text-claudeTool'
                            : m.provider === 'google'
                              ? 'text-cyanTool'
                              : 'text-codexTool'
                        }
                      >
                        {m.providerLabel}
                      </span>
                    </td>
                    <td data-label="Input / 1M" className="font-mono text-xs text-ink sm:text-right tabular">
                      {formatRateMoney(m.input, currency)}
                    </td>
                    <td data-label="Cache Read / 1M" className="font-mono text-xs text-brand font-semibold sm:text-right tabular">
                      {formatRateMoney(m.cacheRead, currency)}
                    </td>
                    <td data-label="Output / 1M" className="font-mono text-xs text-ink font-medium sm:text-right tabular">
                      {formatRateMoney(m.output, currency)}
                    </td>
                    <td data-label="Long-context tier" className="font-mono text-xs">
                      <span
                        className={
                          m.longContextLabel === 'Flat rate'
                            ? 'text-subtle'
                            : 'text-flame font-semibold'
                        }
                      >
                        {m.longContextLabel}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Searchable CLI Reference */}
      <section id="reference" className="py-16 sm:py-20 border-t border-hairline">
        <div className="max-w-[74rem] mx-auto px-4 sm:px-8">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5 mb-7">
            <div className="scroll-arrive max-w-xl">
              <h2 className="text-2xl sm:text-[2rem] font-bold tracking-[-0.03em] text-ink">
                CLI command explorer
              </h2>
              <p className="mt-2 text-sm text-muted leading-relaxed">
                Run <code className="font-mono text-xs text-brand font-semibold">burn</code> globally from any folder. Filter or search all {CLI_FLAGS.length} flags and copy directly.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <label className="relative flex items-center">
                <span className="visually-hidden">Filter CLI commands</span>
                <Search
                  className="w-3.5 h-3.5 text-subtle absolute left-3 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={flagQuery}
                  onChange={(e) => setFlagQuery(e.target.value)}
                  placeholder="Search flags..."
                  className="glass-control w-full sm:w-48 min-h-[36px] pl-8 pr-3 rounded-lg text-xs font-mono text-ink placeholder:text-subtle"
                />
              </label>

              <div
                role="group"
                aria-label="Filter CLI commands by category"
                className="glass-control inline-flex flex-wrap items-center rounded-lg p-0.5 gap-0.5"
              >
                {(
                  [
                    { id: 'all', label: `All (${CLI_FLAGS.length})` },
                    { id: 'dashboard', label: 'Dashboard' },
                    { id: 'reset', label: 'Reset & Backup' },
                    { id: 'hooks', label: 'Hooks' },
                  ] as Array<{ id: FlagFilter; label: string }>
                ).map((c, idx) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={flagFilter === c.id}
                    onClick={() => setFlagFilter(c.id)}
                    style={{ '--tab-i': idx } as React.CSSProperties}
                    className={`scroll-tab-item min-h-[32px] px-2.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                      flagFilter === c.id
                        ? 'bg-surface text-ink font-semibold shadow-sm'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div
            tabIndex={0}
            role="region"
            aria-labelledby="cli-table-caption"
            className="scroll-arrive table-wrapper"
          >
            <table className="burn-table">
              <caption id="cli-table-caption">
                Showing {visibleFlags.length} of {CLI_FLAGS.length} flags for ai-burnrate-tool {toolVersion}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Command</th>
                  <th scope="col">Category</th>
                  <th scope="col">Behavior</th>
                  <th scope="col" className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleFlags.length > 0 ? (
                  visibleFlags.map((row) => (
                    <tr key={row.flag}>
                      <th scope="row">
                        <code className="font-mono text-xs text-brand font-semibold whitespace-nowrap">
                          {row.flag}
                        </code>
                      </th>
                      <td data-label="Category" className="font-mono text-[11.5px] text-subtle whitespace-nowrap">
                        {row.categoryLabel}
                      </td>
                      <td data-label="Behavior" className="text-[13.5px] text-muted leading-relaxed">
                        {row.summary}
                      </td>
                      <td data-label="Action" className="sm:text-right">
                        <button
                          type="button"
                          onClick={() => void copyFlag(row.flag)}
                          aria-label={`Copy command ${row.flag}`}
                          className="glass-control inline-flex items-center gap-1.5 min-h-[30px] px-2.5 rounded-md hover:border-hairlineStrong font-mono text-[11px] text-ink cursor-pointer"
                        >
                          {copiedFlag === row.flag ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-brand" aria-hidden="true" />
                              <span className="text-brand font-semibold">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5 text-subtle" aria-hidden="true" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="text-center text-sm text-muted py-8">
                      No CLI flags match “{flagQuery}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
