import { FAQ_ITEMS } from '../data/siteData';

export function FaqAccordion() {
  return (
    <section id="faq" className="py-16 sm:py-20 border-t border-hairline">
      <div className="max-w-[74rem] mx-auto px-4 sm:px-8 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
        <div className="lg:col-span-4 lg:sticky lg:top-24">
          <div className="scroll-arrive space-y-5">
            <div>
              <h2 id="faq-heading" className="text-2xl sm:text-[2rem] font-bold tracking-[-0.03em] text-ink">
                Questions
              </h2>
              <p className="mt-2.5 text-sm text-muted leading-relaxed">
                How local archiving, per-turn resets, backups, LAN PIN security, and tax-adjusted plan comparisons behave in practice.
              </p>
            </div>

            <dl className="glass-panel rounded-xl p-4 space-y-2.5 font-mono text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-subtle">Runtime</dt>
                <dd className="text-ink font-semibold">Node.js &gt;= 18</dd>
              </div>
              <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline">
                <dt className="text-subtle">Local archive</dt>
                <dd className="text-brand font-semibold">~/.burnrate</dd>
              </div>
              <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline">
                <dt className="text-subtle">Cloud telemetry</dt>
                <dd className="text-ink font-semibold">None (0 bytes)</dd>
              </div>
              <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline">
                <dt className="text-subtle">License</dt>
                <dd className="text-ink font-semibold">MIT · Open source</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="burn-accordion glass-sheen glass-panel rounded-2xl px-5 sm:px-6 lg:col-span-8">
          {FAQ_ITEMS.map((item, idx) => (
            <details
              key={item.q}
              style={{ '--row-i': idx } as React.CSSProperties}
              className="scroll-faq-item"
            >
              <summary>{item.q}</summary>
              <div className="pb-5 pr-6 text-sm text-muted leading-relaxed max-w-[68ch]">
                {item.a}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
