import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  Download,
  Eye,
  EyeOff,
  GripVertical,
  HardDrive,
  LayoutGrid,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import {
  SUBSCRIPTION_PLAN_PRESETS,
  canonicalizeToolSubscriptionUsd,
  formatDisplayCurrencyAmount,
  getPresetDisplayAmount,
  getSubscriptionMultiplier,
  getTaxLabel,
  getToolSubscriptionDisplayAmount,
  getTotalSubscriptionDisplayAmount,
  matchSubscriptionPreset,
  type Currency,
  type SubscriptionPlanPreset,
} from '../../core/analytics';
import type {
  BurnrateSnapshot,
  DashboardSectionId,
  HooksStatus,
  ToolSource,
  ToolTrackingStartSettings,
  UserSettings,
} from '../../core/types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  hooksStatus?: HooksStatus;
  currency: Currency;
  onSave: (next: UserSettings) => Promise<void>;
  onSnapshotUpdated?: (snapshot: BurnrateSnapshot) => void;
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
    subtitle: 'API spend, tokens, cache savings & quota / sessions',
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
  accentColor: string;
  presets: ReadonlyArray<SubscriptionPlanPreset>;
}> = [
  {
    key: 'antigravity',
    label: 'Antigravity (Google AI)',
    accentColor: 'var(--tool-antigravity)',
    presets: SUBSCRIPTION_PLAN_PRESETS.antigravity,
  },
  {
    key: 'claude',
    label: 'Claude Code',
    accentColor: 'var(--tool-claude)',
    presets: SUBSCRIPTION_PLAN_PRESETS.claude,
  },
  {
    key: 'codex',
    label: 'Codex CLI (ChatGPT)',
    accentColor: 'var(--tool-codex)',
    presets: SUBSCRIPTION_PLAN_PRESETS.codex,
  },
];

const EMPTY_TRACKING_START: ToolTrackingStartSettings = {
  antigravity: null,
  claude: null,
  codex: null,
};

function normalizeDraftSettings(raw: UserSettings): UserSettings {
  return {
    ...raw,
    experimentalQuota: raw.experimentalQuota ?? true,
    subscriptions: {
      antigravity: canonicalizeToolSubscriptionUsd('antigravity', raw.subscriptions.antigravity),
      claude: canonicalizeToolSubscriptionUsd('claude', raw.subscriptions.claude),
      codex: canonicalizeToolSubscriptionUsd('codex', raw.subscriptions.codex),
    },
    trackingStartAt: {
      ...EMPTY_TRACKING_START,
      ...(raw.trackingStartAt || {}),
    },
  };
}

function isoToLocalDateTimeInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function localDateTimeInputToIso(val: string): string | null {
  const trimmed = val.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatCutoffBadge(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type QuickStartPreset = 'today' | '7d' | '30d' | 'month';

function getQuickStartIso(preset: QuickStartPreset): string {
  const now = new Date();
  if (preset === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
  }
  if (preset === '7d') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 0, 0, 0, 0).toISOString();
  }
  if (preset === '30d') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30, 0, 0, 0, 0).toISOString();
  }
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString();
}

const QUICK_START_PRESETS: Array<{ id: QuickStartPreset; label: string }> = [
  { id: 'today', label: 'Today 00:00' },
  { id: '7d', label: '-7d' },
  { id: '30d', label: '-30d' },
  { id: 'month', label: 'Month start' },
];

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
  onSnapshotUpdated,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [draft, setDraft] = useState<UserSettings>(() => normalizeDraftSettings(settings));
  const [saving, setSaving] = useState(false);
  const [draggedId, setDraggedId] = useState<DashboardSectionId | null>(null);
  const [dragOverId, setDragOverId] = useState<DashboardSectionId | null>(null);
  const [backupImportMode, setBackupImportMode] = useState<'merge' | 'replace'>('merge');
  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | null>(null);
  const [backupStatus, setBackupStatus] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      setDraft(normalizeDraftSettings(settings));
      setBackupStatus(null);
      setBackupBusy(null);
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
      setDraggedId(null);
      setDragOverId(null);
    }
  }, [isOpen, settings]);

  /* Sync native close (Esc, back gesture, closedby="any") back to React state + Safari fallback */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      setDraggedId(null);
      setDragOverId(null);
      onClose();
    };
    dialog.addEventListener('close', handleClose);

    if ('closedBy' in HTMLDialogElement.prototype) {
      return () => dialog.removeEventListener('close', handleClose);
    }

    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) dialog.close();
      pressedOutside = false;
    };

    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);
    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, [onClose]);

  const currencySymbol = currency === 'EUR' ? '€' : '$';

  const setSubUSD = (key: keyof UserSettings['subscriptions'], usd: number) => {
    const cleaned = Number.isFinite(usd) ? Math.max(0, Number(usd.toFixed(4))) : 0;
    const canonical = canonicalizeToolSubscriptionUsd(key, cleaned);
    setDraft((prev) => ({
      ...prev,
      subscriptions: {
        ...prev.subscriptions,
        [key]: canonical,
      },
    }));
  };

  const setToolTrackingStart = (tool: ToolSource, iso: string | null) => {
    setDraft((prev) => ({
      ...prev,
      trackingStartAt: {
        ...prev.trackingStartAt,
        [tool]: iso,
      },
    }));
  };

  const resetAllTrackingCutoffs = () => {
    setDraft((prev) => ({
      ...prev,
      trackingStartAt: { ...EMPTY_TRACKING_START },
    }));
  };

  const hasAnyTrackingCutoff = Boolean(
    draft.trackingStartAt.antigravity || draft.trackingStartAt.claude || draft.trackingStartAt.codex
  );

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
      dialogRef.current?.close();
    } finally {
      setSaving(false);
    }
  };

  const handleExportBackup = async () => {
    setBackupBusy('export');
    setBackupStatus(null);
    try {
      const res = await fetch('/api/backup/export');
      if (!res.ok) {
        throw new Error('Failed to generate backup file');
      }
      const blob = await res.blob();
      const dateStamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `burnrate-backup-${dateStamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBackupStatus({
        tone: 'ok',
        text: `Downloaded burnrate-backup-${dateStamp}.json (${(blob.size / 1024).toFixed(1)} KB)`,
      });
    } catch (err) {
      setBackupStatus({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Export failed',
      });
    } finally {
      setBackupBusy(null);
    }
  };

  const handleImportBackupFile = async (file: File | undefined) => {
    if (!file) return;
    setBackupBusy('import');
    setBackupStatus(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('Selected file is not valid JSON.');
      }
      const res = await fetch('/api/backup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Burnrate-Client': '1' },
        body: JSON.stringify({ mode: backupImportMode, backup: parsed }),
      });
      const data = (await res.json()) as {
        error?: string;
        result?: {
          mode: 'merge' | 'replace';
          importedSessions: number;
          mergedSessions: number;
          pricingSnapshotsAdded: number;
        };
        snapshot?: BurnrateSnapshot;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Import failed');
      }
      if (data.snapshot) {
        onSnapshotUpdated?.(data.snapshot);
      }
      const r = data.result;
      setBackupStatus({
        tone: 'ok',
        text: r
          ? `Restored (${r.mode}): +${r.importedSessions} sessions, ${r.mergedSessions} merged, +${r.pricingSnapshotsAdded} pricing snapshots.`
          : 'Backup imported successfully.',
      });
    } catch (err) {
      setBackupStatus({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Import failed',
      });
    } finally {
      setBackupBusy(null);
      if (backupInputRef.current) backupInputRef.current.value = '';
    }
  };

  const totalSubDisplay = getTotalSubscriptionDisplayAmount(draft.subscriptions, 'all', currency);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="settings-modal-title"
      className="dash-dialog w-[min(calc(100vw-1rem),38rem)]"
    >
      {/* Header */}
      <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-[var(--border-hairline)] flex items-start justify-between gap-3 bg-[var(--bg-modal-band)] shrink-0">
        <div className="flex items-start gap-3 min-w-0">
          <div className="p-2 rounded-xl bg-[var(--accent-teal-soft)] border border-[var(--accent-teal-border)] text-[var(--accent-teal)] mt-0.5 shrink-0">
            <SlidersHorizontal className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h1 id="settings-modal-title" className="text-sm font-semibold text-[var(--ink-primary)]">
              Plans, Layout &amp; Settings
            </h1>
            <p className="text-xs text-[var(--ink-tertiary)] mt-0.5">
              Customize monthly plans ({currency}), reorder or hide sections &amp; manage archive sync.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close settings"
          className="group p-1.5 rounded-lg text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)] hover:bg-[var(--table-hover)] transition-colors cursor-pointer shrink-0"
        >
          <X className="w-4 h-4 transition-transform duration-200 group-hover:rotate-90" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5 space-y-5">
        {/* Subscriptions */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-mono uppercase tracking-wider text-[var(--ink-tertiary)]">
              Monthly Subscription Plans ({currency} · incl. {getTaxLabel(currency)})
            </h2>
            <span className="text-xs font-mono tabular text-[var(--accent-teal)] font-semibold">
              Total: {formatDisplayCurrencyAmount(totalSubDisplay, currency)}/mo
            </span>
          </div>
          <div className="space-y-2.5">
            {PLAN_PRESETS.map((tool) => {
              const displayVal = getToolSubscriptionDisplayAmount(
                tool.key,
                draft.subscriptions[tool.key],
                currency
              );
              const matchedPreset = matchSubscriptionPreset(tool.key, draft.subscriptions[tool.key]);
              return (
                <div
                  key={tool.key}
                  className="glass-subcard rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                >
                  <div className="space-y-1.5 min-w-0">
                    <div
                      className="text-xs font-semibold font-mono"
                      style={{ color: tool.accentColor }}
                    >
                      {tool.label}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {tool.presets.map((p) => {
                        const targetDisplay = getPresetDisplayAmount(p, currency);
                        const active = matchedPreset?.id === p.id;
                        const presetTag =
                          targetDisplay === 0
                            ? p.label
                            : `${p.label} ${currencySymbol}${targetDisplay.toFixed(2)}`;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setSubUSD(tool.key, p.usdNet)}
                            className={`px-2 py-0.5 rounded-md text-[10px] font-mono tabular border transition-colors cursor-pointer ${
                              active
                                ? 'bg-[var(--accent-teal-soft)] border-[var(--accent-teal-border)] text-[var(--accent-teal)] font-semibold'
                                : 'glass-control text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:border-[var(--border-strong)]'
                            }`}
                          >
                            {presetTag}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-xs font-mono text-[var(--ink-tertiary)]">{currencySymbol}</span>
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
                      className="glass-input w-24 h-8 px-2.5 rounded-lg text-xs font-mono tabular text-right"
                    />
                    <span className="text-[11px] font-mono text-[var(--ink-tertiary)]">/mo</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Tool Spend Reset / Tracking Start Date */}
        <div className="space-y-2.5 pt-3 border-t border-[var(--border-hairline)]">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-mono uppercase tracking-wider text-[var(--ink-tertiary)] flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[var(--accent-amber)]" />
              Tool Tracking Reset (Start Date)
            </h2>
            {hasAnyTrackingCutoff && (
              <button
                type="button"
                onClick={resetAllTrackingCutoffs}
                className="inline-flex items-center gap-1 text-[11px] font-mono text-[var(--accent-teal)] hover:underline cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Restore all from beginning
              </button>
            )}
          </div>
          <p className="text-[11px] text-[var(--ink-secondary)] leading-relaxed">
            Count turns and spend per tool starting from now or any custom date, and restore anytime from a chosen date or from the beginning. Never touches tool files.
          </p>
          <div className="space-y-2">
            {PLAN_PRESETS.map((tool) => {
              const cutoffIso = draft.trackingStartAt[tool.key];
              const isReset = Boolean(cutoffIso);
              return (
                <div
                  key={tool.key}
                  className={`rounded-xl border p-3 flex flex-col gap-2 transition-colors ${
                    isReset
                      ? 'bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)]'
                      : 'glass-subcard'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="text-xs font-semibold font-mono"
                      style={{ color: tool.accentColor }}
                    >
                      {tool.label}
                    </span>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded-md border ${
                        isReset
                          ? 'bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber)] font-semibold'
                          : 'glass-control text-[var(--ink-tertiary)]'
                      }`}
                    >
                      {isReset && cutoffIso ? `From ${formatCutoffBadge(cutoffIso)}` : 'Full history'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-mono text-[var(--ink-tertiary)] shrink-0">
                      {isReset ? 'Resume from:' : 'Start from:'}
                    </span>
                    <input
                      type="datetime-local"
                      step={1}
                      value={isoToLocalDateTimeInput(cutoffIso)}
                      onChange={(e) =>
                        setToolTrackingStart(tool.key, localDateTimeInputToIso(e.target.value))
                      }
                      aria-label={`${tool.label} tracking start date`}
                      className="glass-input flex-1 min-w-[180px] h-8 px-2.5 rounded-lg text-[11px] font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setToolTrackingStart(tool.key, new Date().toISOString())}
                      className="h-8 px-2.5 rounded-lg bg-[var(--accent-amber-soft)] hover:brightness-110 border border-[var(--accent-amber-border)] text-[11px] font-mono font-medium text-[var(--accent-amber)] transition-all cursor-pointer shrink-0"
                    >
                      Reset now
                    </button>
                    {isReset && (
                      <button
                        type="button"
                        onClick={() => setToolTrackingStart(tool.key, null)}
                        className="h-8 px-2.5 rounded-lg glass-control hover:border-[var(--border-strong)] text-[11px] font-mono text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer shrink-0 inline-flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" />
                        From beginning
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 pt-0.5">
                    <span className="text-[10px] font-mono text-[var(--ink-tertiary)] mr-1">
                      {isReset ? 'Quick resume:' : 'Quick start:'}
                    </span>
                    {QUICK_START_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setToolTrackingStart(tool.key, getQuickStartIso(preset.id))}
                        className="px-2 py-0.5 rounded-md text-[10px] font-mono glass-control hover:border-[var(--border-strong)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Dashboard Sections: Reorder & Toggle */}
        <div className="space-y-2.5 pt-3 border-t border-[var(--border-hairline)]">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-mono uppercase tracking-wider text-[var(--ink-tertiary)] flex items-center gap-1.5">
              <LayoutGrid className="w-3.5 h-3.5 text-[var(--tool-antigravity)]" />
              Dashboard Sections (Drag or Toggle)
            </h2>
            {isLayoutCustomized && (
              <button
                type="button"
                onClick={resetLayout}
                className="inline-flex items-center gap-1 text-[11px] font-mono text-[var(--accent-teal)] hover:underline cursor-pointer"
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
                      ? 'border-[var(--accent-teal)] bg-[var(--accent-teal-soft)]'
                      : isHidden
                        ? 'glass-subcard opacity-60'
                        : 'glass-subcard hover:border-[var(--border-strong)]'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)] cursor-grab active:cursor-grabbing shrink-0"
                      title="Drag to reorder"
                    >
                      <GripVertical className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[var(--ink-primary)] truncate">{meta.title}</div>
                      <div className="text-[10.5px] text-[var(--ink-tertiary)] truncate">{meta.subtitle}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => moveSection(idx, -1)}
                      aria-label={`Move ${meta.title} up`}
                      title="Move up"
                      className="h-7 w-7 rounded-md glass-control hover:border-[var(--border-strong)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === draft.layout.order.length - 1}
                      onClick={() => moveSection(idx, 1)}
                      aria-label={`Move ${meta.title} down`}
                      title="Move down"
                      className="h-7 w-7 rounded-md glass-control hover:border-[var(--border-strong)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
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
                          ? 'glass-control text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                          : 'bg-[var(--accent-teal-soft)] border-[var(--accent-teal-border)] text-[var(--accent-teal)] font-medium'
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

        {/* Totals, Deleted Inclusion & Experimental Features */}
        <div className="space-y-2.5 pt-3 border-t border-[var(--border-hairline)]">
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
                ? 'bg-[var(--accent-teal-soft)] border-[var(--accent-teal-border)] text-[var(--ink-primary)]'
                : 'glass-subcard text-[var(--ink-secondary)] hover:border-[var(--border-strong)]'
            }`}
          >
            <div>
              <div className="text-xs font-mono font-semibold text-[var(--ink-primary)]">
                Include Deleted Chats in Totals &amp; CSV
              </div>
              <div className="text-[11px] text-[var(--ink-secondary)] mt-0.5">
                Keep API spend accurate even after deleting chats from your AI tools.
              </div>
            </div>
            <span
              className={`text-xs font-semibold font-mono shrink-0 ${
                draft.includeDeletedInTotals ? 'text-[var(--accent-teal)]' : 'text-[var(--ink-tertiary)]'
              }`}
            >
              {draft.includeDeletedInTotals ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            onClick={() =>
              setDraft((prev) => ({
                ...prev,
                experimentalQuota: !(prev.experimentalQuota !== false),
              }))
            }
            aria-pressed={draft.experimentalQuota !== false}
            className={`w-full rounded-xl border p-3 text-left flex items-center justify-between gap-3 transition-colors cursor-pointer ${
              draft.experimentalQuota !== false
                ? 'bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--ink-primary)]'
                : 'glass-subcard text-[var(--ink-secondary)] hover:border-[var(--border-strong)]'
            }`}
          >
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono font-semibold text-[var(--ink-primary)]">
                  Remaining Quota Tracker
                </span>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold uppercase tracking-wider bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border border-[var(--accent-amber-border)]">
                  Experimental
                </span>
              </div>
              <div className="text-[11px] text-[var(--ink-secondary)] mt-0.5">
                Replaces the Sessions &amp; Projects KPI card with live 7d / 5h quota tracking. Turn OFF to restore the classic Sessions &amp; Projects card.
              </div>
            </div>
            <span
              className={`text-xs font-semibold font-mono shrink-0 ${
                draft.experimentalQuota !== false ? 'text-[var(--accent-amber)]' : 'text-[var(--ink-tertiary)]'
              }`}
            >
              {draft.experimentalQuota !== false ? 'ON' : 'OFF'}
            </span>
          </button>
        </div>

        {/* Portable Backup & Restore */}
        <div className="glass-subcard rounded-xl p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--ink-primary)]">
              <HardDrive className="w-4 h-4 text-[var(--tool-antigravity)] shrink-0" />
              <span>Portable Backup &amp; Restore</span>
            </div>
            <div className="inline-flex items-center rounded-lg glass-control p-0.5 text-[10px] font-mono">
              <button
                type="button"
                onClick={() => setBackupImportMode('merge')}
                className={`px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                  backupImportMode === 'merge'
                    ? 'bg-[var(--accent-teal-soft)] text-[var(--accent-teal)] font-semibold'
                    : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                }`}
              >
                Merge (Safe)
              </button>
              <button
                type="button"
                onClick={() => setBackupImportMode('replace')}
                className={`px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                  backupImportMode === 'replace'
                    ? 'bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] font-semibold'
                    : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                }`}
              >
                Replace
              </button>
            </div>
          </div>
          <p className="text-[11px] text-[var(--ink-secondary)] leading-relaxed">
            Export or restore your entire <span className="font-mono text-[var(--ink-primary)]">~/.burnrate</span> archive (sessions &amp; deleted chats ledger, historical pricing &amp; settings) in a single portable <span className="font-mono text-[var(--ink-primary)]">.json</span> file when migrating PCs or formatting.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <button
              type="button"
              disabled={backupBusy !== null}
              onClick={() => void handleExportBackup()}
              className="h-8 px-3 rounded-lg bg-[var(--accent-sky-soft)] hover:brightness-110 border border-[var(--accent-sky-border)] text-xs font-mono font-medium text-[var(--accent-sky)] inline-flex items-center gap-1.5 transition-all disabled:opacity-50 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{backupBusy === 'export' ? 'Exporting...' : 'Export Backup (.json)'}</span>
            </button>
            <button
              type="button"
              disabled={backupBusy !== null}
              onClick={() => backupInputRef.current?.click()}
              className="h-8 px-3 rounded-lg glass-control hover:border-[var(--border-strong)] text-xs font-mono text-[var(--ink-primary)] inline-flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>
                {backupBusy === 'import'
                  ? 'Importing...'
                  : `Import Backup (${backupImportMode === 'merge' ? 'Merge' : 'Replace'})`}
              </span>
            </button>
            <input
              ref={backupInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => void handleImportBackupFile(e.target.files?.[0])}
            />
          </div>
          {backupStatus && (
            <div
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-mono border ${
                backupStatus.tone === 'ok'
                  ? 'bg-[var(--accent-teal-soft)] border-[var(--accent-teal-border)] text-[var(--accent-teal)]'
                  : 'bg-[var(--accent-rose-soft)] border-[var(--accent-rose-border)] text-[var(--accent-rose)]'
              }`}
            >
              {backupStatus.text}
            </div>
          )}
        </div>

        {/* Auto-Archive Offline Hooks Status */}
        <div className="glass-subcard rounded-xl p-3.5 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--ink-primary)]">
            <ShieldCheck className="w-4 h-4 text-[var(--accent-teal)] shrink-0" />
            <span>Offline Auto-Archive Hooks</span>
          </div>
          <p className="text-[11px] text-[var(--ink-secondary)] leading-relaxed">
            Automatically snapshots each completed turn into <span className="font-mono text-[var(--ink-primary)]">~/.burnrate/sessions-ledger.json</span> even when <span className="font-mono text-[var(--ink-primary)]">burn</span> is closed, preserving exact spend and models if you later delete a chat or dismiss a <span className="font-mono text-[var(--ink-primary)]">/btw</span> side-chat.
          </p>
          <div className="flex flex-wrap gap-2 pt-0.5">
            {(
              [
                { key: 'antigravity', label: 'Antigravity', active: hooksStatus?.antigravity },
                { key: 'claude', label: 'Claude Code', active: hooksStatus?.claude },
                { key: 'codex', label: 'Codex CLI', active: hooksStatus?.codex },
              ] as const
            ).map((h) => (
              <span
                key={h.key}
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono border ${
                  h.active
                    ? 'bg-[var(--accent-teal-soft)] border-[var(--accent-teal-border)] text-[var(--accent-teal)]'
                    : 'glass-control text-[var(--ink-tertiary)]'
                }`}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: h.active ? 'var(--accent-teal)' : 'var(--ink-tertiary)' }}
                />
                {h.label}: {h.active ? 'Active' : 'Inactive'}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 sm:px-5 py-3 border-t border-[var(--border-hairline)] bg-[var(--bg-modal-band)] flex items-center justify-end gap-2 shrink-0">
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="h-8 px-3 rounded-lg glass-control hover:border-[var(--border-strong)] text-xs font-mono text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleSave()}
          className="btn-primary-brand h-8 px-3.5 rounded-lg font-semibold text-xs font-mono flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer"
        >
          <Check className="w-3.5 h-3.5" />
          <span>{saving ? 'Saving...' : 'Save Settings'}</span>
        </button>
      </div>
    </dialog>
  );
}
