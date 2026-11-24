import React, { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  DollarSign,
  Download,
  FolderGit2,
  Layers,
  LayoutGrid,
  MessageSquare,
  Moon,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  EUR_RATE,
  buildWorkspaceGroups,
  computeDailyHeatmap,
  computeMonthlyProjection,
  computeTopWorkspaces,
  convertMoney,
  convertSubscriptionMoney,
  filterSessions,
  filterSessionsInWindow,
  formatMoney,
  formatSubscriptionMoney,
  getPreviousWindowBounds,
  getSessionModelBreakdown,
  getSessionSubagentBreakdown,
  getTaxLabel,
  normalizeWorkspaceKey,
  sortWorkspaceGroups,
  workspacesToCsv,
  workspacesToJson,
  type Currency,
  type SortDirection,
  type TimeRange,
  type ToolFilter,
  type WorkspaceSortField,
} from '../core/analytics';
import type {
  BurnrateSnapshot,
  DashboardSectionId,
  ModelRate,
  SessionStats,
  ToolSource,
  UserSettings,
} from '../core/types';
import { AmbientBackdrop } from './components/AmbientBackdrop';
import { DeletedChatsModal } from './components/DeletedChatsModal';
import { HeatmapAndWorkspaces } from './components/HeatmapAndWorkspaces';
import { SettingsModal } from './components/SettingsModal';

const DEFAULT_SECTION_ORDER: DashboardSectionId[] = [
  'kpis',
  'charts',
  'modelUsage',
  'heatmapWorkspaces',
  'sessions',
];

const FALLBACK_SETTINGS: UserSettings = {
  subscriptions: { antigravity: 19.99, claude: 20, codex: 0 },
  includeDeletedInTotals: true,
  layout: {
    order: DEFAULT_SECTION_ORDER,
    hidden: [],
  },
  trackingStartAt: {
    antigravity: null,
    claude: null,
    codex: null,
  },
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatRateMoney(usdAmount: number, currency: Currency): string {
  const val = convertMoney(usdAmount, currency);
  const sym = currency === 'EUR' ? '€' : '$';
  if (val === 0) return `${sym}0.00`;
  if (val < 1) {
    return `${sym}${val.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1')}`;
  }
  return `${sym}${val.toFixed(2)}`;
}

function DeltaPill({
  deltaPct,
  label,
  higherIsBetter = false,
}: {
  deltaPct: number | null;
  label?: string;
  higherIsBetter?: boolean;
}) {
  if (deltaPct === null || !Number.isFinite(deltaPct)) return null;
  const rounded = Math.round(deltaPct * 10) / 10;
  if (Math.abs(rounded) < 0.1) {
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-mono tabular glass-control text-[var(--ink-tertiary)]"
        title={label ? `Flat vs ${label}` : undefined}
      >
        0% {label ? `vs ${label}` : ''}
      </span>
    );
  }
  const isUp = rounded > 0;
  const isPositiveTone = higherIsBetter ? isUp : !isUp;
  const toneClass = isPositiveTone
    ? 'bg-[var(--accent-teal-soft)] text-[var(--accent-teal)] border-[var(--accent-teal-border)]'
    : 'bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border-[var(--accent-amber-border)]';
  const sign = isUp ? '+' : '';
  const displayPct = Math.abs(rounded) >= 999 ? `${sign}999%+` : `${sign}${rounded.toFixed(1)}%`;

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono tabular border whitespace-nowrap ${toneClass}`}
      title={label ? `Change vs ${label}` : undefined}
    >
      <span>{displayPct}</span>
      {label ? <span className="opacity-75">vs {label}</span> : null}
    </span>
  );
}

function findModelRate(
  normalizedModel: string | undefined,
  modelLabel: string,
  pricing: BurnrateSnapshot['pricing'] | undefined
): ModelRate | undefined {
  if (!pricing?.models) return undefined;
  return (
    (normalizedModel ? pricing.models[normalizedModel] : undefined) ||
    Object.values(pricing.models).find((r) => r.label === modelLabel)
  );
}

function ToolBadge({ source, compact = false }: { source: ToolSource; compact?: boolean }) {
  const pad = compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[10.5px]';
  if (source === 'antigravity') {
    return (
      <span
        className={`inline-flex items-center gap-1 ${pad} rounded-md font-mono font-medium bg-[var(--accent-sky-soft)] text-[var(--tool-antigravity)] border border-[var(--accent-sky-border)] whitespace-nowrap`}
      >
        <Terminal className="w-3 h-3 shrink-0" />
        Antigravity
      </span>
    );
  }
  if (source === 'claude') {
    return (
      <span
        className={`inline-flex items-center gap-1 ${pad} rounded-md font-mono font-medium bg-[var(--accent-violet-soft)] text-[var(--tool-claude)] border border-[var(--accent-violet-border)] whitespace-nowrap`}
      >
        <Sparkles className="w-3 h-3 shrink-0" />
        Claude Code
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 ${pad} rounded-md font-mono font-medium bg-[var(--accent-amber-soft)] text-[var(--tool-codex)] border border-[var(--accent-amber-border)] whitespace-nowrap`}
    >
      <Terminal className="w-3 h-3 shrink-0" />
      Codex CLI
    </span>
  );
}

function formatRelativeTime(iso: string): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return iso.slice(0, 10);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

function formatPreciseDateTime(iso: string | undefined): { date: string; time: string } {
  if (!iso) return { date: '—', time: '—' };
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: iso.slice(0, 10), time: '' };
    const date = d.toLocaleDateString('it-IT', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return { date, time };
  } catch {
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
  }
}

function toLocalDateTimeInput(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getQuickRestoreLocalInput(preset: 'today' | '7d' | '30d' | 'month'): string {
  const now = new Date();
  if (preset === 'today') {
    return toLocalDateTimeInput(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
  }
  if (preset === '7d') {
    return toLocalDateTimeInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 0, 0, 0, 0));
  }
  if (preset === '30d') {
    return toLocalDateTimeInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30, 0, 0, 0, 0));
  }
  return toLocalDateTimeInput(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0));
}

function isPromoActive(rate: ModelRate | undefined, targetDate?: string | number): boolean {
  if (!rate || !rate.isPromo) return false;
  const now = targetDate ? new Date(targetDate).getTime() : Date.now();
  if (Number.isNaN(now)) return false;
  const start = rate.promoStart ? new Date(rate.promoStart).getTime() : null;
  const end = rate.promoEnd ? new Date(rate.promoEnd).getTime() : null;
  if (start !== null && !Number.isNaN(start) && now < start) return false;
  if (end !== null && !Number.isNaN(end) && now > end) return false;
  return true;
}

const MODEL_COLORS = ['#0d9488', '#0284c7', '#7c3aed', '#ea580c', '#d97706', '#2563eb'];

const SORT_OPTIONS: Array<{ value: WorkspaceSortField; label: string }> = [
  { value: 'lastActiveAt', label: 'Last Modified' },
  { value: 'startedAt', label: 'Created' },
  { value: 'totalTokens', label: 'Total Tokens' },
  { value: 'costUSD', label: 'API Cost' },
  { value: 'turns', label: 'Turns' },
  { value: 'ioTokens', label: 'Input / Output' },
  { value: 'cacheReadTokens', label: 'Cache Read' },
  { value: 'cacheSavingsUSD', label: 'Cache Saved' },
  { value: 'chats', label: 'Chats' },
  { value: 'workspaceName', label: 'Workspace' },
  { value: 'primaryModelLabel', label: 'Model' },
  { value: 'tool', label: 'Tool' },
];

const TEXT_SORT_FIELDS: ReadonlySet<WorkspaceSortField> = new Set([
  'workspaceName',
  'primaryModelLabel',
  'tool',
]);

interface FilterDropdownOption<T extends string> {
  value: T;
  label: string;
}

function FilterDropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  prefixLabel,
  attachedLeft = false,
  maxWidthClass = 'max-w-[180px]',
  menuAlign = 'right',
}: {
  value: T;
  options: Array<FilterDropdownOption<T>>;
  onChange: (next: T) => void;
  ariaLabel: string;
  title: string;
  prefixLabel?: string;
  attachedLeft?: boolean;
  maxWidthClass?: string;
  menuAlign?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const selectedLabel = options.find((opt) => opt.value === value)?.label ?? value;

  return (
    <div ref={containerRef} className={`relative ${attachedLeft ? 'h-full' : 'shrink-0'}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        className={
          attachedLeft
            ? `h-full px-2.5 flex items-center gap-1.5 text-xs font-mono text-[var(--ink-primary)] hover:bg-[var(--table-hover)] rounded-l-lg transition-colors cursor-pointer select-none ${maxWidthClass}`
            : `h-8 px-2.5 rounded-lg glass-control ${
                open ? 'border-[var(--accent-teal)]' : 'hover:border-[var(--border-strong)]'
              } flex items-center gap-1.5 text-xs font-mono text-[var(--ink-primary)] transition-colors cursor-pointer select-none ${maxWidthClass}`
        }
      >
        <span className="truncate">
          {prefixLabel ? <span className="text-[var(--ink-tertiary)]">{prefixLabel} </span> : null}
          <span>{selectedLabel}</span>
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 transition-transform duration-150 ${
            open ? 'rotate-180 text-[var(--accent-teal)]' : 'text-[var(--ink-tertiary)]'
          }`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute top-full ${
            menuAlign === 'left' ? 'left-0' : 'right-0'
          } mt-1.5 z-40 min-w-[205px] max-h-72 overflow-y-auto rounded-xl glass-popover p-1 space-y-0.5 animate-burn-expand`}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full px-2.5 py-1.5 rounded-lg text-left text-xs font-mono flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-[var(--accent-teal-soft)] text-[var(--accent-teal)] border border-[var(--accent-teal-border)] font-medium'
                    : 'text-[var(--ink-secondary)] hover:bg-[var(--table-hover)] hover:text-[var(--ink-primary)] border border-transparent'
                }`}
              >
                <span className="truncate">{opt.label}</span>
                {isSelected && <Check className="w-3.5 h-3.5 text-[var(--accent-teal)] shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function parseCurrency(raw?: string | null): Currency | undefined {
  const upper = raw?.toUpperCase();
  return upper === 'EUR' || upper === 'USD' ? upper : undefined;
}

function parseToolFilter(raw?: string | null): ToolFilter | undefined {
  const lower = raw?.toLowerCase();
  return lower === 'all' || lower === 'antigravity' || lower === 'claude' || lower === 'codex'
    ? lower
    : undefined;
}

function parseTimeRange(raw?: string | null): TimeRange | undefined {
  const lower = raw?.toLowerCase();
  return lower === '24h' || lower === '7d' || lower === '30d' || lower === 'all'
    ? lower
    : undefined;
}

function clearUrlOverrideParam(key: 'currency' | 'tool' | 'range') {
  if (typeof window === 'undefined' || !window.location.search) return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has(key)) return;
  params.delete(key);
  const qs = params.toString();
  const nextUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', nextUrl);
}

function readUrlLaunchOverrides(): {
  currency?: Currency;
  toolFilter?: ToolFilter;
  timeRange?: TimeRange;
} {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  return {
    currency: parseCurrency(params.get('currency')),
    toolFilter: parseToolFilter(params.get('tool')),
    timeRange: parseTimeRange(params.get('range')),
  };
}

export default function App() {
  const urlOverrides = useMemo(() => readUrlLaunchOverrides(), []);
  const userTouchedCurrencyRef = useRef<boolean>(false);
  const userTouchedToolRef = useRef<boolean>(false);
  const userTouchedRangeRef = useRef<boolean>(false);

  const [snapshot, setSnapshot] = useState<BurnrateSnapshot | null>(null);
  const [sseConnected, setSseConnected] = useState<boolean>(false);
  const [lastSyncTime, setLastSyncTime] = useState<string>('');
  const [lastChangedFile, setLastChangedFile] = useState<string | null>(null);
  const [isRescanning, setIsRescanning] = useState<boolean>(false);

  const [toolFilter, setToolFilter] = useState<ToolFilter>(
    () => urlOverrides.toolFilter || parseToolFilter(localStorage.getItem('burnrate_tool_filter')) || 'all'
  );
  const [timeRange, setTimeRange] = useState<TimeRange>(
    () => urlOverrides.timeRange || parseTimeRange(localStorage.getItem('burnrate_time_range')) || 'all'
  );
  const [currency, setCurrency] = useState<Currency>(
    () => urlOverrides.currency || parseCurrency(localStorage.getItem('burnrate_currency')) || 'USD'
  );
  const [searchQuery, setSearchQuery] = useState<string>('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [tableModelFilter, setTableModelFilter] = useState<string>('all');

  useEffect(() => {
    const syncColorScheme = (e: StorageEvent) => {
      if (e.key !== 'color-scheme') return;
      const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
      if (!meta) return;
      meta.content = e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : 'light dark';
    };
    window.addEventListener('storage', syncColorScheme);
    return () => window.removeEventListener('storage', syncColorScheme);
  }, []);

  const toggleColorScheme = () => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (!meta) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('color-scheme');
    } catch {
      stored = null;
    }
    const systemScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const renderedScheme = stored === 'light' || stored === 'dark' ? stored : systemScheme;
    const targetScheme = renderedScheme === 'dark' ? 'light' : 'dark';
    const nextValue = targetScheme === systemScheme ? 'light dark' : targetScheme;
    meta.content = nextValue;
    try {
      if (nextValue === 'light dark') {
        localStorage.removeItem('color-scheme');
      } else {
        localStorage.setItem('color-scheme', nextValue);
      }
    } catch {
      // ignore storage quota/privacy restrictions
    }
  };
  const [sortBy, setSortBy] = useState<WorkspaceSortField>('lastActiveAt');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [expandedChats, setExpandedChats] = useState<Set<string>>(new Set());
  const [expandedBtwRows, setExpandedBtwRows] = useState<Set<string>>(new Set());
  const [isModelUsageExpanded, setIsModelUsageExpanded] = useState<boolean>(() => {
    return localStorage.getItem('burnrate_models_expanded') === 'true';
  });
  const [isDeletedModalOpen, setIsDeletedModalOpen] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isBannerRestoreOpen, setIsBannerRestoreOpen] = useState<boolean>(false);
  const [bannerRestoreDate, setBannerRestoreDate] = useState<string>('');
  const [bannerRestoreTarget, setBannerRestoreTarget] = useState<'all' | ToolSource>('all');
  const [dismissingLegacyKeys, setDismissingLegacyKeys] = useState<Set<string>>(new Set());
  const [isClearingLegacyBulk, setIsClearingLegacyBulk] = useState<boolean>(false);
  const [isRestoringLegacy, setIsRestoringLegacy] = useState<boolean>(false);
  const [hideLegacyDeleted, setHideLegacyDeleted] = useState<boolean>(() => {
    try {
      return localStorage.getItem('burnrate_hide_legacy_deleted') === 'true';
    } catch {
      return false;
    }
  });

  const toggleHideLegacyDeleted = () => {
    setHideLegacyDeleted((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('burnrate_hide_legacy_deleted', String(next));
      } catch {
        // ignore storage quota/privacy restrictions
      }
      return next;
    });
  };

  const handleSortField = (field: WorkspaceSortField) => {
    if (sortBy === field) {
      setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(field);
      setSortDir(TEXT_SORT_FIELDS.has(field) ? 'asc' : 'desc');
    }
  };

  const resetTableFilters = () => {
    setTableModelFilter('all');
    setSearchQuery('');
  };

  const toggleModelUsageExpanded = () => {
    setIsModelUsageExpanded((prev) => {
      const next = !prev;
      localStorage.setItem('burnrate_models_expanded', String(next));
      return next;
    });
  };

  const toggleSetKey = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string
  ) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleCurrency = (next: Currency) => {
    userTouchedCurrencyRef.current = true;
    setCurrency(next);
    localStorage.setItem('burnrate_currency', next);
    clearUrlOverrideParam('currency');
  };
  const selectToolFilter = (next: ToolFilter) => {
    userTouchedToolRef.current = true;
    setToolFilter(next);
    localStorage.setItem('burnrate_tool_filter', next);
    clearUrlOverrideParam('tool');
  };
  const selectTimeRange = (next: TimeRange) => {
    userTouchedRangeRef.current = true;
    setTimeRange(next);
    localStorage.setItem('burnrate_time_range', next);
    clearUrlOverrideParam('range');
  };
  const userSettings: UserSettings = useMemo(() => {
    const raw = snapshot?.settings;
    if (!raw) return FALLBACK_SETTINGS;
    return {
      ...FALLBACK_SETTINGS,
      ...raw,
      subscriptions: {
        ...FALLBACK_SETTINGS.subscriptions,
        ...(raw.subscriptions || {}),
      },
      layout: raw.layout || FALLBACK_SETTINGS.layout,
      trackingStartAt: {
        ...FALLBACK_SETTINGS.trackingStartAt,
        ...(raw.trackingStartAt || {}),
      },
    };
  }, [snapshot?.settings]);
  const currencySymbol = currency === 'EUR' ? '€' : '$';
  const rateMultiplier = currency === 'EUR' ? EUR_RATE : 1;
  const taxLabel = getTaxLabel(currency);

  const sectionOrder = userSettings.layout?.order?.length
    ? userSettings.layout.order
    : DEFAULT_SECTION_ORDER;
  const hiddenSections = useMemo(
    () => new Set<DashboardSectionId>(userSettings.layout?.hidden || []),
    [userSettings.layout?.hidden]
  );
  const getSectionOrderIndex = (id: DashboardSectionId): number => {
    const idx = sectionOrder.indexOf(id);
    return idx >= 0 ? idx : DEFAULT_SECTION_ORDER.indexOf(id);
  };
  const visibleSectionCount = DEFAULT_SECTION_ORDER.filter((id) => !hiddenSections.has(id)).length;

  const dashHeaderInnerRef = useRef<HTMLDivElement | null>(null);
  const toolGroupRef = useRef<HTMLDivElement | null>(null);
  const toolBtnRefs = useRef<Record<ToolFilter, HTMLButtonElement | null>>({
    all: null,
    antigravity: null,
    claude: null,
    codex: null,
  });
  const [toolPill, setToolPill] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  });

  const hasSnapshot = Boolean(snapshot);
  useLayoutEffect(() => {
    if (!hasSnapshot) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let scaleRaf = 0;
    const applyScrollScale = () => {
      scaleRaf = 0;
      const innerEl = dashHeaderInnerRef.current;
      if (!innerEl) return;
      if (reducedMotion.matches) {
        innerEl.style.transform = '';
        return;
      }
      const p = Math.min(1, Math.max(0, window.scrollY / 100));
      if (p <= 0) {
        innerEl.style.transform = '';
      } else {
        const ty = (-3 * p).toFixed(2);
        const sc = (1 - 0.012 * p).toFixed(4);
        innerEl.style.transform = `translateY(${ty}px) scale(${sc})`;
      }
    };
    const onScroll = () => {
      if (!scaleRaf) scaleRaf = requestAnimationFrame(applyScrollScale);
    };
    applyScrollScale();
    window.addEventListener('scroll', onScroll, { passive: true });
    reducedMotion.addEventListener?.('change', applyScrollScale);
    return () => {
      cancelAnimationFrame(scaleRaf);
      window.removeEventListener('scroll', onScroll);
      reducedMotion.removeEventListener?.('change', applyScrollScale);
      if (dashHeaderInnerRef.current) dashHeaderInnerRef.current.style.transform = '';
    };
  }, [hasSnapshot]);

  useLayoutEffect(() => {
    let rafId = 0;
    const updatePill = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const btn = toolBtnRefs.current[toolFilter];
        if (!btn) return;
        const nextLeft = btn.offsetLeft;
        const nextWidth = btn.offsetWidth;
        setToolPill((prev) =>
          prev.ready && prev.left === nextLeft && prev.width === nextWidth
            ? prev
            : { left: nextLeft, width: nextWidth, ready: true }
        );
      });
    };
    updatePill();

    const groupEl = toolGroupRef.current;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePill) : null;
    if (ro && groupEl) {
      ro.observe(groupEl);
      for (const el of Object.values(toolBtnRefs.current)) {
        if (el) ro.observe(el);
      }
    }
    window.addEventListener('resize', updatePill);
    document.fonts?.ready.then(updatePill).catch(() => {});

    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener('resize', updatePill);
    };
  }, [toolFilter, snapshot !== null]);

  useEffect(() => {
    // Apply CLI launch flags even if user refreshes manually without query string
    fetch('/api/defaults')
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          defaults: {
            currency?: Currency;
            toolFilter?: ToolFilter;
            timeRange?: TimeRange;
          } | null
        ) => {
          if (!defaults) return;
          const defaultsSig = JSON.stringify(defaults);
          if (sessionStorage.getItem('burnrate_applied_defaults') === defaultsSig) return;
          sessionStorage.setItem('burnrate_applied_defaults', defaultsSig);

          if (!urlOverrides.currency && !userTouchedCurrencyRef.current && defaults.currency) {
            setCurrency(defaults.currency);
            localStorage.setItem('burnrate_currency', defaults.currency);
          }
          if (!urlOverrides.toolFilter && !userTouchedToolRef.current && defaults.toolFilter) {
            setToolFilter(defaults.toolFilter);
            localStorage.setItem('burnrate_tool_filter', defaults.toolFilter);
          }
          if (!urlOverrides.timeRange && !userTouchedRangeRef.current && defaults.timeRange) {
            setTimeRange(defaults.timeRange);
            localStorage.setItem('burnrate_time_range', defaults.timeRange);
          }
        }
      )
      .catch(() => {});

    // Initial fetch fallback
    fetch('/api/stats')
      .then((res) => res.json())
      .then((data: BurnrateSnapshot) => {
        setSnapshot(data);
        setLastSyncTime(new Date().toLocaleTimeString());
      })
      .catch(() => {});

    // Real-Time Server-Sent Events connection
    const es = new EventSource('/api/events');

    es.onopen = () => {
      setSseConnected(true);
    };

    const handlePayload = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.snapshot) {
          setSnapshot(parsed.snapshot);
          setLastSyncTime(new Date().toLocaleTimeString());
          if (parsed.changedPath) {
            setLastChangedFile(parsed.changedPath);
          }
        }
      } catch {
        // ignore malformed event
      }
    };

    es.addEventListener('init', handlePayload);
    es.addEventListener('update', handlePayload);

    es.onerror = () => {
      setSseConnected(false);
    };

      return () => {
      es.close();
    };
  }, []);

  const triggerManualRescan = async () => {
    setIsRescanning(true);
    try {
      const res = await fetch('/api/rescan', { method: 'POST' });
      const data = await res.json();
      setSnapshot(data);
      setLastSyncTime(new Date().toLocaleTimeString());
    } finally {
      setTimeout(() => setIsRescanning(false), 300);
    }
  };

  const saveSettings = async (next: UserSettings) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (res.ok) {
      const data = (await res.json()) as { snapshot?: BurnrateSnapshot };
      if (data.snapshot) {
        setSnapshot(data.snapshot);
        setLastSyncTime(new Date().toLocaleTimeString());
      }
    }
  };

  const toggleIncludeDeletedInTotals = () => {
    void saveSettings({
      ...userSettings,
      includeDeletedInTotals: !userSettings.includeDeletedInTotals,
    });
  };

  const restoreDismissedLegacy = async () => {
    setIsRestoringLegacy(true);
    try {
      const res = await fetch('/api/deleted-legacy/restore', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as { snapshot?: BurnrateSnapshot };
        if (data.snapshot) {
          setSnapshot(data.snapshot);
          setLastSyncTime(new Date().toLocaleTimeString());
        }
      }
    } catch {
      // ignore network failure
    } finally {
      setIsRestoringLegacy(false);
    }
  };

  // Global KPIs & charts scoped to topbar toolFilter and timeRange
  const analytics = useMemo(() => {
    if (!snapshot) return null;

    const includeDeleted = userSettings.includeDeletedInTotals;
    const trackingStartAt = userSettings.trackingStartAt;
    const activeFilteredSessions: SessionStats[] = filterSessions(snapshot.sessions, {
      toolFilter,
      timeRange,
      trackingStartAt,
    });
    const deletedFilteredSessions: SessionStats[] = filterSessions(snapshot.deletedSessions || [], {
      toolFilter,
      timeRange,
      trackingStartAt,
    }).sort((a, b) => {
      const aKey = a.deletedAt || a.lastActiveAt || '';
      const bKey = b.deletedAt || b.lastActiveAt || '';
      return bKey > aKey ? 1 : -1;
    });
    const trackedDeletedSessions = deletedFilteredSessions.filter((s) => !s.untrackedHistory);
    const legacyDeletedCount = deletedFilteredSessions.length - trackedDeletedSessions.length;
    const allFilteredSessions: SessionStats[] = includeDeleted
      ? [...activeFilteredSessions, ...trackedDeletedSessions]
      : [...activeFilteredSessions];

    let totalCostUSD = 0;
    let totalCacheSavingsUSD = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalTokens = 0;
    let totalTurns = 0;

    let deletedCostUSD = 0;
    let deletedTokens = 0;
    let deletedCacheSavingsUSD = 0;
    for (const d of trackedDeletedSessions) {
      deletedCostUSD += d.costUSD;
      deletedTokens += d.totalTokens;
      deletedCacheSavingsUSD += d.cacheSavingsUSD;
    }

    let antigravityCost = 0;
    let claudeCost = 0;
    let codexCost = 0;

    const dailyMap = new Map<
      string,
      {
        date: string;
        antigravityUSD: number;
        claudeUSD: number;
        codexUSD: number;
        totalUSD: number;
        tokens: number;
      }
    >();
    const modelMap = new Map<
      string,
      {
        model: string;
        normalizedModel?: string;
        costUSD: number;
        tokens: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        turns: number;
        longContextTurns: number;
        source: ToolSource;
        rate?: ModelRate;
      }
    >();
    const activeModelCostMap = new Map<string, number>();
    const workspaceSet = new Set<string>();

    for (const session of activeFilteredSessions) {
      workspaceSet.add(normalizeWorkspaceKey(session.workspace));
      for (const t of session.turnHistory) {
        activeModelCostMap.set(t.modelLabel, (activeModelCostMap.get(t.modelLabel) || 0) + t.costUSD);
      }
    }

    for (const session of allFilteredSessions) {
      totalCostUSD += session.costUSD;
      totalCacheSavingsUSD += session.cacheSavingsUSD;
      totalInputTokens += session.inputTokens;
      totalOutputTokens += session.outputTokens;
      totalCacheReadTokens += session.cacheReadTokens;
      totalCacheWriteTokens += session.cacheWriteTokens;
      totalTokens += session.totalTokens;
      totalTurns += session.turns;

      if (session.source === 'antigravity') antigravityCost += session.costUSD;
      else if (session.source === 'claude') claudeCost += session.costUSD;
      else codexCost += session.costUSD;

      for (const t of session.turnHistory) {
        const dayKey = (t.timestamp || session.lastActiveAt).slice(0, 10);
        const dayEntry = dailyMap.get(dayKey) || {
          date: dayKey,
          antigravityUSD: 0,
          claudeUSD: 0,
          codexUSD: 0,
          totalUSD: 0,
          tokens: 0,
        };
        if (session.source === 'antigravity') dayEntry.antigravityUSD += t.costUSD;
        else if (session.source === 'claude') dayEntry.claudeUSD += t.costUSD;
        else dayEntry.codexUSD += t.costUSD;
        dayEntry.totalUSD += t.costUSD;
        dayEntry.tokens += t.totalTokens;
        dailyMap.set(dayKey, dayEntry);

        let modEntry = modelMap.get(t.modelLabel);
        if (!modEntry) {
          const matchedRate =
            (t.normalizedModel ? snapshot.pricing?.models?.[t.normalizedModel] : undefined) ||
            Object.values(snapshot.pricing?.models || {}).find(
              (r) => r.label === t.modelLabel || r.label.toLowerCase() === t.model.toLowerCase()
            );
          modEntry = {
            model: t.modelLabel,
            normalizedModel: t.normalizedModel,
            costUSD: 0,
            tokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            turns: 0,
            longContextTurns: 0,
            source: session.source,
            rate: matchedRate,
          };
          modelMap.set(t.modelLabel, modEntry);
        }
        modEntry.costUSD += t.costUSD;
        modEntry.tokens += t.totalTokens;
        modEntry.inputTokens += t.inputTokens;
        modEntry.outputTokens += t.outputTokens;
        modEntry.cacheReadTokens += t.cacheReadTokens;
        modEntry.turns += 1;
        if (!modEntry.rate && t.normalizedModel && snapshot.pricing?.models?.[t.normalizedModel]) {
          modEntry.rate = snapshot.pricing.models[t.normalizedModel];
        }
        const lcThreshold = modEntry.rate?.longContext?.thresholdTokens;
        if (
          lcThreshold &&
          lcThreshold > 0 &&
          t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens > lcThreshold
        ) {
          modEntry.longContextTurns += 1;
        }
      }
    }

    const timelineData = Array.from(dailyMap.values())
      .sort((a, b) => (a.date > b.date ? 1 : -1))
      .map((d) => ({
        ...d,
        antigravityUSD: Number(d.antigravityUSD.toFixed(3)),
        claudeUSD: Number(d.claudeUSD.toFixed(3)),
        codexUSD: Number(d.codexUSD.toFixed(3)),
        totalUSD: Number(d.totalUSD.toFixed(3)),
      }));

    const modelData = Array.from(modelMap.values())
      .sort((a, b) => b.costUSD - a.costUSD)
      .map((m) => ({
        ...m,
        costUSD: Number(m.costUSD.toFixed(2)),
      }));

    const availableModels = Array.from(activeModelCostMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([model]) => model);

    const promptPool = totalInputTokens + totalCacheReadTokens;
    const cacheHitRate = promptPool > 0 ? (totalCacheReadTokens / promptPool) * 100 : 0;

    // Period-over-period comparison (24h, 7d, 30d vs previous window)
    const nowMs = Date.now();
    const prevBounds = getPreviousWindowBounds(timeRange, nowMs);
    let deltas: {
      label: string;
      costPct: number | null;
      tokensPct: number | null;
      savingsPct: number | null;
      turnsPct: number | null;
    } | null = null;

    const fullTrackedPool: SessionStats[] = includeDeleted
      ? [...snapshot.sessions, ...(snapshot.deletedSessions || []).filter((s) => !s.untrackedHistory)]
      : [...snapshot.sessions];

    if (prevBounds) {
      const prevSessions = filterSessionsInWindow(fullTrackedPool, {
        toolFilter,
        startMs: prevBounds.startMs,
        endMs: prevBounds.endMs,
        trackingStartAt,
      });
      const prevCost = prevSessions.reduce((a, s) => a + s.costUSD, 0);
      const prevTokens = prevSessions.reduce((a, s) => a + s.totalTokens, 0);
      const prevSavings = prevSessions.reduce((a, s) => a + s.cacheSavingsUSD, 0);
      const prevTurns = prevSessions.reduce((a, s) => a + s.turns, 0);
      const pct = (cur: number, prev: number): number | null => {
        if (prev <= 0) return null;
        return ((cur - prev) / prev) * 100;
      };
      deltas = {
        label: prevBounds.label,
        costPct: pct(totalCostUSD, prevCost),
        tokensPct: pct(totalTokens, prevTokens),
        savingsPct: pct(totalCacheSavingsUSD, prevSavings),
        turnsPct: pct(totalTurns, prevTurns),
      };
    }

    const toolScopedAllTime = filterSessions(fullTrackedPool, {
      toolFilter,
      timeRange: 'all',
      trackingStartAt,
    });
    const projection = computeMonthlyProjection(toolScopedAllTime, nowMs);
    const heatmapDays = computeDailyHeatmap(toolScopedAllTime, 13, nowMs);
    const topWorkspaces = computeTopWorkspaces(allFilteredSessions, 7);

    const subs = userSettings.subscriptions;
    const referenceSubUSD =
      toolFilter === 'all'
        ? subs.antigravity + subs.claude + subs.codex
        : subs[toolFilter];

    return {
      totalCostUSD,
      totalCacheSavingsUSD,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      totalTokens,
      totalTurns,
      antigravityCost,
      claudeCost,
      codexCost,
      cacheHitRate,
      referenceSubUSD,
      deltas,
      projection,
      heatmapDays,
      topWorkspaces,
      workspacesCount: workspaceSet.size,
      timelineData,
      modelData,
      availableModels,
      filteredSessions: activeFilteredSessions,
      totalSessionsCount: activeFilteredSessions.length,
      deletedSessions: deletedFilteredSessions,
      trackedDeletedSessions,
      deletedSessionsCount: deletedFilteredSessions.length,
      trackedDeletedCount: trackedDeletedSessions.length,
      legacyDeletedCount,
      deletedCostUSD,
      deletedTokens,
      deletedCacheSavingsUSD,
      totalAllSessionsCount: allFilteredSessions.length,
    };
  }, [snapshot, toolFilter, timeRange, userSettings]);

  const activeModelFilter =
    analytics && analytics.availableModels.includes(tableModelFilter) ? tableModelFilter : 'all';

  const tableData = useMemo(() => {
    if (!analytics) return { workspaces: [], chatsCount: 0 };
    const tableSessions = filterSessions(analytics.filteredSessions, {
      searchQuery: deferredSearchQuery,
      modelFilter: activeModelFilter,
    });
    const grouped = buildWorkspaceGroups(tableSessions);
    return {
      workspaces: sortWorkspaceGroups(grouped, sortBy, sortDir),
      chatsCount: tableSessions.length,
    };
  }, [analytics, deferredSearchQuery, activeModelFilter, sortBy, sortDir]);

  const dismissLegacyChats = async (chats: SessionStats[], isBulk = false) => {
    const legacyOnly = chats.filter((chat) => Boolean(chat.untrackedHistory));
    if (legacyOnly.length === 0) return;

    const keys = legacyOnly.map((chat) => `${chat.source}:${chat.sessionId}`);
    if (isBulk) {
      setIsClearingLegacyBulk(true);
    }
    setDismissingLegacyKeys((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });

    try {
      const res = await fetch('/api/deleted-legacy/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: legacyOnly.map((chat) => ({
            source: chat.source,
            sessionId: chat.sessionId,
          })),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { snapshot?: BurnrateSnapshot };
        if (data.snapshot) {
          setSnapshot(data.snapshot);
          setLastSyncTime(new Date().toLocaleTimeString());
        }
      }
    } catch {
      // ignore network failure
    } finally {
      if (isBulk) setIsClearingLegacyBulk(false);
      setDismissingLegacyKeys((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.delete(k);
        return next;
      });
    }
  };

  if (!snapshot || !analytics) {
    return (
      <div className="relative isolate min-h-screen text-[var(--ink-primary)] flex items-center justify-center p-4">
        <AmbientBackdrop />
        <div className="glass-panel rounded-2xl px-6 py-5 flex flex-col items-center gap-3">
          <div className="h-7 w-7 rounded-full border-2 border-[var(--accent-teal)] border-t-transparent animate-spin" />
          <p className="text-xs sm:text-sm text-[var(--ink-secondary)] font-mono">
            Scanning ~/.gemini, ~/.claude &amp; ~/.codex logs...
          </p>
        </div>
      </div>
    );
  }

  const displayedSpend = convertMoney(analytics.totalCostUSD, currency);
  const displayedSub = convertSubscriptionMoney(analytics.referenceSubUSD, currency);
  const subPercentage =
    displayedSub > 0 ? Math.min(100, (displayedSpend / displayedSub) * 100) : 0;
  const subMultiplier =
    displayedSub > 0 ? (displayedSpend / displayedSub).toFixed(1) : '0.0';

  const hasTableFilters = activeModelFilter !== 'all' || searchQuery.trim().length > 0;

  const activeTrackingCutoffs = (
    [
      { key: 'antigravity', label: 'Antigravity' },
      { key: 'claude', label: 'Claude Code' },
      { key: 'codex', label: 'Codex CLI' },
    ] as Array<{ key: ToolSource; label: string }>
  )
    .filter((item) => (toolFilter === 'all' || toolFilter === item.key) && Boolean(userSettings.trackingStartAt[item.key]))
    .map((item) => {
      const iso = userSettings.trackingStartAt[item.key]!;
      const formatted = formatPreciseDateTime(iso);
      return {
        ...item,
        iso,
        display: `${formatted.date} ${formatted.time.slice(0, 5)}`.trim(),
      };
    });

  const restoreVisibleTrackingCutoffs = () => {
    const nextTracking = { ...userSettings.trackingStartAt };
    for (const item of activeTrackingCutoffs) {
      nextTracking[item.key] = null;
    }
    setIsBannerRestoreOpen(false);
    void saveSettings({
      ...userSettings,
      trackingStartAt: nextTracking,
    });
  };

  const openBannerRestoreFromDate = () => {
    const firstCutoff = activeTrackingCutoffs[0]?.iso;
    setBannerRestoreTarget('all');
    setBannerRestoreDate(
      firstCutoff ? toLocalDateTimeInput(firstCutoff) : getQuickRestoreLocalInput('today')
    );
    setIsBannerRestoreOpen(true);
  };

  const effectiveBannerRestoreTarget: 'all' | ToolSource =
    bannerRestoreTarget !== 'all' &&
    activeTrackingCutoffs.some((c) => c.key === bannerRestoreTarget)
      ? bannerRestoreTarget
      : 'all';

  const applyBannerRestoreFromDate = () => {
    const parsed = new Date(bannerRestoreDate);
    if (!bannerRestoreDate || Number.isNaN(parsed.getTime())) return;
    const nextIso = parsed.toISOString();
    const nextTracking = { ...userSettings.trackingStartAt };
    const targets =
      effectiveBannerRestoreTarget === 'all'
        ? activeTrackingCutoffs.map((c) => c.key)
        : [effectiveBannerRestoreTarget];
    for (const key of targets) {
      nextTracking[key] = nextIso;
    }
    setIsBannerRestoreOpen(false);
    void saveSettings({
      ...userSettings,
      trackingStartAt: nextTracking,
    });
  };

  const exportReport = (format: 'csv' | 'json') => {
    const dateStamp = new Date().toISOString().slice(0, 10);
    const filename = `burnrate-${toolFilter}-${timeRange}-${dateStamp}.${format}`;
    const exportDeleted = userSettings.includeDeletedInTotals ? analytics.trackedDeletedSessions : [];
    const content =
      format === 'csv'
        ? workspacesToCsv(tableData.workspaces, currency, exportDeleted)
        : workspacesToJson(
            tableData.workspaces,
            currency,
            {
              toolFilter,
              timeRange,
              modelFilter: activeModelFilter,
              searchQuery,
              sortBy,
              sortDir,
            },
            exportDeleted
          );
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const sortedModels = [...analytics.modelData].sort((a, b) => b.tokens - a.tokens);
  const canCollapseModels = sortedModels.length > 2;
  const topModels = canCollapseModels ? sortedModels.slice(0, 2) : sortedModels;
  const extraModels = canCollapseModels ? sortedModels.slice(2) : [];

  const renderModelCard = (m: (typeof analytics.modelData)[number], idx: number) => {
    const sharePct = analytics.totalTokens > 0 ? (m.tokens / analytics.totalTokens) * 100 : 0;
    const barColor = MODEL_COLORS[idx % MODEL_COLORS.length];
    const promoActive = Boolean(m.rate && isPromoActive(m.rate));
    const curInput = m.rate ? (promoActive ? m.rate.input : (m.rate.standardInput ?? m.rate.input)) : 0;
    const curCache = m.rate
      ? promoActive
        ? m.rate.cacheRead
        : (m.rate.standardCacheRead ?? m.rate.cacheRead)
      : 0;
    const curOutput = m.rate ? (promoActive ? m.rate.output : (m.rate.standardOutput ?? m.rate.output)) : 0;

    return (
      <div
        key={m.model}
        className="glass-subcard glass-interactive rounded-xl p-4 flex flex-col justify-between gap-3"
      >
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[var(--ink-primary)] truncate" title={m.model}>
              {m.model}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              {promoActive && (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border border-[var(--accent-amber-border)] flex items-center gap-1"
                  title={m.rate?.promoNote || 'Active promotional rate'}
                >
                  <Sparkles className="w-2.5 h-2.5" />
                  PROMO
                </span>
              )}
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                  m.source === 'antigravity'
                    ? 'bg-[var(--accent-sky-soft)] text-[var(--tool-antigravity)] border-[var(--accent-sky-border)]'
                    : m.source === 'claude'
                      ? 'bg-[var(--accent-violet-soft)] text-[var(--tool-claude)] border-[var(--accent-violet-border)]'
                      : 'bg-[var(--accent-amber-soft)] text-[var(--tool-codex)] border-[var(--accent-amber-border)]'
                }`}
              >
                {m.source === 'antigravity'
                  ? 'AGY'
                  : m.source === 'claude'
                    ? 'Claude'
                    : 'Codex'}
              </span>
            </div>
          </div>

          <div className="mt-2 flex items-baseline justify-between">
            <div>
              <span className="text-2xl font-bold font-mono tabular text-[var(--ink-primary)]">
                {formatTokens(m.tokens)}
              </span>
              <span className="text-[11px] text-[var(--ink-tertiary)] font-mono ml-1">tokens</span>
            </div>
            <span className="text-xs font-mono tabular text-[var(--ink-tertiary)]">{sharePct.toFixed(1)}%</span>
          </div>

          <div className="mt-1.5 flex items-center justify-between text-xs font-mono tabular">
            <span className="text-[var(--ink-tertiary)]">Total Spend:</span>
            <span className="font-semibold text-[var(--accent-teal)]">
              {formatMoney(m.costUSD, currency)}
            </span>
          </div>

          <div className="mt-2 h-1.5 w-full rounded-full bg-[var(--track-bg)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.max(4, sharePct)}%`,
                backgroundColor: barColor,
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 pt-2.5 border-t border-[var(--border-hairline)] text-[11px] font-mono tabular">
          <div>
            <span className="text-[var(--ink-tertiary)] block">Input</span>
            <span className="text-[var(--ink-primary)] font-medium">{formatTokens(m.inputTokens)}</span>
          </div>
          <div>
            <span className="text-[var(--ink-tertiary)] block">Cached</span>
            <span className="text-[var(--tool-antigravity)] font-medium">{formatTokens(m.cacheReadTokens)}</span>
          </div>
          <div>
            <span className="text-[var(--ink-tertiary)] block">Output</span>
            <span className="text-[var(--accent-amber)] font-medium">{formatTokens(m.outputTokens)}</span>
          </div>
        </div>

        {m.rate && (
          <div className="pt-2.5 border-t border-[var(--border-hairline)] flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px] font-mono">
              <span className="text-[var(--ink-tertiary)]">Rate per 1M tok:</span>
              {promoActive && (
                <span className="text-[10px] font-semibold text-[var(--accent-amber)] flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5" />
                  Promo Active
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-1.5 glass-control p-2 rounded-lg text-[10px] font-mono tabular">
              <div>
                <span className="text-[var(--ink-tertiary)] block text-[9px] uppercase tracking-wider">Input</span>
                <div className="flex items-baseline gap-1">
                  {promoActive && m.rate.standardInput && (
                    <span className="line-through text-[var(--ink-tertiary)] opacity-70 text-[9px]">
                      {formatRateMoney(m.rate.standardInput, currency)}
                    </span>
                  )}
                  <span className="text-[var(--ink-primary)] font-semibold">
                    {formatRateMoney(curInput, currency)}
                  </span>
                </div>
              </div>

              <div>
                <span className="text-[var(--ink-tertiary)] block text-[9px] uppercase tracking-wider">Cached</span>
                <span className="text-[var(--tool-antigravity)] font-semibold">
                  {formatRateMoney(curCache, currency)}
                </span>
              </div>

              <div>
                <span className="text-[var(--ink-tertiary)] block text-[9px] uppercase tracking-wider">Output</span>
                <div className="flex items-baseline gap-1">
                  {promoActive && m.rate.standardOutput && (
                    <span className="line-through text-[var(--ink-tertiary)] opacity-70 text-[9px]">
                      {formatRateMoney(m.rate.standardOutput, currency)}
                    </span>
                  )}
                  <span className="text-[var(--accent-amber)] font-semibold">
                    {formatRateMoney(curOutput, currency)}
                  </span>
                </div>
              </div>
            </div>

            {m.rate.longContext && (
              <div
                className="text-[10px] text-[var(--ink-secondary)] font-mono tabular flex items-center justify-between gap-1.5 glass-control px-2 py-1 rounded-md"
                title={`Requests exceeding ${(m.rate.longContext.thresholdTokens / 1000).toFixed(0)}k context tokens are billed at the long-context tier${m.longContextTurns > 0 ? ` (${m.longContextTurns} of ${m.turns} turns in this view)` : ''}`}
              >
                <span className="inline-flex items-center gap-1 shrink-0">
                  <span className="text-[var(--accent-sky)] font-semibold">
                    &gt;{(m.rate.longContext.thresholdTokens / 1000).toFixed(0)}k ctx:
                  </span>
                  {m.longContextTurns > 0 && (
                    <span className="px-1 py-0 rounded bg-[var(--accent-sky-soft)] border border-[var(--accent-sky-border)] text-[var(--accent-sky)] text-[9px] font-semibold">
                      {m.longContextTurns}t
                    </span>
                  )}
                </span>
                <span className="truncate">
                  <span className="text-[var(--ink-primary)]">{formatRateMoney(m.rate.longContext.input, currency)}</span>
                  <span className="text-[var(--ink-tertiary)] mx-1">/</span>
                  <span className="text-[var(--tool-antigravity)]">{formatRateMoney(m.rate.longContext.cacheRead, currency)}</span>
                  <span className="text-[var(--ink-tertiary)] mx-1">/</span>
                  <span className="text-[var(--accent-amber)]">{formatRateMoney(m.rate.longContext.output, currency)}</span>
                </span>
              </div>
            )}

            {promoActive && m.rate.promoNote && (
              <div className="text-[10px] text-[var(--accent-amber)] font-mono flex items-center gap-1">
                <span>●</span>
                <span className="truncate" title={m.rate.promoNote}>
                  {m.rate.promoNote}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const modelUsageHeaderContent = (
    <>
      <div className="flex items-start gap-2.5">
        {canCollapseModels && (
          <span className="mt-0.5 p-1 rounded group-hover:bg-[var(--table-hover)] text-[var(--ink-tertiary)] group-hover:text-[var(--ink-primary)] transition shrink-0">
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                isModelUsageExpanded ? 'rotate-90 text-[var(--accent-teal)]' : ''
              }`}
            />
          </span>
        )}
        <div>
          <h2 className="text-sm font-semibold text-[var(--ink-primary)] flex items-center gap-2">
            <Cpu className="w-4 h-4 text-[var(--accent-teal)]" />
            Total Token Usage by Model
          </h2>
          <p className="text-xs text-[var(--ink-tertiary)] mt-0.5">
            Complete token consumption breakdown (Input, Cache Read &amp; Output) per AI model
          </p>
        </div>
      </div>
      <div className={`text-xs font-mono tabular text-[var(--ink-tertiary)] ${canCollapseModels ? 'pl-7 sm:pl-0' : ''}`}>
        Total: <span className="text-[var(--ink-primary)] font-semibold">{formatTokens(analytics.totalTokens)}</span> tokens
      </div>
    </>
  );

  const renderSortTh = (
    label: string,
    field: WorkspaceSortField,
    align: 'left' | 'right' = 'right',
    className = 'py-2.5 px-2 xl:px-2.5'
  ) => {
    const isActive = sortBy === field;
    return (
      <th className={`${className} ${align === 'right' ? 'text-right' : 'text-left'}`}>
        <button
          type="button"
          onClick={() => handleSortField(field)}
          title={`Sort by ${label} (${isActive ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'click to sort'})`}
          className={`inline-flex items-center gap-1 uppercase font-mono transition-colors cursor-pointer select-none hover:text-[var(--ink-primary)] ${
            align === 'right' ? 'justify-end ml-auto' : ''
          } ${isActive ? 'text-[var(--accent-teal)] font-semibold' : 'text-[var(--ink-tertiary)]'}`}
        >
          <span>{label}</span>
          {isActive ? (
            sortDir === 'asc' ? (
              <ArrowUp className="w-3 h-3 shrink-0" />
            ) : (
              <ArrowDown className="w-3 h-3 shrink-0" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 opacity-45 shrink-0" />
          )}
        </button>
      </th>
    );
  };

  return (
    <div className="relative isolate min-h-screen text-[var(--ink-primary)] flex flex-col overflow-x-clip">
      <div className="scroll-progress-bar" aria-hidden="true" />
      <AmbientBackdrop />

      {/* Floating Liquid-Glass Top Navigation Bar */}
      <header className="dash-header animate-burn-header">
        <div
          ref={dashHeaderInnerRef}
          className="dash-header-inner max-w-7xl xl:max-w-[1440px] 2xl:max-w-[1600px] mx-auto px-3 sm:px-5 py-2.5 lg:py-2 flex flex-wrap lg:flex-nowrap items-center justify-between gap-x-2.5 xl:gap-x-3 gap-y-2"
        >
          {/* Brand & Live Status */}
          <div className="order-1 flex items-center gap-2.5 min-w-0 shrink-0 group">
            <img
              src="/logo.svg"
              alt="ai-burnrate-tool"
              className="h-8 w-8 rounded-lg border border-[var(--border-hairline)] shadow-sm shrink-0 transition-transform duration-200 group-hover:scale-105"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold tracking-tight text-[var(--ink-primary)] text-sm sm:text-[15px] whitespace-nowrap">
                  ai-burnrate-tool
                </span>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-mono font-semibold bg-[var(--accent-teal-soft)] text-[var(--accent-teal)] border border-[var(--accent-teal-border)] shrink-0">
                  <span className="relative flex h-2 w-2">
                    <span
                      className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                      style={{ backgroundColor: sseConnected ? 'var(--accent-teal)' : 'var(--accent-amber)' }}
                    />
                    <span
                      className="relative inline-flex rounded-full h-2 w-2"
                      style={{ backgroundColor: sseConnected ? 'var(--accent-teal)' : 'var(--accent-amber)' }}
                    />
                  </span>
                  {sseConnected ? 'LIVE' : 'SYNC'}
                </span>
              </div>
              <p
                className="text-[11px] text-[var(--ink-tertiary)] font-mono hidden xl:block max-w-[240px] 2xl:max-w-[360px] truncate"
                title={`Watching ${snapshot.watchedPaths.join(' & ')}`}
              >
                Watching {snapshot.watchedPaths.join(' & ')} {lastSyncTime && `• Synced ${lastSyncTime}`}
              </p>
            </div>
          </div>

          {/* Primary Filters: Tool, Time Range, Currency */}
          <div className="order-3 lg:order-2 w-full lg:w-auto lg:ml-auto flex flex-wrap lg:flex-nowrap items-center gap-1.5 sm:gap-2 shrink-0">
            {/* Tool Filter (with smooth sliding indicator) */}
            <div
              ref={toolGroupRef}
              className="relative inline-flex items-center gap-0.5 rounded-lg glass-control p-1 text-[11px] sm:text-xs shrink-0 select-none max-w-full"
            >
              {toolPill.ready && (
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute top-1 bottom-1 left-0 rounded-md border transition-[transform,width,background-color,border-color] duration-200 ease-out motion-reduce:transition-none ${
                    toolFilter === 'antigravity'
                      ? 'bg-[var(--accent-sky-soft)] border-[var(--accent-sky-border)]'
                      : toolFilter === 'claude'
                        ? 'bg-[var(--accent-violet-soft)] border-[var(--accent-violet-border)]'
                        : toolFilter === 'codex'
                          ? 'bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)]'
                          : 'bg-[var(--bg-surface)] border-[var(--border-strong)] shadow-sm'
                  }`}
                  style={{
                    width: `${toolPill.width}px`,
                    transform: `translateX(${toolPill.left}px)`,
                  }}
                />
              )}
              <button
                ref={(el) => {
                  toolBtnRefs.current.all = el;
                }}
                type="button"
                onClick={() => selectToolFilter('all')}
                className={`relative z-10 px-2 xl:px-2.5 py-1 rounded-md font-medium whitespace-nowrap border border-transparent transition-colors duration-200 cursor-pointer ${
                  toolFilter === 'all'
                    ? 'text-[var(--ink-primary)] font-semibold'
                    : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                }`}
              >
                All
              </button>
              <button
                ref={(el) => {
                  toolBtnRefs.current.antigravity = el;
                }}
                type="button"
                onClick={() => selectToolFilter('antigravity')}
                className={`relative z-10 px-2 xl:px-2.5 py-1 rounded-md font-medium whitespace-nowrap border border-transparent transition-colors duration-200 flex items-center gap-1.5 cursor-pointer ${
                  toolFilter === 'antigravity'
                    ? 'text-[var(--tool-antigravity)] font-semibold'
                    : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--tool-antigravity)' }} />
                <span>Antigravity</span>
              </button>
              <button
                ref={(el) => {
                  toolBtnRefs.current.claude = el;
                }}
                type="button"
                onClick={() => selectToolFilter('claude')}
                className={`relative z-10 px-2 xl:px-2.5 py-1 rounded-md font-medium whitespace-nowrap border border-transparent transition-colors duration-200 flex items-center gap-1.5 cursor-pointer ${
                  toolFilter === 'claude'
                    ? 'text-[var(--tool-claude)] font-semibold'
                    : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--tool-claude)' }} />
                <span>Claude</span>
              </button>
              <button
                ref={(el) => {
                  toolBtnRefs.current.codex = el;
                }}
                type="button"
                onClick={() => selectToolFilter('codex')}
                className={`relative z-10 px-2 xl:px-2.5 py-1 rounded-md font-medium whitespace-nowrap border border-transparent transition-colors duration-200 flex items-center gap-1.5 cursor-pointer ${
                  toolFilter === 'codex'
                    ? 'text-[var(--tool-codex)] font-semibold'
                    : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--tool-codex)' }} />
                <span>Codex</span>
              </button>
            </div>

            {/* Time Range Selector */}
            <div className="relative inline-grid grid-cols-4 rounded-lg glass-control p-1 text-[11px] sm:text-xs font-mono shrink-0 select-none">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1 bottom-1 left-1 w-[calc((100%-8px)/4)] rounded-md bg-[var(--accent-teal-soft)] border border-[var(--accent-teal-border)] transition-transform duration-200 ease-out motion-reduce:transition-none"
                style={{
                  transform: `translateX(${(['24h', '7d', '30d', 'all'] as TimeRange[]).indexOf(timeRange) * 100}%)`,
                }}
              />
              {(['24h', '7d', '30d', 'all'] as TimeRange[]).map((range) => (
                <button
                  type="button"
                  key={range}
                  onClick={() => selectTimeRange(range)}
                  className={`relative z-10 px-1.5 sm:px-2 xl:px-2.5 py-1 rounded-md uppercase font-medium whitespace-nowrap text-center transition-colors duration-200 cursor-pointer ${
                    timeRange === range
                      ? 'text-[var(--accent-teal)] font-semibold'
                      : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>

            {/* Currency Toggle ($ USD / € EUR) */}
            <div className="relative inline-grid grid-cols-2 rounded-lg glass-control p-1 text-[11px] sm:text-xs font-mono shrink-0 select-none">
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc((100%-8px)/2)] rounded-md bg-[var(--accent-teal-soft)] border border-[var(--accent-teal-border)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
                  currency === 'EUR' ? 'translate-x-full' : 'translate-x-0'
                }`}
              />
              <button
                type="button"
                onClick={() => toggleCurrency('USD')}
                className={`relative z-10 px-1.5 sm:px-2 py-1 min-w-[48px] sm:min-w-[52px] text-center rounded-md font-medium whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                  currency === 'USD'
                    ? 'text-[var(--accent-teal)] font-semibold'
                    : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                }`}
              >
                $ USD
              </button>
              <button
                type="button"
                onClick={() => toggleCurrency('EUR')}
                className={`relative z-10 px-1.5 sm:px-2 py-1 min-w-[48px] sm:min-w-[52px] text-center rounded-md font-medium whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                  currency === 'EUR'
                    ? 'text-[var(--accent-teal)] font-semibold'
                    : 'text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]'
                }`}
              >
                € EUR
              </button>
            </div>
          </div>

          {/* Utility Icon Actions: Theme, Settings & Rescan (Row 1 right on <lg, far right on lg+) */}
          <div className="order-2 lg:order-3 inline-flex items-center gap-1.5 shrink-0">
            {/* Two-State Light / Dark Theme Toggle (CSS-branched options) */}
            <button
              id="theme-toggle-btn"
              type="button"
              onClick={toggleColorScheme}
              title="Toggle light or dark theme"
              className="h-8 w-8 rounded-lg glass-control hover:border-[var(--border-strong)] text-xs font-mono text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] inline-flex items-center justify-center transition-colors duration-200 select-none shrink-0 cursor-pointer"
            >
              <span className="theme-opt-dark">
                <Moon className="w-3.5 h-3.5 text-[var(--ink-secondary)]" aria-hidden="true" />
                <span className="sr-only">Switch to dark theme</span>
              </span>
              <span className="theme-opt-light">
                <Sun className="w-3.5 h-3.5 text-[var(--accent-amber)]" aria-hidden="true" />
                <span className="sr-only">Switch to light theme</span>
              </span>
            </button>

            {/* Plans & Layout Settings */}
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              title="Subscription plans, dashboard layout & settings"
              aria-label="Open plans and layout settings"
              className="group h-8 w-8 rounded-lg glass-control hover:border-[var(--accent-teal-border)] text-[var(--ink-secondary)] hover:text-[var(--accent-teal)] inline-flex items-center justify-center transition-colors duration-200 select-none shrink-0 cursor-pointer"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>

            {/* Manual Rescan */}
            <button
              type="button"
              onClick={triggerManualRescan}
              title="Force Rescan Logs"
              aria-label="Force rescan logs"
              className="group h-8 w-8 rounded-lg glass-control hover:border-[var(--accent-teal-border)] text-[var(--ink-secondary)] hover:text-[var(--accent-teal)] inline-flex items-center justify-center transition-colors duration-200 select-none shrink-0 cursor-pointer"
            >
              <RefreshCw
                className={`w-4 h-4 ${
                  isRescanning
                    ? 'animate-spin text-[var(--accent-teal)]'
                    : 'transition-transform duration-300 group-hover:rotate-90 motion-reduce:transition-none'
                }`}
              />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl xl:max-w-[1440px] 2xl:max-w-[1600px] w-full mx-auto px-3 sm:px-6 py-4 sm:py-6 flex flex-col gap-4 sm:gap-5">
        {/* Live Event Banner if a file just updated */}
        {lastChangedFile && (
          <div
            style={{ order: -2 }}
            className="glass-panel rounded-xl px-3.5 py-2 flex items-center justify-between text-xs font-mono text-[var(--accent-teal)] border-[var(--accent-teal-border)] animate-burn-expand"
          >
            <span className="truncate">
              ● Live update received from: <span className="text-[var(--ink-primary)] font-medium">{lastChangedFile}</span>
            </span>
            <button
              type="button"
              onClick={() => setLastChangedFile(null)}
              className="text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)] ml-4 transition-colors cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Active Per-Tool Tracking Reset Banner */}
        {activeTrackingCutoffs.length > 0 && (
          <div
            style={{ order: -1 }}
            className="glass-panel rounded-xl px-3.5 py-2.5 flex flex-col gap-2 text-xs font-mono text-[var(--accent-amber)] border-[var(--accent-amber-border)] animate-burn-expand"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Clock className="w-3.5 h-3.5 text-[var(--accent-amber)] shrink-0" />
                <span className="truncate text-[var(--ink-secondary)]">
                  Tracking reset active:{' '}
                  {activeTrackingCutoffs.map((c, idx) => (
                    <span key={c.key}>
                      {idx > 0 ? ' · ' : ''}
                      <span className="text-[var(--ink-primary)] font-semibold">{c.label}</span> from {c.display}
                    </span>
                  ))}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    isBannerRestoreOpen
                      ? setIsBannerRestoreOpen(false)
                      : openBannerRestoreFromDate()
                  }
                  className={`px-2 py-0.5 rounded-md border text-[11px] transition-colors cursor-pointer ${
                    isBannerRestoreOpen
                      ? 'border-[var(--accent-amber)] bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] font-semibold'
                      : 'border-[var(--accent-amber-border)] bg-[var(--accent-amber-soft)] text-[var(--accent-amber)]'
                  }`}
                >
                  Restore from date
                </button>
                <button
                  type="button"
                  onClick={restoreVisibleTrackingCutoffs}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md glass-control hover:border-[var(--border-strong)] text-[11px] text-[var(--ink-primary)] transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  From beginning
                </button>
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  className="px-2 py-0.5 rounded-md glass-control hover:border-[var(--border-strong)] text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                >
                  Settings
                </button>
              </div>
            </div>

            {isBannerRestoreOpen && (
              <div className="pt-2 border-t border-[var(--border-hairline)] flex flex-wrap items-center gap-2">
                {activeTrackingCutoffs.length > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setBannerRestoreTarget('all')}
                      className={`px-2 py-1 rounded-md text-[10.5px] border transition-colors cursor-pointer ${
                        effectiveBannerRestoreTarget === 'all'
                          ? 'bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber)] font-semibold'
                          : 'glass-control text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]'
                      }`}
                    >
                      All ({activeTrackingCutoffs.length})
                    </button>
                    {activeTrackingCutoffs.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => {
                          setBannerRestoreTarget(c.key);
                          setBannerRestoreDate(toLocalDateTimeInput(c.iso));
                        }}
                        className={`px-2 py-1 rounded-md text-[10.5px] border transition-colors cursor-pointer ${
                          effectiveBannerRestoreTarget === c.key
                            ? 'bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber)] font-semibold'
                            : 'glass-control text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]'
                        }`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}

                <input
                  type="datetime-local"
                  step={1}
                  value={bannerRestoreDate}
                  onChange={(e) => setBannerRestoreDate(e.target.value)}
                  aria-label="Restore expenses starting from date"
                  className="glass-input h-7 px-2 rounded-md text-[11px] font-mono"
                />

                <div className="flex flex-wrap items-center gap-1">
                  {(
                    [
                      { id: 'today', label: 'Today' },
                      { id: '7d', label: '-7d' },
                      { id: '30d', label: '-30d' },
                      { id: 'month', label: 'Month start' },
                    ] as Array<{ id: 'today' | '7d' | '30d' | 'month'; label: string }>
                  ).map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setBannerRestoreDate(getQuickRestoreLocalInput(preset.id))}
                      className="px-2 py-1 rounded-md text-[10px] glass-control hover:border-[var(--border-strong)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5 ml-auto">
                  <button
                    type="button"
                    disabled={!bannerRestoreDate}
                    onClick={applyBannerRestoreFromDate}
                    className="btn-primary-brand h-7 px-2.5 rounded-md font-semibold text-[11px] transition-colors disabled:opacity-40 cursor-pointer"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsBannerRestoreOpen(false)}
                    className="h-7 px-2 rounded-md glass-control hover:border-[var(--border-strong)] text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 4 KPI Cards */}
        {!hiddenSections.has('kpis') && (
        <section
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-stretch animate-burn-fade-up"
          style={{ order: getSectionOrderIndex('kpis') }}
        >
          {/* Card 1: Estimated API Spend & Plan Comparison */}
          <div className="glass-panel glass-interactive rounded-2xl p-5 flex flex-col">
            <div className="flex items-center justify-between gap-2 mb-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-tertiary)]">
                API Equivalent Spend
              </span>
              <div className="p-2 rounded-xl bg-[var(--accent-teal-soft)] border border-[var(--accent-teal-border)] text-[var(--accent-teal)] shrink-0">
                <DollarSign className="w-4 h-4" />
              </div>
            </div>

            <div className="mb-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <div className="text-3xl font-bold font-mono tabular tracking-tight text-[var(--ink-primary)]">
                  {formatMoney(analytics.totalCostUSD, currency)}
                </div>
                {analytics.deltas && (
                  <DeltaPill deltaPct={analytics.deltas.costPct} label={analytics.deltas.label} />
                )}
              </div>
              {(toolFilter === 'all' ||
                (analytics.deletedCostUSD > 0 && userSettings.includeDeletedInTotals)) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[var(--ink-tertiary)]">
                  {toolFilter === 'all' && (
                    <>
                      <span className="text-[var(--tool-antigravity)] font-mono tabular font-medium whitespace-nowrap">
                        AGY {formatMoney(analytics.antigravityCost, currency)}
                      </span>
                      <span className="text-[var(--tool-claude)] font-mono tabular font-medium whitespace-nowrap">
                        Claude {formatMoney(analytics.claudeCost, currency)}
                      </span>
                      <span className="text-[var(--tool-codex)] font-mono tabular font-medium whitespace-nowrap">
                        Codex {formatMoney(analytics.codexCost, currency)}
                      </span>
                    </>
                  )}
                  {analytics.deletedCostUSD > 0 && userSettings.includeDeletedInTotals && (
                    <button
                      type="button"
                      onClick={() => setIsDeletedModalOpen(true)}
                      title="View deleted chats included in total API spend"
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--accent-rose-soft)] text-[var(--accent-rose)] border border-[var(--accent-rose-border)] hover:brightness-110 font-mono text-[10px] transition-all cursor-pointer"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                      incl. {formatMoney(analytics.deletedCostUSD, currency)} deleted
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="mt-auto space-y-1.5 pt-3 border-t border-[var(--border-hairline)] min-h-[68px] flex flex-col justify-center">
              <div className="flex items-center justify-between text-xs gap-2">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  title={`Includes ${taxLabel} · Customize your monthly subscription plans & dashboard layout`}
                  className="text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] underline decoration-dotted underline-offset-2 transition-colors cursor-pointer text-left truncate"
                >
                  vs {formatSubscriptionMoney(analytics.referenceSubUSD, currency)}/mo Plan
                </button>
                <span className="font-mono tabular font-semibold text-[var(--accent-teal)] shrink-0">
                  {analytics.referenceSubUSD > 0 ? `${subMultiplier}x value` : 'Pay-as-you-go'}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-[var(--track-bg)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.max(4, subPercentage)}%`,
                    background: 'linear-gradient(90deg, var(--accent-teal) 0%, var(--tool-antigravity) 100%)',
                  }}
                />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1 pt-0.5 text-[10.5px] font-mono tabular">
                <span className="text-[var(--ink-tertiary)]">
                  Today {formatMoney(analytics.projection.todayUSD, currency)}
                </span>
              </div>
            </div>
          </div>

          {/* Card 2: Total Tokens */}
          <div className="glass-panel glass-interactive rounded-2xl p-5 flex flex-col">
            <div className="flex items-center justify-between gap-2 mb-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-tertiary)]">
                Total Tokens
              </span>
              <div className="p-2 rounded-xl bg-[var(--accent-sky-soft)] border border-[var(--accent-sky-border)] text-[var(--tool-antigravity)] shrink-0">
                <Cpu className="w-4 h-4" />
              </div>
            </div>

            <div className="mb-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <div className="text-3xl font-bold font-mono tabular tracking-tight text-[var(--ink-primary)]">
                  {formatTokens(analytics.totalTokens)}
                </div>
                {analytics.deltas && (
                  <DeltaPill deltaPct={analytics.deltas.tokensPct} label={analytics.deltas.label} />
                )}
              </div>
              <div className="mt-1.5 text-xs text-[var(--ink-tertiary)] font-mono tabular">
                Across {analytics.totalTurns.toLocaleString()} LLM turns
              </div>
            </div>

            <div className="mt-auto grid grid-cols-3 gap-2 pt-3 border-t border-[var(--border-hairline)] min-h-[68px] items-center text-[11px] font-mono tabular">
              <div>
                <span className="text-[var(--ink-tertiary)] block">Input</span>
                <span className="text-[var(--ink-primary)] font-medium">{formatTokens(analytics.totalInputTokens)}</span>
              </div>
              <div>
                <span className="text-[var(--ink-tertiary)] block">Output</span>
                <span className="text-[var(--ink-primary)] font-medium">{formatTokens(analytics.totalOutputTokens)}</span>
              </div>
              <div>
                <span className="text-[var(--ink-tertiary)] block">Cached</span>
                <span className="text-[var(--tool-antigravity)] font-medium">{formatTokens(analytics.totalCacheReadTokens)}</span>
              </div>
            </div>
          </div>

          {/* Card 3: Prompt Cache Savings */}
          <div className="glass-panel glass-interactive rounded-2xl p-5 flex flex-col">
            <div className="flex items-center justify-between gap-2 mb-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-tertiary)]">
                Cache Savings
              </span>
              <div className="p-2 rounded-xl bg-[var(--accent-violet-soft)] border border-[var(--accent-violet-border)] text-[var(--tool-claude)] shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
            </div>

            <div className="mb-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <div className="text-3xl font-bold font-mono tabular tracking-tight text-[var(--tool-claude)]">
                  {formatMoney(analytics.totalCacheSavingsUSD, currency)}
                </div>
                {analytics.deltas && (
                  <DeltaPill deltaPct={analytics.deltas.savingsPct} label={analytics.deltas.label} higherIsBetter />
                )}
              </div>
              <div className="mt-1.5 text-xs text-[var(--ink-tertiary)]">
                Saved via context caching
              </div>
            </div>

            <div className="mt-auto space-y-1.5 pt-3 border-t border-[var(--border-hairline)] min-h-[68px] flex flex-col justify-center">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--ink-secondary)]">Cache Hit Ratio</span>
                <span className="font-mono tabular font-semibold text-[var(--tool-claude)]">
                  {analytics.cacheHitRate.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-[var(--track-bg)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(100, Math.max(3, analytics.cacheHitRate))}%`,
                    background: 'linear-gradient(90deg, var(--tool-claude) 0%, var(--tool-antigravity) 100%)',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Card 4: Active Sessions & Workspaces */}
          <div className="glass-panel glass-interactive rounded-2xl p-5 flex flex-col">
            <div className="flex items-center justify-between gap-2 mb-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-tertiary)]">
                Sessions &amp; Projects
              </span>
              <div className="p-2 rounded-xl bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] text-[var(--accent-amber)] shrink-0">
                <Layers className="w-4 h-4" />
              </div>
            </div>

            <div className="mb-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-3xl font-bold font-mono tabular tracking-tight text-[var(--ink-primary)]">
                  {analytics.totalSessionsCount}
                </span>
                {analytics.deletedSessionsCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setIsDeletedModalOpen(true)}
                    title="View deleted chats archive"
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--accent-rose-soft)] text-[var(--accent-rose)] border border-[var(--accent-rose-border)] hover:brightness-110 font-mono text-[10px] transition-all cursor-pointer"
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                    +{analytics.deletedSessionsCount} deleted
                  </button>
                )}
                {analytics.deltas && (
                  <DeltaPill deltaPct={analytics.deltas.turnsPct} label={`${analytics.deltas.label} turns`} />
                )}
              </div>
              <div className="mt-1.5 text-xs text-[var(--ink-tertiary)]">
                Active in {analytics.workspacesCount} distinct workspaces
              </div>
            </div>

            <div className="mt-auto flex items-center justify-between pt-3 border-t border-[var(--border-hairline)] min-h-[68px] text-xs font-mono tabular">
              <span className="text-[var(--ink-secondary)]">Avg Cost / Session</span>
              <span className="text-[var(--accent-flame)] font-semibold">
                {formatMoney(
                  analytics.totalAllSessionsCount > 0
                    ? analytics.totalCostUSD / analytics.totalAllSessionsCount
                    : 0,
                  currency
                )}
              </span>
            </div>
          </div>
        </section>
        )}

        {/* Charts Row */}
        {!hiddenSections.has('charts') && (
        <section
          className="grid grid-cols-1 lg:grid-cols-3 gap-5 animate-burn-fade-up"
          style={{ order: getSectionOrderIndex('charts'), animationDelay: '50ms' }}
        >
          {/* Daily Burn Rate Timeline (2 cols) */}
          <div className="lg:col-span-2 glass-panel rounded-2xl p-5 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-[var(--ink-primary)] flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-[var(--accent-teal)]" />
                  Daily API Burn Rate ({currency})
                </h2>
                <p className="text-xs text-[var(--ink-tertiary)] mt-0.5">
                  {toolFilter === 'all'
                    ? 'Independent equivalent API spend curves across Antigravity, Claude Code & Codex CLI'
                    : `Equivalent API spend over time for ${
                        toolFilter === 'antigravity'
                          ? 'Antigravity CLI'
                          : toolFilter === 'claude'
                            ? 'Claude Code'
                            : 'Codex CLI'
                      }`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
                {(toolFilter === 'all' || toolFilter === 'antigravity') && (
                  <span className="flex items-center gap-1.5 text-[var(--tool-antigravity)] font-medium">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--tool-antigravity)' }} /> Antigravity
                  </span>
                )}
                {(toolFilter === 'all' || toolFilter === 'claude') && (
                  <span className="flex items-center gap-1.5 text-[var(--tool-claude)] font-medium">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--tool-claude)' }} /> Claude Code
                  </span>
                )}
                {(toolFilter === 'all' || toolFilter === 'codex') && (
                  <span className="flex items-center gap-1.5 text-[var(--tool-codex)] font-medium">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--tool-codex)' }} /> Codex CLI
                  </span>
                )}
              </div>
            </div>

            <div className="h-64 w-full">
              {analytics.timelineData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--ink-tertiary)] font-mono">
                  No activity recorded for this filter window.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={analytics.timelineData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorAgy" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--tool-antigravity)" stopOpacity={0.32} />
                        <stop offset="95%" stopColor="var(--tool-antigravity)" stopOpacity={0.0} />
                      </linearGradient>
                      <linearGradient id="colorClaude" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--tool-claude)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--tool-claude)" stopOpacity={0.0} />
                      </linearGradient>
                      <linearGradient id="colorCodex" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--tool-codex)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--tool-codex)" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      stroke="var(--ink-tertiary)"
                      tick={{ fill: 'var(--ink-tertiary)', fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="var(--ink-tertiary)"
                      tick={{ fill: 'var(--ink-tertiary)', fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `${currencySymbol}${(Number(v) * rateMultiplier).toFixed(0)}`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--bg-tooltip)',
                        borderColor: 'var(--border-strong)',
                        borderRadius: '0.75rem',
                        fontSize: '12px',
                        fontFamily: '"JetBrains Mono", monospace',
                        color: 'var(--ink-primary)',
                        boxShadow: '0 12px 28px -8px var(--header-shadow)',
                      }}
                      labelStyle={{ color: 'var(--ink-primary)', fontWeight: 600, marginBottom: '2px' }}
                      formatter={(val: number, name: string) => [
                        formatMoney(Number(val), currency),
                        name === 'antigravityUSD'
                          ? 'Antigravity CLI'
                          : name === 'claudeUSD'
                            ? 'Claude Code'
                            : 'Codex CLI',
                      ]}
                    />
                    {(toolFilter === 'all' || toolFilter === 'antigravity') && (
                      <Area
                        type="monotone"
                        dataKey="antigravityUSD"
                        stroke="var(--tool-antigravity)"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorAgy)"
                      />
                    )}
                    {(toolFilter === 'all' || toolFilter === 'claude') && (
                      <Area
                        type="monotone"
                        dataKey="claudeUSD"
                        stroke="var(--tool-claude)"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorClaude)"
                      />
                    )}
                    {(toolFilter === 'all' || toolFilter === 'codex') && (
                      <Area
                        type="monotone"
                        dataKey="codexUSD"
                        stroke="var(--tool-codex)"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorCodex)"
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Model Spend Breakdown (1 col) */}
          <div className="glass-panel rounded-2xl p-5 flex flex-col">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-[var(--ink-primary)] flex items-center gap-2">
                <Database className="w-4 h-4 text-[var(--tool-antigravity)]" />
                Cost by Model ({currency})
              </h2>
              <p className="text-xs text-[var(--ink-tertiary)] mt-0.5">
                Distribution across Gemini, Claude &amp; Codex models
              </p>
            </div>

            <div className="h-64 w-full overflow-y-auto overflow-x-hidden pr-1">
              {analytics.modelData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--ink-tertiary)] font-mono">
                  No model usage data available.
                </div>
              ) : (
                <div style={{ height: Math.max(256, analytics.modelData.length * 36), width: '100%' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={analytics.modelData}
                      layout="vertical"
                      margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" horizontal={false} />
                      <XAxis
                        type="number"
                        stroke="var(--ink-tertiary)"
                        tick={{ fill: 'var(--ink-tertiary)', fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => `${currencySymbol}${(Number(v) * rateMultiplier).toFixed(0)}`}
                      />
                      <YAxis
                        type="category"
                        dataKey="model"
                        interval={0}
                        stroke="var(--ink-secondary)"
                        tick={{ fill: 'var(--ink-secondary)', fontSize: 11 }}
                        width={115}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip
                        cursor={{ fill: 'var(--chart-cursor)' }}
                        contentStyle={{
                          backgroundColor: 'var(--bg-tooltip)',
                          borderColor: 'var(--border-strong)',
                          borderRadius: '0.75rem',
                          fontSize: '12px',
                          fontFamily: '"JetBrains Mono", monospace',
                          color: 'var(--ink-primary)',
                          boxShadow: '0 12px 28px -8px var(--header-shadow)',
                        }}
                        labelStyle={{ color: 'var(--ink-primary)', fontWeight: 600, marginBottom: '2px' }}
                        itemStyle={{ color: 'var(--accent-teal)' }}
                        formatter={(val: number) => [formatMoney(Number(val), currency), 'API Spend']}
                      />
                      <Bar dataKey="costUSD" radius={[0, 6, 6, 0]} barSize={20} minPointSize={3}>
                        {analytics.modelData.map((_, idx) => (
                          <Cell key={idx} fill={MODEL_COLORS[idx % MODEL_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>
        </section>
        )}

        {/* Central Widget: Total Token Usage per Model */}
        {!hiddenSections.has('modelUsage') && (
        <section
          className="glass-panel rounded-2xl overflow-hidden animate-burn-fade-up"
          style={{ order: getSectionOrderIndex('modelUsage'), animationDelay: '90ms' }}
        >
          {canCollapseModels ? (
            <button
              type="button"
              onClick={toggleModelUsageExpanded}
              aria-expanded={isModelUsageExpanded}
              title={isModelUsageExpanded ? 'Collapse extra models' : `Show all ${sortedModels.length} models`}
              className={`w-full px-5 py-4 flex flex-wrap items-center justify-between gap-3 text-left hover:bg-[var(--table-hover)] transition-colors cursor-pointer select-none group ${
                isModelUsageExpanded ? 'bg-[var(--bg-elevated)]' : ''
              }`}
            >
              {modelUsageHeaderContent}
            </button>
          ) : (
            <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-3">
              {modelUsageHeaderContent}
            </div>
          )}

          <div className="px-5 pb-5 pt-4 border-t border-[var(--border-hairline)]">
            {sortedModels.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--ink-tertiary)] font-mono">
                No model token data available.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {topModels.map((m, idx) => renderModelCard(m, idx))}
                </div>

                {canCollapseModels && (
                  <>
                    <div
                      aria-hidden={isModelUsageExpanded}
                      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                        isModelUsageExpanded
                          ? 'grid-rows-[0fr] opacity-0 pointer-events-none'
                          : 'grid-rows-[1fr] opacity-100'
                      }`}
                    >
                      <div className="overflow-hidden min-h-0">
                        <button
                          type="button"
                          onClick={toggleModelUsageExpanded}
                          className="mt-3 w-full py-2 px-3 rounded-xl border border-dashed border-[var(--border-hairline)] bg-[var(--bg-subcard)] hover:bg-[var(--table-hover)] hover:border-[var(--border-strong)] text-xs font-mono text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] flex items-center justify-center gap-2 transition-colors cursor-pointer select-none"
                        >
                          <span>
                            +{extraModels.length} more {extraModels.length === 1 ? 'model' : 'models'} collapsed · Click to view all {sortedModels.length}
                          </span>
                          <ChevronRight className="w-3.5 h-3.5 text-[var(--ink-tertiary)]" />
                        </button>
                      </div>
                    </div>

                    <div
                      aria-hidden={!isModelUsageExpanded}
                      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                        isModelUsageExpanded
                          ? 'grid-rows-[1fr] opacity-100'
                          : 'grid-rows-[0fr] opacity-0 pointer-events-none'
                      }`}
                    >
                      <div className="overflow-hidden min-h-0">
                        <div className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                          {extraModels.map((m, idx) => renderModelCard(m, idx + 2))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </section>
        )}

        {/* Activity Heatmap & Top Workspaces */}
        {!hiddenSections.has('heatmapWorkspaces') && (
          <div style={{ order: getSectionOrderIndex('heatmapWorkspaces') }}>
            <HeatmapAndWorkspaces
              heatmapDays={analytics.heatmapDays}
              topWorkspaces={analytics.topWorkspaces}
              currency={currency}
              onSelectWorkspace={(wsName) => setSearchQuery(wsName)}
            />
          </div>
        )}

        {/* Live Sessions / Workspaces Table */}
        {!hiddenSections.has('sessions') && (
        <section
          className="glass-panel-overflow rounded-2xl animate-burn-fade-up"
          style={{ order: getSectionOrderIndex('sessions'), animationDelay: '130ms' }}
        >
          <div className="relative z-20 p-4 sm:p-5 border-b border-[var(--border-hairline)] rounded-t-2xl flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--ink-primary)] flex items-center gap-2">
                <Activity className="w-4 h-4 text-[var(--accent-teal)]" />
                Live Sessions &amp; Workspaces
              </h2>
              <div className="text-xs text-[var(--ink-tertiary)] mt-0.5 flex flex-wrap items-center gap-1.5">
                <span>
                  Real-time telemetry grouped by workspace ({tableData.workspaces.length} workspaces · {tableData.chatsCount} chats)
                </span>
                {hasTableFilters && (
                  <>
                    <span className="px-1.5 py-0.5 rounded bg-[var(--accent-teal-soft)] text-[var(--accent-teal)] border border-[var(--accent-teal-border)] text-[10px] font-mono">
                      filtered
                    </span>
                    <button
                      type="button"
                      onClick={resetTableFilters}
                      className="text-[10px] font-mono text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] underline underline-offset-2 cursor-pointer"
                    >
                      Reset filters
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Search, Model Filter, Sort & Export */}
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              <div className="relative flex-1 min-w-[180px] sm:w-56">
                <Search className="w-3.5 h-3.5 text-[var(--ink-tertiary)] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter workspace, chat, model..."
                  className="glass-input w-full h-8 pl-8 pr-7 rounded-lg text-xs font-mono transition-colors"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)] cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <FilterDropdown
                value={activeModelFilter}
                options={[
                  { value: 'all', label: 'All models' },
                  ...analytics.availableModels.map((modelName) => ({
                    value: modelName,
                    label: modelName,
                  })),
                ]}
                onChange={(nextModel) => setTableModelFilter(nextModel)}
                ariaLabel="Filter by model"
                title="Filter workspaces and chats by model"
                maxWidthClass="max-w-[180px]"
                menuAlign="left"
              />

              <div className="inline-flex items-stretch h-8 rounded-lg glass-control hover:border-[var(--border-strong)] focus-within:border-[var(--accent-teal)] transition-colors shrink-0">
                <FilterDropdown
                  value={sortBy}
                  options={SORT_OPTIONS}
                  onChange={(nextField) => {
                    setSortBy(nextField);
                    setSortDir(TEXT_SORT_FIELDS.has(nextField) ? 'asc' : 'desc');
                  }}
                  ariaLabel="Sort workspaces by"
                  title="Sort workspaces and chats"
                  prefixLabel="Sort:"
                  attachedLeft
                  maxWidthClass="max-w-[190px]"
                />
                <button
                  type="button"
                  onClick={() => setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                  aria-label={`Sort direction ${sortDir === 'desc' ? 'descending' : 'ascending'}`}
                  title={sortDir === 'desc' ? 'Descending (click for ascending)' : 'Ascending (click for descending)'}
                  className="h-full w-8 border-l border-[var(--border-hairline)] hover:bg-[var(--table-hover)] rounded-r-lg text-[var(--accent-teal)] flex items-center justify-center transition-colors cursor-pointer select-none"
                >
                  {sortDir === 'asc' ? (
                    <ArrowUp className="w-3.5 h-3.5" />
                  ) : (
                    <ArrowDown className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsDeletedModalOpen(true)}
                  title="Inspect deleted chats and their preserved API cost"
                  className={`h-8 px-2.5 rounded-lg border text-xs font-mono flex items-center gap-1.5 transition-colors cursor-pointer select-none ${
                    analytics.deletedSessionsCount > 0
                      ? 'bg-[var(--accent-rose-soft)] border-[var(--accent-rose-border)] text-[var(--accent-rose)] hover:brightness-110'
                      : 'glass-control text-[var(--ink-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--ink-primary)]'
                  }`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Deleted</span>
                  <span
                    className={`px-1 rounded text-[10px] tabular ${
                      analytics.deletedSessionsCount > 0
                        ? 'bg-[var(--accent-rose-soft)] text-[var(--accent-rose)] font-semibold'
                        : 'bg-[var(--track-bg)] text-[var(--ink-secondary)]'
                    }`}
                  >
                    {analytics.deletedSessionsCount}
                  </span>
                  {analytics.deletedCostUSD > 0 && (
                    <span className="text-[10px] text-[var(--accent-teal)] font-semibold hidden sm:inline tabular">
                      {formatMoney(analytics.deletedCostUSD, currency)}
                    </span>
                  )}
                </button>
                {(['csv', 'json'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    disabled={tableData.workspaces.length === 0}
                    onClick={() => exportReport(fmt)}
                    title={`Export ${hasTableFilters ? 'filtered & sorted' : 'sorted'} report (${tableData.workspaces.length} workspaces, ${currency}) as ${fmt.toUpperCase()}`}
                    className="h-8 px-2.5 rounded-lg glass-control hover:border-[var(--border-strong)] hover:bg-[var(--table-hover)] text-xs font-mono text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] flex items-center gap-1.5 transition-colors cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Download className="w-3.5 h-3.5 text-[var(--accent-teal)]" />
                    <span>{fmt.toUpperCase()}</span>
                    {hasTableFilters && (
                      <span className="text-[10px] text-[var(--accent-teal)] tabular">
                        ({tableData.workspaces.length})
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-b-2xl">
            <table className="w-full text-left border-collapse min-w-[1020px] xl:min-w-0">
              <thead>
                <tr className="border-b border-[var(--border-hairline)] text-[10px] xl:text-[11px] font-mono uppercase text-[var(--ink-tertiary)] bg-[var(--table-head)]">
                  <th className="py-2.5 px-2 w-7 sm:w-8 text-center"></th>
                  {renderSortTh('Tool', 'tool', 'left', 'py-2.5 px-2 xl:px-3')}
                  {renderSortTh('Workspace Folder', 'workspaceName', 'left', 'py-2.5 px-2 xl:px-3')}
                  {renderSortTh('Primary Model', 'primaryModelLabel', 'left', 'py-2.5 px-2 xl:px-3')}
                  {renderSortTh('Turns', 'turns', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Input / Output', 'ioTokens', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Cache Read', 'cacheReadTokens', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Total Tokens', 'totalTokens', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Cache Saved', 'cacheSavingsUSD', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('API Cost', 'costUSD', 'right', 'py-2.5 px-2 xl:px-3')}
                  {renderSortTh('Created', 'startedAt', 'right', 'py-2.5 px-2 xl:px-2.5')}
                  {renderSortTh('Last Modified', 'lastActiveAt', 'right', 'py-2.5 px-2 xl:px-3')}
                </tr>
              </thead>
              {tableData.workspaces.slice(0, 60).map((ws) => {
                const isExpanded = expandedWorkspaces.has(ws.workspaceKey);

                return (
                  <tbody
                    key={ws.workspaceKey}
                    className="text-xs border-b border-[var(--border-hairline)] last:border-b-0"
                  >
                    <tr
                      onClick={() => toggleSetKey(setExpandedWorkspaces, ws.workspaceKey)}
                      className={`hover:bg-[var(--table-hover)] transition-colors group cursor-pointer ${
                        isExpanded ? 'bg-[var(--table-hover)]' : ''
                      }`}
                    >
                      <td className="py-2.5 px-2 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSetKey(setExpandedWorkspaces, ws.workspaceKey);
                          }}
                          className="p-1 rounded hover:bg-[var(--table-hover)] text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)] transition select-none"
                          title={isExpanded ? 'Collapse workspace chats' : 'Expand workspace chats'}
                        >
                          <ChevronRight
                            className={`w-3.5 h-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                              isExpanded ? 'rotate-90 text-[var(--accent-teal)]' : ''
                            }`}
                          />
                        </button>
                      </td>

                      <td className="py-2.5 px-2 xl:px-3 whitespace-nowrap">
                        <div className="flex flex-wrap items-center gap-1">
                          {ws.sources.map((src) => (
                            <ToolBadge key={src} source={src} compact={ws.sources.length > 1} />
                          ))}
                        </div>
                      </td>

                      <td className="py-2.5 px-2 xl:px-3">
                        <div className="flex items-center gap-1.5 font-medium text-[var(--ink-primary)]">
                          <FolderGit2 className="w-3.5 h-3.5 text-[var(--ink-tertiary)] shrink-0" />
                          <span
                            className="truncate max-w-[120px] sm:max-w-[150px] lg:max-w-[180px] xl:max-w-[220px]"
                            title={ws.workspace}
                          >
                            {ws.workspaceName}
                          </span>
                        </div>
                        <div className="text-[10.5px] text-[var(--ink-tertiary)] font-mono flex items-center gap-1.5 mt-0.5">
                          <span>
                            {ws.chats.length} {ws.chats.length === 1 ? 'chat' : 'chats'}
                          </span>
                          <span className="opacity-70 hidden xl:inline truncate max-w-[160px]" title={ws.workspace}>
                            · {ws.workspace}
                          </span>
                        </div>
                      </td>

                      <td className="py-2.5 px-2 xl:px-3 whitespace-nowrap font-mono text-[11px] xl:text-xs text-[var(--ink-secondary)]">
                        <div className="inline-flex items-center gap-1.5">
                          <span>{ws.primaryModelLabel}</span>
                          {ws.distinctModels.length > 1 && (
                            <span
                              className="px-1.5 py-0.5 rounded glass-control text-[var(--ink-tertiary)] text-[10px]"
                              title={ws.distinctModels.join(', ')}
                            >
                              +{ws.distinctModels.length - 1}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-2.5 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono tabular text-[var(--ink-secondary)] text-[11px] xl:text-xs">
                        {ws.turns}
                      </td>

                      <td className="py-2.5 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono tabular text-[var(--ink-tertiary)] text-[11px] xl:text-xs">
                        <span className="text-[var(--ink-primary)]">{formatTokens(ws.inputTokens)}</span>
                        <span className="mx-0.5">/</span>
                        <span className="text-[var(--ink-secondary)]">{formatTokens(ws.outputTokens)}</span>
                      </td>

                      <td className="py-2.5 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono tabular text-[var(--tool-antigravity)] text-[11px] xl:text-xs">
                        {formatTokens(ws.cacheReadTokens)}
                      </td>

                      <td className="py-2.5 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono tabular font-medium text-[var(--ink-primary)] text-[11px] xl:text-xs">
                        {formatTokens(ws.totalTokens)}
                      </td>

                      <td className="py-2.5 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono tabular text-[var(--tool-claude)] text-[11px] xl:text-xs">
                        {formatMoney(ws.cacheSavingsUSD, currency)}
                      </td>

                      <td className="py-2.5 px-2 xl:px-3 whitespace-nowrap text-right font-mono tabular font-semibold text-[var(--accent-teal)] text-[11px] xl:text-xs">
                        {formatMoney(ws.costUSD, currency)}
                      </td>

                      <td className="py-2.5 px-2 xl:px-2.5 whitespace-nowrap text-right font-mono tabular text-[11px] xl:text-xs">
                        <div className="text-[var(--ink-primary)]">{formatPreciseDateTime(ws.startedAt).date}</div>
                        <div className="text-[10px] text-[var(--ink-tertiary)]">{formatPreciseDateTime(ws.startedAt).time}</div>
                      </td>

                      <td className="py-2.5 px-2 xl:px-3 whitespace-nowrap text-right font-mono tabular text-[11px] xl:text-xs">
                        <div className="text-[var(--ink-primary)]">{formatPreciseDateTime(ws.lastActiveAt).date}</div>
                        <div
                          className="text-[10px] text-[var(--accent-teal)] flex items-center justify-end gap-1"
                          title={formatRelativeTime(ws.lastActiveAt)}
                        >
                          <span>{formatPreciseDateTime(ws.lastActiveAt).time}</span>
                          <span className="text-[var(--ink-tertiary)] hidden xl:inline">
                            ({formatRelativeTime(ws.lastActiveAt)})
                          </span>
                        </div>
                      </td>
                    </tr>

                    <tr
                      aria-hidden={!isExpanded}
                      className={
                        isExpanded
                          ? 'bg-[var(--bg-subcard)] border-t border-[var(--border-hairline)]'
                          : 'pointer-events-none'
                      }
                    >
                      <td
                        colSpan={12}
                        className={`transition-[padding] duration-200 ease-out motion-reduce:transition-none ${
                          isExpanded ? 'px-3 py-3 sm:px-4 sm:py-3.5' : 'p-0 text-[0px] leading-[0]'
                        }`}
                      >
                        <div
                          className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                            isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                          }`}
                        >
                          <div className="overflow-hidden min-h-0 text-xs leading-normal">
                            <div className="glass-subcard rounded-xl p-3 sm:p-4 space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold text-[var(--ink-primary)] flex items-center gap-2">
                                    <MessageSquare className="w-4 h-4 text-[var(--accent-teal)]" />
                                    Workspace Chats ({ws.chats.length})
                                  </span>
                                  <span className="text-[11px] font-mono text-[var(--ink-tertiary)]">{ws.workspace}</span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono tabular text-[var(--ink-tertiary)]">
                                  <span>
                                    Created:{' '}
                                    <span className="text-[var(--ink-primary)]">
                                      {formatPreciseDateTime(ws.startedAt).date}{' '}
                                      {formatPreciseDateTime(ws.startedAt).time}
                                    </span>
                                  </span>
                                  <span>•</span>
                                  <span>
                                    Last modified:{' '}
                                    <span className="text-[var(--accent-teal)] font-medium">
                                      {formatPreciseDateTime(ws.lastActiveAt).date}{' '}
                                      {formatPreciseDateTime(ws.lastActiveAt).time}
                                    </span>
                                  </span>
                                </div>
                              </div>

                              <div className="space-y-2.5">
                                {ws.chats.map((chat) => {
                                  const chatKey = `${chat.source}-${chat.filePath}`;
                                  const isChatExpanded = expandedChats.has(chatKey);
                                  const chatModels = getSessionModelBreakdown(chat.turnHistory);
                                  const subagentSummary = getSessionSubagentBreakdown(chat.turnHistory);
                                  const created = formatPreciseDateTime(chat.startedAt);
                                  const modified = formatPreciseDateTime(chat.lastActiveAt);

                                  return (
                                    <div
                                      key={chatKey}
                                      className="glass-control rounded-xl overflow-hidden transition-colors duration-150 hover:border-[var(--border-strong)]"
                                    >
                                      <div
                                        onClick={() => toggleSetKey(setExpandedChats, chatKey)}
                                        className="p-3 hover:bg-[var(--table-hover)] transition-colors cursor-pointer space-y-2"
                                      >
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                toggleSetKey(setExpandedChats, chatKey);
                                              }}
                                              className="p-0.5 rounded hover:bg-[var(--table-hover)] text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)] transition shrink-0 select-none"
                                              title={
                                                isChatExpanded
                                                  ? 'Hide detailed model & subagent metrics'
                                                  : 'Show detailed model & subagent metrics'
                                              }
                                            >
                                              <ChevronRight
                                                className={`w-3.5 h-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                                                  isChatExpanded ? 'rotate-90 text-[var(--accent-teal)]' : ''
                                                }`}
                                              />
                                            </button>

                                            <ToolBadge source={chat.source} compact />

                                            <span
                                              className="text-xs font-medium text-[var(--ink-primary)] truncate max-w-[240px] sm:max-w-[380px] lg:max-w-[480px]"
                                              title={`${chat.sessionTitle || chat.sessionId} (${chat.sessionId})`}
                                            >
                                              {chat.sessionTitle || chat.sessionId}
                                            </span>

                                            {(() => {
                                              const regularSubs = subagentSummary.subagents.filter(
                                                (s) => s.subagentName !== '/btw'
                                              );
                                              const btwEntry = subagentSummary.subagents.find(
                                                (s) => s.subagentName === '/btw'
                                              );
                                              return (
                                                <>
                                                  {regularSubs.length > 0 && (
                                                    <span
                                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--accent-violet-soft)] border border-[var(--accent-violet-border)] text-[10px] font-mono text-[var(--accent-violet)] shrink-0"
                                                      title={`Includes ${regularSubs.length} rolled-up subagent tool(s): ${regularSubs.map((s) => s.subagentName).join(', ')}`}
                                                    >
                                                      <Bot className="w-2.5 h-2.5 shrink-0" />
                                                      +{regularSubs.length}{' '}
                                                      {regularSubs.length === 1 ? 'subagent' : 'subagents'}
                                                    </span>
                                                  )}
                                                  {btwEntry && (
                                                    <button
                                                      type="button"
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        toggleSetKey(setExpandedBtwRows, `${chatKey}::/btw`);
                                                      }}
                                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--accent-sky-soft)] hover:brightness-110 border border-[var(--accent-sky-border)] text-[10px] font-mono text-[var(--accent-sky)] shrink-0 transition-all cursor-pointer"
                                                      title={`Click to show /btw titles (${btwEntry.runs?.length || 1} side-chat${(btwEntry.runs?.length || 1) === 1 ? '' : 's'} · ${btwEntry.turns}t · ${formatTokens(btwEntry.totalTokens)} tok · ${formatMoney(btwEntry.costUSD, currency)})`}
                                                    >
                                                      <MessageSquare className="w-2.5 h-2.5 shrink-0" />
                                                      +{(btwEntry.runs?.length || 0) > 1 ? `${btwEntry.runs!.length} ` : ''}/btw
                                                      <ChevronRight
                                                        className={`w-2.5 h-2.5 transition-transform duration-150 ${
                                                          expandedBtwRows.has(`${chatKey}::/btw`) ? 'rotate-90' : ''
                                                        }`}
                                                      />
                                                    </button>
                                                  )}
                                                </>
                                              );
                                            })()}

                                            <span className="text-[10.5px] font-mono tabular text-[var(--ink-tertiary)]">
                                              {created.date} {created.time} →{' '}
                                              <span className="text-[var(--accent-teal)]">
                                                {modified.date} {modified.time}
                                              </span>{' '}
                                              <span>({formatRelativeTime(chat.lastActiveAt)})</span>
                                            </span>
                                          </div>

                                          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono tabular">
                                            <span className="text-[var(--ink-tertiary)]">
                                              Turns <strong className="text-[var(--ink-primary)]">{chat.turns}</strong>
                                            </span>
                                            <span className="text-[var(--ink-tertiary)]">
                                              In/Out{' '}
                                              <span className="text-[var(--ink-primary)]">{formatTokens(chat.inputTokens)}</span>
                                              <span className="mx-0.5">/</span>
                                              <span className="text-[var(--ink-secondary)]">{formatTokens(chat.outputTokens)}</span>
                                            </span>
                                            <span className="text-[var(--tool-antigravity)]">
                                              Cache {formatTokens(chat.cacheReadTokens)}
                                            </span>
                                            <span className="text-[var(--ink-primary)] font-medium">
                                              Total {formatTokens(chat.totalTokens)}
                                            </span>
                                            <span className="text-[var(--tool-claude)]">
                                              Saved {formatMoney(chat.cacheSavingsUSD, currency)}
                                            </span>
                                            <span className="text-[var(--accent-teal)] font-semibold">
                                              {formatMoney(chat.costUSD, currency)}
                                            </span>
                                          </div>
                                        </div>

                                        {/* Models used in this chat */}
                                        <div className="flex flex-wrap items-center gap-1.5 pl-6">
                                          <span className="inline-flex items-center gap-1 text-[10.5px] font-mono text-[var(--ink-tertiary)] mr-1">
                                            <Cpu className="w-3 h-3 text-[var(--accent-teal)]" />
                                            Models ({chatModels.length}):
                                          </span>
                                          {chatModels.map((m) => {
                                            const costShare =
                                              chat.costUSD > 0 ? (m.costUSD / chat.costUSD) * 100 : 0;
                                            const modelRate = findModelRate(
                                              m.normalizedModel,
                                              m.modelLabel,
                                              snapshot?.pricing
                                            );
                                            return (
                                              <span
                                                key={m.modelLabel}
                                                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md glass-subcard text-[10.5px] font-mono tabular text-[var(--ink-secondary)]"
                                                title={`Input: ${formatTokens(m.inputTokens)} · Cache Read: ${formatTokens(m.cacheReadTokens)} · Output: ${formatTokens(m.outputTokens)} · Saved: ${formatMoney(m.cacheSavingsUSD, currency)}`}
                                              >
                                                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-teal)] shrink-0" />
                                                <span className="text-[var(--ink-primary)] font-medium">{m.modelLabel}</span>
                                                {isPromoActive(modelRate) && (
                                                  <span
                                                    className="px-1 py-0 rounded text-[9px] font-semibold bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border border-[var(--accent-amber-border)]"
                                                    title={modelRate?.promoNote || 'Active promotional rate'}
                                                  >
                                                    PROMO
                                                  </span>
                                                )}
                                                <span className="text-[var(--ink-tertiary)]">· {m.turns}t</span>
                                                <span className="text-[var(--ink-secondary)]">· {formatTokens(m.totalTokens)}</span>
                                                <span className="text-[var(--accent-teal)] font-semibold">
                                                  · {formatMoney(m.costUSD, currency)}
                                                </span>
                                                <span className="text-[var(--ink-tertiary)]">({costShare.toFixed(0)}%)</span>
                                              </span>
                                            );
                                          })}
                                        </div>

                                        {/* Rolled-up subagent tools & /btw side-chats */}
                                        {subagentSummary.subagents.length > 0 && (() => {
                                          const btwSub = subagentSummary.subagents.find(
                                            (s) => s.subagentName === '/btw'
                                          );
                                          const btwRowKey = `${chatKey}::/btw`;
                                          const isBtwExpanded = expandedBtwRows.has(btwRowKey);
                                          return (
                                            <div className="space-y-1.5 pl-6">
                                              <div className="flex flex-wrap items-center gap-1.5">
                                                <span className="inline-flex items-center gap-1 text-[10.5px] font-mono text-[var(--accent-violet)] mr-1">
                                                  <Bot className="w-3 h-3" />
                                                  {btwSub
                                                    ? subagentSummary.subagents.every((s) => s.subagentName === '/btw')
                                                      ? 'Side Chats:'
                                                      : `Subagents & /btw (${subagentSummary.subagents.length}):`
                                                    : `Subagents (${subagentSummary.subagents.length}):`}
                                                </span>
                                                {subagentSummary.subagents.map((sub) => {
                                                  const isBtw = sub.subagentName === '/btw';
                                                  const costShare =
                                                    chat.costUSD > 0 ? (sub.costUSD / chat.costUSD) * 100 : 0;
                                                  const primarySubModel = sub.models[0]?.modelLabel || '';
                                                  const extraSubModels = Math.max(0, sub.models.length - 1);
                                                  const modelsTooltip = sub.models
                                                    .map(
                                                      (m) =>
                                                        `${m.modelLabel} (${m.turns}t, ${formatMoney(m.costUSD, currency)})`
                                                    )
                                                    .join(' · ');
                                                  const runCount = sub.runs?.length || 0;
                                                  if (isBtw && runCount > 0) {
                                                    return (
                                                      <button
                                                        key={sub.subagentId}
                                                        type="button"
                                                        onClick={(e) => {
                                                          e.stopPropagation();
                                                          toggleSetKey(setExpandedBtwRows, btwRowKey);
                                                        }}
                                                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10.5px] font-mono tabular bg-[var(--accent-sky-soft)] hover:brightness-110 border border-[var(--accent-sky-border)] text-[var(--ink-primary)] transition-all cursor-pointer"
                                                        title={`Click to ${isBtwExpanded ? 'hide' : 'show'} /btw titles · Input: ${formatTokens(sub.inputTokens)} · Cache Read: ${formatTokens(sub.cacheReadTokens)} · Output: ${formatTokens(sub.outputTokens)} · Saved: ${formatMoney(sub.cacheSavingsUSD, currency)}${modelsTooltip ? ` · Models: ${modelsTooltip}` : ''}`}
                                                      >
                                                        <ChevronRight
                                                          className={`w-3 h-3 text-[var(--accent-sky)] shrink-0 transition-transform duration-150 ${
                                                            isBtwExpanded ? 'rotate-90' : ''
                                                          }`}
                                                        />
                                                        <span className="font-semibold text-[var(--accent-sky)]">
                                                          {sub.subagentName}
                                                          {runCount > 1 ? ` (${runCount})` : ''}
                                                        </span>
                                                        {primarySubModel && (
                                                          <span className="text-[var(--ink-secondary)]">
                                                            [{primarySubModel}
                                                            {extraSubModels > 0 ? ` +${extraSubModels}` : ''}]
                                                          </span>
                                                        )}
                                                        <span className="text-[var(--ink-tertiary)]">· {sub.turns}t</span>
                                                        <span className="text-[var(--ink-secondary)]">
                                                          · {formatTokens(sub.totalTokens)}
                                                        </span>
                                                        <span className="text-[var(--accent-teal)] font-semibold">
                                                          · {formatMoney(sub.costUSD, currency)}
                                                        </span>
                                                        <span className="text-[var(--ink-tertiary)]">({costShare.toFixed(0)}%)</span>
                                                      </button>
                                                    );
                                                  }
                                                  return (
                                                    <span
                                                      key={sub.subagentId}
                                                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10.5px] font-mono tabular border ${
                                                        isBtw
                                                          ? 'bg-[var(--accent-sky-soft)] border-[var(--accent-sky-border)] text-[var(--ink-primary)]'
                                                          : 'bg-[var(--accent-violet-soft)] border-[var(--accent-violet-border)] text-[var(--ink-primary)]'
                                                      }`}
                                                      title={`${isBtw ? 'Side-chat /btw (preserved after Esc)' : `Subagent: ${sub.subagentName} (${sub.subagentId})`} · Input: ${formatTokens(sub.inputTokens)} · Cache Read: ${formatTokens(sub.cacheReadTokens)} · Output: ${formatTokens(sub.outputTokens)} · Saved: ${formatMoney(sub.cacheSavingsUSD, currency)}${modelsTooltip ? ` · Models: ${modelsTooltip}` : ''}`}
                                                    >
                                                      <span
                                                        className="h-1.5 w-1.5 rounded-full shrink-0"
                                                        style={{ backgroundColor: isBtw ? 'var(--accent-sky)' : 'var(--accent-violet)' }}
                                                      />
                                                      <span
                                                        className="font-semibold"
                                                        style={{ color: isBtw ? 'var(--accent-sky)' : 'var(--accent-violet)' }}
                                                      >
                                                        {sub.subagentName}
                                                      </span>
                                                      {primarySubModel && (
                                                        <span className="text-[var(--ink-secondary)]">
                                                          [{primarySubModel}
                                                          {extraSubModels > 0 ? ` +${extraSubModels}` : ''}]
                                                        </span>
                                                      )}
                                                      <span className="text-[var(--ink-tertiary)]">· {sub.turns}t</span>
                                                      <span className="text-[var(--ink-secondary)]">
                                                        · {formatTokens(sub.totalTokens)}
                                                      </span>
                                                      <span className="text-[var(--accent-teal)] font-semibold">
                                                        · {formatMoney(sub.costUSD, currency)}
                                                      </span>
                                                      <span className="text-[var(--ink-tertiary)]">({costShare.toFixed(0)}%)</span>
                                                    </span>
                                                  );
                                                })}
                                              </div>

                                              {btwSub && btwSub.runs && btwSub.runs.length > 0 && isBtwExpanded && (
                                                <div
                                                  onClick={(e) => e.stopPropagation()}
                                                  className="rounded-lg bg-[var(--accent-sky-soft)] border border-[var(--accent-sky-border)] px-2.5 py-2 space-y-1.5 cursor-default"
                                                >
                                                  <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--accent-sky)] font-semibold flex items-center gap-1.5">
                                                    <MessageSquare className="w-3 h-3" />
                                                    <span>/btw Side Chats ({btwSub.runs.length})</span>
                                                  </div>
                                                  <div className="divide-y divide-[var(--border-hairline)]">
                                                    {btwSub.runs.map((run) => {
                                                      const runDt = formatPreciseDateTime(run.lastActiveAt || run.startedAt);
                                                      const runModel = run.models[0]?.modelLabel || '';
                                                      return (
                                                        <div
                                                          key={run.runId}
                                                          className="py-1 first:pt-0.5 last:pb-0 flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-mono tabular"
                                                        >
                                                          <div className="flex items-center gap-1.5 min-w-0">
                                                            <span className="text-[var(--accent-sky)] shrink-0">↳</span>
                                                            <span
                                                              className="text-[var(--ink-primary)] font-medium truncate max-w-[260px] sm:max-w-[440px]"
                                                              title={run.title}
                                                            >
                                                              {run.title}
                                                            </span>
                                                            {runDt.date !== '—' && (
                                                              <span className="text-[10px] text-[var(--ink-tertiary)] shrink-0">
                                                                ({runDt.date} {runDt.time})
                                                              </span>
                                                            )}
                                                          </div>
                                                          <div className="flex items-center gap-2 shrink-0 text-[10px]">
                                                            {runModel && (
                                                              <span className="text-[var(--ink-secondary)]">[{runModel}]</span>
                                                            )}
                                                            <span className="text-[var(--ink-tertiary)]">{run.turns}t</span>
                                                            <span className="text-[var(--ink-secondary)]">
                                                              {formatTokens(run.totalTokens)}
                                                            </span>
                                                            <span className="text-[var(--accent-teal)] font-semibold">
                                                              {formatMoney(run.costUSD, currency)}
                                                            </span>
                                                          </div>
                                                        </div>
                                                      );
                                                    })}
                                                  </div>
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })()}
                                      </div>

                                      <div
                                        aria-hidden={!isChatExpanded}
                                        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                                          isChatExpanded
                                            ? 'grid-rows-[1fr] opacity-100'
                                            : 'grid-rows-[0fr] opacity-0 pointer-events-none'
                                        }`}
                                      >
                                        <div className="overflow-hidden min-h-0">
                                          <div className="border-t border-[var(--border-hairline)] bg-[var(--bg-subcard)] px-3 py-2.5 overflow-x-auto space-y-3">
                                            <table className="w-full text-left border-collapse text-xs min-w-[620px] lg:min-w-0">
                                              <thead>
                                                <tr className="border-b border-[var(--border-hairline)] text-[10px] font-mono uppercase text-[var(--ink-tertiary)]">
                                                  <th className="py-1.5 px-2">Model</th>
                                                  <th className="py-1.5 px-2 text-right">Turns</th>
                                                  <th className="py-1.5 px-2 text-right">Input</th>
                                                  <th className="py-1.5 px-2 text-right">Cache Read</th>
                                                  <th className="py-1.5 px-2 text-right">Output</th>
                                                  <th className="py-1.5 px-2 text-right">Total Tokens</th>
                                                  <th className="py-1.5 px-2 text-right">Cache Saved</th>
                                                  <th className="py-1.5 px-2 text-right">API Cost</th>
                                                  <th className="py-1.5 px-2 text-right">Cost Share</th>
                                                </tr>
                                              </thead>
                                              <tbody className="divide-y divide-[var(--border-hairline)] tabular">
                                                {chatModels.map((m) => {
                                                  const costShare =
                                                    chat.costUSD > 0 ? (m.costUSD / chat.costUSD) * 100 : 0;
                                                  const modelRate = findModelRate(
                                                    m.normalizedModel,
                                                    m.modelLabel,
                                                    snapshot?.pricing
                                                  );
                                                  return (
                                                    <tr key={m.modelLabel} className="hover:bg-[var(--table-hover)]">
                                                      <td className="py-1.5 px-2 font-mono font-medium text-[var(--ink-primary)] flex items-center gap-1.5 whitespace-nowrap">
                                                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-teal)] shrink-0" />
                                                        <span>{m.modelLabel}</span>
                                                        {isPromoActive(modelRate) && (
                                                          <span
                                                            className="px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border border-[var(--accent-amber-border)]"
                                                            title={
                                                              modelRate?.promoNote || 'Active promotional rate'
                                                            }
                                                          >
                                                            PROMO
                                                          </span>
                                                        )}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-secondary)] text-[11px]">
                                                        {m.turns}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-tertiary)] text-[11px]">
                                                        {formatTokens(m.inputTokens)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-[var(--tool-antigravity)] text-[11px]">
                                                        {formatTokens(m.cacheReadTokens)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-secondary)] text-[11px]">
                                                        {formatTokens(m.outputTokens)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-primary)] font-medium text-[11px]">
                                                        {formatTokens(m.totalTokens)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-[var(--tool-claude)] text-[11px]">
                                                        {formatMoney(m.cacheSavingsUSD, currency)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono font-semibold text-[var(--accent-teal)] text-[11px]">
                                                        {formatMoney(m.costUSD, currency)}
                                                      </td>
                                                      <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-tertiary)] text-[11px]">
                                                        {costShare.toFixed(1)}%
                                                      </td>
                                                    </tr>
                                                  );
                                                })}
                                              </tbody>
                                            </table>

                                            {subagentSummary.subagents.length > 0 && (
                                              <div className="pt-2.5 border-t border-[var(--border-hairline)]">
                                                <div className="flex items-center gap-1.5 mb-1.5 px-2 text-[10px] font-mono uppercase tracking-wider text-[var(--accent-violet)] font-semibold">
                                                  <Bot className="w-3 h-3" />
                                                  <span>Main Chat vs Subagent Tools Consumption</span>
                                                </div>
                                                <table className="w-full text-left border-collapse text-xs min-w-[620px] lg:min-w-0">
                                                  <thead>
                                                    <tr className="border-b border-[var(--border-hairline)] text-[10px] font-mono uppercase text-[var(--ink-tertiary)]">
                                                      <th className="py-1.5 px-2">Agent / Tool</th>
                                                      <th className="py-1.5 px-2 text-right">Turns</th>
                                                      <th className="py-1.5 px-2 text-right">Input</th>
                                                      <th className="py-1.5 px-2 text-right">Cache Read</th>
                                                      <th className="py-1.5 px-2 text-right">Output</th>
                                                      <th className="py-1.5 px-2 text-right">Total Tokens</th>
                                                      <th className="py-1.5 px-2 text-right">Cache Saved</th>
                                                      <th className="py-1.5 px-2 text-right">API Cost</th>
                                                      <th className="py-1.5 px-2 text-right">Cost Share</th>
                                                    </tr>
                                                  </thead>
                                                  <tbody className="divide-y divide-[var(--border-hairline)] tabular">
                                                    {subagentSummary.main.turns > 0 && (
                                                      <tr className="hover:bg-[var(--table-hover)]">
                                                        <td className="py-1.5 px-2 font-mono font-medium text-[var(--ink-primary)] whitespace-nowrap">
                                                          <span className="inline-flex items-center gap-1.5">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-[var(--tool-antigravity)] shrink-0" />
                                                            <span>Main Chat</span>
                                                          </span>
                                                        </td>
                                                        <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-secondary)] text-[11px]">
                                                          {subagentSummary.main.turns}
                                                        </td>
                                                        <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-tertiary)] text-[11px]">
                                                          {formatTokens(subagentSummary.main.inputTokens)}
                                                        </td>
                                                        <td className="py-1.5 px-2 text-right font-mono text-[var(--tool-antigravity)] text-[11px]">
                                                          {formatTokens(subagentSummary.main.cacheReadTokens)}
                                                        </td>
                                                        <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-secondary)] text-[11px]">
                                                          {formatTokens(subagentSummary.main.outputTokens)}
                                                        </td>
                                                        <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-primary)] font-medium text-[11px]">
                                                          {formatTokens(subagentSummary.main.totalTokens)}
                                                        </td>
                                                        <td className="py-1.5 px-2 text-right font-mono text-[var(--tool-claude)] text-[11px]">
                                                          {formatMoney(subagentSummary.main.cacheSavingsUSD, currency)}
                                                        </td>
                                                        <td className="py-1.5 px-2 text-right font-mono font-semibold text-[var(--accent-teal)] text-[11px]">
                                                          {formatMoney(subagentSummary.main.costUSD, currency)}
                                                        </td>
                                                        <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-tertiary)] text-[11px]">
                                                          {(chat.costUSD > 0
                                                            ? (subagentSummary.main.costUSD / chat.costUSD) * 100
                                                            : 0
                                                          ).toFixed(1)}
                                                          %
                                                        </td>
                                                      </tr>
                                                    )}
                                                    {subagentSummary.subagents.map((sub) => {
                                                      const isBtw = sub.subagentName === '/btw';
                                                      const subShare =
                                                        chat.costUSD > 0 ? (sub.costUSD / chat.costUSD) * 100 : 0;
                                                      const subRowKey = `${chatKey}::${sub.subagentId}`;
                                                      const canExpandRuns = isBtw && Boolean(sub.runs && sub.runs.length > 0);
                                                      const isSubExpanded = canExpandRuns && expandedBtwRows.has(subRowKey);
                                                      return (
                                                        <React.Fragment key={sub.subagentId}>
                                                          <tr
                                                            onClick={
                                                              canExpandRuns
                                                                ? () => toggleSetKey(setExpandedBtwRows, subRowKey)
                                                                : undefined
                                                            }
                                                            className={`hover:bg-[var(--table-hover)] ${canExpandRuns ? 'cursor-pointer' : ''}`}
                                                          >
                                                            <td
                                                              className="py-1.5 px-2 font-mono font-medium whitespace-nowrap"
                                                              style={{ color: isBtw ? 'var(--accent-sky)' : 'var(--accent-violet)' }}
                                                            >
                                                              <div className="inline-flex items-center gap-1.5">
                                                                {canExpandRuns ? (
                                                                  <ChevronRight
                                                                    className={`w-3 h-3 shrink-0 transition-transform duration-150 ${
                                                                      isSubExpanded ? 'rotate-90' : ''
                                                                    }`}
                                                                  />
                                                                ) : (
                                                                  <span>↳</span>
                                                                )}
                                                                {isBtw ? (
                                                                  <MessageSquare className="w-3 h-3 shrink-0" />
                                                                ) : (
                                                                  <Bot className="w-3 h-3 shrink-0" />
                                                                )}
                                                                <span title={sub.subagentId}>
                                                                  {sub.subagentName}
                                                                  {canExpandRuns && sub.runs!.length > 1
                                                                    ? ` (${sub.runs!.length})`
                                                                    : ''}
                                                                </span>
                                                                {sub.models.length > 0 && (
                                                                  <span className="text-[10px] font-normal text-[var(--ink-tertiary)]">
                                                                    ({sub.models.map((m) => m.modelLabel).join(', ')})
                                                                  </span>
                                                                )}
                                                              </div>
                                                            </td>
                                                            <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-secondary)] text-[11px]">
                                                              {sub.turns}
                                                            </td>
                                                            <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-tertiary)] text-[11px]">
                                                              {formatTokens(sub.inputTokens)}
                                                            </td>
                                                            <td className="py-1.5 px-2 text-right font-mono text-[var(--tool-antigravity)] text-[11px]">
                                                              {formatTokens(sub.cacheReadTokens)}
                                                            </td>
                                                            <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-secondary)] text-[11px]">
                                                              {formatTokens(sub.outputTokens)}
                                                            </td>
                                                            <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-primary)] font-medium text-[11px]">
                                                              {formatTokens(sub.totalTokens)}
                                                            </td>
                                                            <td className="py-1.5 px-2 text-right font-mono text-[var(--tool-claude)] text-[11px]">
                                                              {formatMoney(sub.cacheSavingsUSD, currency)}
                                                            </td>
                                                            <td className="py-1.5 px-2 text-right font-mono font-semibold text-[var(--accent-teal)] text-[11px]">
                                                              {formatMoney(sub.costUSD, currency)}
                                                            </td>
                                                            <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-tertiary)] text-[11px]">
                                                              {subShare.toFixed(1)}%
                                                            </td>
                                                          </tr>
                                                          {isSubExpanded &&
                                                            sub.runs!.map((run) => {
                                                              const runShare =
                                                                chat.costUSD > 0 ? (run.costUSD / chat.costUSD) * 100 : 0;
                                                              const runDt = formatPreciseDateTime(
                                                                run.lastActiveAt || run.startedAt
                                                              );
                                                              return (
                                                                <tr
                                                                  key={`${sub.subagentId}-${run.runId}`}
                                                                  className="bg-[var(--accent-sky-soft)] hover:brightness-105"
                                                                >
                                                                  <td className="py-1.5 pl-8 pr-2 font-mono text-[11px] text-[var(--ink-primary)]">
                                                                    <div className="flex items-center gap-1.5 min-w-0">
                                                                      <span className="text-[var(--accent-sky)] shrink-0">↳</span>
                                                                      <span
                                                                        className="truncate max-w-[260px] lg:max-w-[360px]"
                                                                        title={run.title}
                                                                      >
                                                                        {run.title}
                                                                      </span>
                                                                      {runDt.date !== '—' && (
                                                                        <span className="text-[10px] text-[var(--ink-tertiary)] shrink-0">
                                                                          ({runDt.date} {runDt.time})
                                                                        </span>
                                                                      )}
                                                                    </div>
                                                                  </td>
                                                                  <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-secondary)] text-[11px]">
                                                                    {run.turns}
                                                                  </td>
                                                                  <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-tertiary)] text-[11px]">
                                                                    {formatTokens(run.inputTokens)}
                                                                  </td>
                                                                  <td className="py-1.5 px-2 text-right font-mono text-[var(--tool-antigravity)] text-[11px]">
                                                                    {formatTokens(run.cacheReadTokens)}
                                                                  </td>
                                                                  <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-secondary)] text-[11px]">
                                                                    {formatTokens(run.outputTokens)}
                                                                  </td>
                                                                  <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-primary)] text-[11px]">
                                                                    {formatTokens(run.totalTokens)}
                                                                  </td>
                                                                  <td className="py-1.5 px-2 text-right font-mono text-[var(--tool-claude)] text-[11px]">
                                                                    {formatMoney(run.cacheSavingsUSD, currency)}
                                                                  </td>
                                                                  <td className="py-1.5 px-2 text-right font-mono font-semibold text-[var(--accent-teal)] text-[11px]">
                                                                    {formatMoney(run.costUSD, currency)}
                                                                  </td>
                                                                  <td className="py-1.5 px-2 text-right font-mono text-[var(--ink-tertiary)] text-[11px]">
                                                                    {runShare.toFixed(1)}%
                                                                  </td>
                                                                </tr>
                                                              );
                                                            })}
                                                        </React.Fragment>
                                                      );
                                                    })}
                                                  </tbody>
                                                </table>
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                );
              })}

              {tableData.workspaces.length === 0 && (
                <tbody className="text-xs">
                  <tr>
                    <td colSpan={12} className="py-10 text-center text-[var(--ink-tertiary)] font-mono">
                      No matching workspaces or chats found.
                    </td>
                  </tr>
                </tbody>
              )}
            </table>
          </div>
        </section>
        )}

        {visibleSectionCount === 0 ? (
          <div className="glass-panel rounded-2xl p-10 text-center space-y-3 animate-burn-fade-up">
            <LayoutGrid className="w-7 h-7 text-[var(--ink-tertiary)] mx-auto" />
            <p className="text-sm font-semibold text-[var(--ink-primary)]">All dashboard sections are currently hidden</p>
            <p className="text-xs text-[var(--ink-tertiary)]">
              Re-enable sections or restore the default order from Settings.
            </p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() =>
                  void saveSettings({
                    ...userSettings,
                    layout: { order: DEFAULT_SECTION_ORDER, hidden: [] },
                  })
                }
                className="btn-primary-brand h-8 px-3.5 rounded-lg font-semibold text-xs font-mono transition-colors cursor-pointer"
              >
                Restore Default Layout
              </button>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                className="h-8 px-3 rounded-lg glass-control hover:border-[var(--border-strong)] text-xs font-mono text-[var(--ink-primary)] transition-colors cursor-pointer"
              >
                Open Settings
              </button>
            </div>
          </div>
        ) : hiddenSections.size > 0 ? (
          <div style={{ order: 99 }} className="flex justify-center pt-1">
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass-control hover:border-[var(--border-strong)] text-[11px] font-mono text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
            >
              <LayoutGrid className="w-3.5 h-3.5 text-[var(--tool-antigravity)]" />
              <span>
                {hiddenSections.size} {hiddenSections.size === 1 ? 'section' : 'sections'} hidden · Customize layout
              </span>
            </button>
          </div>
        ) : null}
      </main>

      {/* Deleted Chats Popup Modal */}
      <DeletedChatsModal
        isOpen={isDeletedModalOpen}
        onClose={() => setIsDeletedModalOpen(false)}
        deletedSessions={analytics.deletedSessions}
        trackedDeletedCount={analytics.trackedDeletedCount}
        legacyDeletedCount={analytics.legacyDeletedCount}
        deletedCostUSD={analytics.deletedCostUSD}
        deletedTokens={analytics.deletedTokens}
        deletedCacheSavingsUSD={analytics.deletedCacheSavingsUSD}
        dismissedLegacyCount={snapshot.dismissedLegacyCount || 0}
        includeDeletedInTotals={userSettings.includeDeletedInTotals}
        hooksStatus={snapshot.hooksStatus}
        currency={currency}
        hideLegacyDeleted={hideLegacyDeleted}
        onToggleHideLegacy={toggleHideLegacyDeleted}
        onToggleIncludeInTotals={toggleIncludeDeletedInTotals}
        onDismissLegacy={dismissLegacyChats}
        onRestoreLegacy={restoreDismissedLegacy}
        dismissingLegacyKeys={dismissingLegacyKeys}
        isClearingLegacyBulk={isClearingLegacyBulk}
        isRestoringLegacy={isRestoringLegacy}
      />

      {/* Subscription Plans, Layout & Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={userSettings}
        hooksStatus={snapshot.hooksStatus}
        currency={currency}
        onSave={saveSettings}
        onSnapshotUpdated={(nextSnapshot) => {
          setSnapshot(nextSnapshot);
          setLastSyncTime(new Date().toLocaleTimeString());
        }}
      />
    </div>
  );
}
