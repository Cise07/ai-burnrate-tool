import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  GripVertical,
  LayoutGrid,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  convertSubscriptionMoney,
  formatSubscriptionMoney,
  getSubscriptionMultiplier,
  getTaxLabel,
  type Currency,
} from '../../core/analytics';
import type { DashboardSectionId, HooksStatus, UserSettings } from '../../core/types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  hooksStatus?: HooksStatus;
  currency: Currency;
  onSave: (next: UserSettings) => Promise<void>;
}

const DEFAULT_ORDER: DashboardSectionId[] = [
  'kpis',
  'charts',
  'modelUsage',
  'heatmapWorkspaces',
  'sessions',
];

const SECTION_META: Record<DashboardSectionId, { title: string; subtitle: string }> = {
  kpis: {
    title: 'KPI Summary Cards',
    subtitle: 'API spend, tokens, cache savings & sessions',
  },
  charts: {
    title: 'Daily Burn Rate & Cost by Model',
    subtitle: 'Daily tool curves and per-model cost bars',
  },
  modelUsage: {
    title: 'Total Token Usage by Model',
    subtitle: 'Detailed token breakdown & 1M token rates',
  },
  heatmapWorkspaces: {
    title: 'Activity Heatmap & Top Workspaces',
    subtitle: '13-week burn calendar & top spending projects',
  },
  sessions: {
    title: 'Live Sessions & Workspaces',
    subtitle: 'Expandable workspace & chat telemetry table',
  },
};

const PLAN_PRESETS: Array<{
  key: keyof UserSettings['subscriptions'];
  label: string;
  accent: string;
  presets: Array<{ label: string; usdNet: number; eurRetail?: number }>;
}> = [
  {
    key: 'antigravity',
    label: 'Antigravity (Google AI)',
    accent: 'text-cyan-300',
    presets: [
      { label: 'Free', usdNet: 0, eurRetail: 0 },
      { label: 'Pro', usdNet: 19.99, eurRetail: 21.99 },
      { label: 'Ultra 5x', usdNet: 99.99, eurRetail: 99.99 },
      { label: 'Ultra 20x', usdNet: 199.99, eurRetail: 219.99 },
    ],
  },
  {
    key: 'claude',
    label: 'Claude Code',
    accent: 'text-fuchsia-300',
    presets: [
      { label: 'API/Free', usdNet: 0 },
      { label: 'Pro', usdNet: 20 },
      { label: 'Max 5x', usdNet: 100 },
      { label: 'Max 20x', usdNet: 200 },
    ],
  },
  {
    key: 'codex',
    label: 'Codex CLI (ChatGPT)',
    accent: 'text-amber-300',
    presets: [
      { label: 'API/Free', usdNet: 0, eurRetail: 0 },
      { label: 'Plus', usdNet: 20, eurRetail: 22.99 },
      { label: 'Pro 100', usdNet: 100, eurRetail: 109.99 },
      { label: 'Pro 200', usdNet: 200, eurRetail: 229 },
    ],
  },
];

function toDisplayAmount(usd: number, currency: Currency): number {
  return Number(convertSubscriptionMoney(usd, currency).toFixed(2));
}

function fromDisplayAmount(displayVal: number, currency: Currency): number {
  if (!Number.isFinite(displayVal) || displayVal <= 0) return 0;
  const usd = displayVal / getSubscriptionMultiplier(currency);
  return Number(usd.toFixed(4));
}

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  hooksStatus,
  currency,
  onSave,
}: SettingsModalProps) {
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState<UserSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [draggedId, setDraggedId] = useState<DashboardSectionId | null>(null);
  const [dragOverId, setDragOverId] = useState<DashboardSectionId | null>(null);

  useEffect(() => {
    if (isOpen) {
      setDraft(settings);
      setRendered(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    setVisible(false);
    setDraggedId(null);
    setDragOverId(null);
    const timer = setTimeout(() => setRendered(false), 220);
    return () => clearTimeout(timer);
  }, [isOpen, settings]);

  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, onClose]);

  if (!rendered) return null;

  const currencySymbol = currency === 'EUR' ? '€' : '$';

  const setSubUSD = (key: keyof UserSettings['subscriptions'], usd: number) => {
    setDraft((prev) => ({
      ...prev,
      subscriptions: {
        ...prev.subscriptions,
        [key]: Number.isFinite(usd) ? Math.max(0, Number(usd.toFixed(4))) : 0,
      },
    }));
  };

  const toggleSection = (id: DashboardSectionId) => {
    setDraft((prev) => {
      const hiddenSet = new Set(prev.layout.hidden);
      if (hiddenSet.has(id)) {
        hiddenSet.delete(id);
      } else {
        hiddenSet.add(id);
      }
      return {
        ...prev,
        layout: {
          ...prev.layout,
          hidden: Array.from(hiddenSet),
        },
      };
    });
  };

  const moveSection = (index: number, delta: -1 | 1) => {
    setDraft((prev) => {
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= prev.layout.order.length) return prev;
      const nextOrder = [...prev.layout.order];
      const [moved] = nextOrder.splice(index, 1);
      nextOrder.splice(targetIndex, 0, moved);
      return {
        ...prev,
        layout: {
          ...prev.layout,
          order: nextOrder,
        },
      };
    });
  };

  const reorderByDrop = (fromId: DashboardSectionId, toId: DashboardSectionId) => {
    if (fromId === toId) return;
    setDraft((prev) => {
      const fromIdx = prev.layout.order.indexOf(fromId);
      const toIdx = prev.layout.order.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const nextOrder = [...prev.layout.order];
      const [moved] = nextOrder.splice(fromIdx, 1);
      nextOrder.splice(toIdx, 0, moved);
      return {
        ...prev,
        layout: {
          ...prev.layout,
          order: nextOrder,
        },
      };
    });
  };

  const resetLayout = () => {
    setDraft((prev) => ({
      ...prev,
      layout: {
        order: [...DEFAULT_ORDER],
        hidden: [],
      },
    }));
  };

  const isLayoutCustomized =
    draft.layout.hidden.length > 0 ||
    draft.layout.order.some((id, idx) => id !== DEFAULT_ORDER[idx]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const totalSubUSD =
    draft.subscriptions.antigravity + draft.subscriptions.claude + draft.subscriptions.codex;

  return (
    <div
      className={`fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-2 sm:p-4 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Plans, Layout & Settings"
    >
      <div
        className={`w-full max-w-xl max-h-[92dvh] sm:max-h-[86vh] min-h-0 flex flex-col rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none ${
          visible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-3 scale-[0.985]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-zinc-800/90 flex items-start justify-between gap-3 bg-zinc-950/60 shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 mt-0.5 shrink-0">
              <SlidersHorizontal className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-100">Plans, Layout & Settings</h3>
              <p className="text-xs text-zinc-400 mt-0.5">
                Customize your monthly plans ({currency}), reorder or hide sections & manage archive sync.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="group p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4 transition-transform duration-200 group-hover:rotate-90" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5 space-y-5">
          {/* Subscriptions (synced with active currency) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-mono uppercase tracking-wider text-zinc-400">
                Monthly Subscription Plans ({currency} · incl. {getTaxLabel(currency)})
              </h4>
              <span className="text-xs font-mono text-emerald-400 font-semibold">
                Total: {formatSubscriptionMoney(totalSubUSD, currency)}/mo
              </span>
            </div>
            <div className="space-y-2.5">
              {PLAN_PRESETS.map((tool) => {
                const displayVal = toDisplayAmount(draft.subscriptions[tool.key], currency);
                return (
                  <div
                    key={tool.key}
                    className="rounded-xl bg-zinc-950/70 border border-zinc-800/80 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                  >
                    <div className="space-y-1.5 min-w-0">
                      <div className={`text-xs font-semibold font-mono ${tool.accent}`}>{tool.label}</div>
                      <div className="flex flex-wrap gap-1">
                        {tool.presets.map((p) => {
                          const targetDisplay =
                            currency === 'EUR' && p.eurRetail !== undefined
                              ? p.eurRetail
                              : toDisplayAmount(p.usdNet, currency);
                          const targetUsdNet =
                            currency === 'EUR' && p.eurRetail !== undefined
                              ? fromDisplayAmount(p.eurRetail, 'EUR')
                              : p.usdNet;
                          const active = Math.abs(displayVal - targetDisplay) < 0.15;
                          const presetTag =
                            targetDisplay === 0
                              ? p.label
                              : `${p.label} ${currencySymbol}${targetDisplay.toFixed(2)}`;
                          return (
                            <button
                              key={p.label}
                              type="button"
                              onClick={() => setSubUSD(tool.key, targetUsdNet)}
                              className={`px-2 py-0.5 rounded-md text-[10px] font-mono border transition-colors cursor-pointer ${
                                active
                                  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200'
                                  : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                              }`}
                            >
                              {presetTag}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs font-mono text-zinc-500">{currencySymbol}</span>
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        step={0.5}
                        value={displayVal}
                        onChange={(e) =>
                          setSubUSD(tool.key, fromDisplayAmount(Number(e.target.value), currency))
                        }
                        aria-label={`${tool.label} monthly subscription (${currency})`}
                        className="w-24 h-8 px-2.5 rounded-lg bg-zinc-900 border border-zinc-800 focus:border-emerald-500/50 focus:outline-none text-xs font-mono text-zinc-100 text-right"
                      />
                      <span className="text-[11px] font-mono text-zinc-500">/mo</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Dashboard Sections: Reorder & Toggle */}
          <div className="space-y-2.5 pt-2 border-t border-zinc-800/80">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-mono uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <LayoutGrid className="w-3.5 h-3.5 text-cyan-400" />
                Dashboard Sections (Drag or Toggle)
              </h4>
              {isLayoutCustomized && (
                <button
                  type="button"
                  onClick={resetLayout}
                  className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-400 hover:text-emerald-300 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset layout
                </button>
              )}
            </div>

            <div className="space-y-1.5">
              {draft.layout.order.map((sectionId, idx) => {
                const meta = SECTION_META[sectionId];
                const isHidden = draft.layout.hidden.includes(sectionId);
                const isDragOver = dragOverId === sectionId && draggedId !== sectionId;

                return (
                  <div
                    key={sectionId}
                    draggable
                    onDragStart={(e) => {
                      setDraggedId(sectionId);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', sectionId);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (draggedId && draggedId !== sectionId) setDragOverId(sectionId);
                    }}
                    onDragLeave={() => {
                      if (dragOverId === sectionId) setDragOverId(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const src = (e.dataTransfer.getData('text/plain') as DashboardSectionId) || draggedId;
                      if (src) reorderByDrop(src, sectionId);
                      setDraggedId(null);
                      setDragOverId(null);
                    }}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setDragOverId(null);
                    }}
                    className={`rounded-xl border px-2.5 py-2 flex items-center justify-between gap-2 transition-all duration-150 select-none ${
                      isDragOver
                        ? 'border-emerald-500/70 bg-emerald-500/10'
                        : isHidden
                          ? 'bg-zinc-950/40 border-zinc-800/60 opacity-65'
                          : 'bg-zinc-950/75 border-zinc-800/80 hover:border-zinc-700/80'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing shrink-0"
                        title="Drag to reorder"
                      >
                        <GripVertical className="w-4 h-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-zinc-100 truncate">{meta.title}</div>
                        <div className="text-[10.5px] text-zinc-500 truncate">{meta.subtitle}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => moveSection(idx, -1)}
                        aria-label={`Move ${meta.title} up`}
                        title="Move up"
                        className="h-7 w-7 rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === draft.layout.order.length - 1}
                        onClick={() => moveSection(idx, 1)}
                        aria-label={`Move ${meta.title} down`}
                        title="Move down"
                        className="h-7 w-7 rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleSection(sectionId)}
                        aria-pressed={!isHidden}
                        aria-label={isHidden ? `Show ${meta.title}` : `Hide ${meta.title}`}
                        title={isHidden ? 'Show section' : 'Hide section'}
                        className={`h-7 px-2 rounded-md border text-[11px] font-mono flex items-center gap-1 transition-colors cursor-pointer ${
                          isHidden
                            ? 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                            : 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/25'
                        }`}
                      >
                        {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        <span className="hidden sm:inline">{isHidden ? 'Hidden' : 'Visible'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Totals & Deleted Inclusion */}
          <div className="space-y-2.5 pt-2 border-t border-zinc-800/80">
            <button
              type="button"
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  includeDeletedInTotals: !prev.includeDeletedInTotals,
                }))
              }
              aria-pressed={draft.includeDeletedInTotals}
              className={`w-full rounded-xl border p-3 text-left flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                draft.includeDeletedInTotals
                  ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-200'
                  : 'bg-zinc-950/70 border-zinc-800/80 text-zinc-400 hover:border-zinc-700'
              }`}
            >
              <div>
                <div className="text-xs font-mono font-semibold">Include Deleted Chats in Totals & CSV</div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  Keep API spend accurate even after deleting chats from your AI tools.
                </div>
              </div>
              <span className="text-xs font-semibold font-mono shrink-0">
                {draft.includeDeletedInTotals ? 'ON' : 'OFF'}
              </span>
            </button>
          </div>

          {/* Auto-Archive Offline Hooks Status */}
          <div className="rounded-xl bg-zinc-950/70 border border-zinc-800/80 p-3.5 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Offline Auto-Archive Hooks</span>
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              Automatically snapshots each completed turn into <span className="font-mono text-zinc-300">~/.burnrate/sessions-ledger.json</span> even when <span className="font-mono text-zinc-300">burn</span> is closed, preserving exact spend and models if you later delete a chat or dismiss a <span className="font-mono text-zinc-300">/btw</span> side-chat.
            </p>
            <div className="flex flex-wrap gap-2 pt-0.5">
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono border ${
                  hooksStatus?.antigravity
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-500'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${hooksStatus?.antigravity ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                Antigravity: {hooksStatus?.antigravity ? 'Active' : 'Inactive'}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono border ${
                  hooksStatus?.claude
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-500'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${hooksStatus?.claude ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                Claude Code: {hooksStatus?.claude ? 'Active' : 'Inactive'}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono border ${
                  hooksStatus?.codex
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-500'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${hooksStatus?.codex ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                Codex CLI: {hooksStatus?.codex ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-5 py-3 border-t border-zinc-800/90 bg-zinc-950/60 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-xs font-mono text-zinc-300 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="h-8 px-3.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold text-xs font-mono flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving...' : 'Save Settings'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
