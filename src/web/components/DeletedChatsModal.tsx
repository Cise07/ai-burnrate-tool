import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Check,
  Eye,
  EyeOff,
  FolderGit2,
  MessageSquare,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  formatMoney,
  getSessionModelBreakdown,
  getSessionSubagentBreakdown,
  type Currency,
} from '../../core/analytics';
import type { HooksStatus, SessionStats, ToolSource } from '../../core/types';

interface DeletedChatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  deletedSessions: SessionStats[];
  trackedDeletedCount: number;
  legacyDeletedCount: number;
  deletedCostUSD: number;
  deletedTokens: number;
  deletedCacheSavingsUSD: number;
  dismissedLegacyCount: number;
  includeDeletedInTotals: boolean;
  hooksStatus?: HooksStatus;
  currency: Currency;
  hideLegacyDeleted: boolean;
  onToggleHideLegacy: () => void;
  onToggleIncludeInTotals: () => void;
  onDismissLegacy: (chats: SessionStats[], isBulk?: boolean) => Promise<void>;
  onRestoreLegacy: () => Promise<void>;
  dismissingLegacyKeys: Set<string>;
  isClearingLegacyBulk: boolean;
  isRestoringLegacy: boolean;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtRelativeTime(iso: string): string {
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

function fmtPreciseDate(iso: string): { date: string; time: string } {
  if (!iso) return { date: '—', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: iso.slice(0, 10), time: '' };
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return { date: `${dd}/${mm}/${yyyy}`, time: `${hh}:${min}` };
}

function CompactSourceBadge({ source }: { source: ToolSource }) {
  if (source === 'antigravity') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-md font-mono font-medium bg-cyan-500/10 text-cyan-300 border border-cyan-500/25 whitespace-nowrap">
        <Terminal className="w-2.5 h-2.5 shrink-0" />
        Antigravity
      </span>
    );
  }
  if (source === 'claude') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-md font-mono font-medium bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/25 whitespace-nowrap">
        <Sparkles className="w-2.5 h-2.5 shrink-0" />
        Claude Code
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-md font-mono font-medium bg-amber-500/10 text-amber-300 border border-amber-500/25 whitespace-nowrap">
      <Terminal className="w-2.5 h-2.5 shrink-0" />
      Codex CLI
    </span>
  );
}

export function DeletedChatsModal({
  isOpen,
  onClose,
  deletedSessions,
  trackedDeletedCount,
  legacyDeletedCount,
  deletedCostUSD,
  deletedTokens,
  deletedCacheSavingsUSD,
  dismissedLegacyCount,
  includeDeletedInTotals,
  hooksStatus,
  currency,
  hideLegacyDeleted,
  onToggleHideLegacy,
  onToggleIncludeInTotals,
  onDismissLegacy,
  onRestoreLegacy,
  dismissingLegacyKeys,
  isClearingLegacyBulk,
  isRestoringLegacy,
}: DeletedChatsModalProps) {
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmClearLegacy, setConfirmClearLegacy] = useState(false);

  useEffect(() => {
    if (isOpen) {
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
    setConfirmClearLegacy(false);
    const timer = setTimeout(() => {
      setRendered(false);
      setSearchQuery('');
    }, 220);
    return () => clearTimeout(timer);
  }, [isOpen]);

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

  useEffect(() => {
    setConfirmClearLegacy(false);
  }, [searchQuery, hideLegacyDeleted]);

  useEffect(() => {
    if (!confirmClearLegacy) return;
    const timer = setTimeout(() => setConfirmClearLegacy(false), 4500);
    return () => clearTimeout(timer);
  }, [confirmClearLegacy]);

  const visibleDeletedSessions = useMemo(() => {
    const base = hideLegacyDeleted
      ? deletedSessions.filter((chat) => !chat.untrackedHistory)
      : deletedSessions;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (chat) =>
        (chat.sessionTitle || '').toLowerCase().includes(q) ||
        chat.workspaceName.toLowerCase().includes(q) ||
        chat.workspace.toLowerCase().includes(q) ||
        chat.sessionId.toLowerCase().includes(q) ||
        chat.source.toLowerCase().includes(q) ||
        chat.primaryModelLabel.toLowerCase().includes(q) ||
        chat.turnHistory.some(
          (t) =>
            t.modelLabel.toLowerCase().includes(q) ||
            t.normalizedModel.toLowerCase().includes(q) ||
            t.model.toLowerCase().includes(q) ||
            (t.subagentName || '').toLowerCase().includes(q) ||
            (t.subagentTitle || '').toLowerCase().includes(q)
        )
    );
  }, [deletedSessions, searchQuery, hideLegacyDeleted]);

  const visibleLegacySessions = useMemo(
    () => visibleDeletedSessions.filter((chat) => Boolean(chat.untrackedHistory)),
    [visibleDeletedSessions]
  );

  if (!rendered) return null;

  const activeHookTools: string[] = [];
  if (hooksStatus?.antigravity) activeHookTools.push('Antigravity');
  if (hooksStatus?.claude) activeHookTools.push('Claude Code');
  if (hooksStatus?.codex) activeHookTools.push('Codex CLI');
  const hooksActive = activeHookTools.length > 0;

  return (
    <div
      className={`fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-2 sm:p-4 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Deleted Chats Archive"
    >
      <div
        className={`w-full max-w-2xl max-h-[92dvh] sm:max-h-[84vh] min-h-0 flex flex-col rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none ${
          visible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-3 scale-[0.985]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-zinc-800/90 flex items-start justify-between gap-2.5 bg-zinc-950/60 shrink-0 animate-burn-header">
          <div className="flex items-start gap-2.5 sm:gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-400 mt-0.5 shrink-0">
              <Trash2 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-100 leading-snug">
                Deleted Chats & Preserved API Spend
              </h3>
              <p className="text-[11px] sm:text-xs text-zinc-400 mt-0.5 leading-relaxed">
                Removed chats stay out of active workspaces while preserving their spent API cost & models.
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={onToggleIncludeInTotals}
                  aria-pressed={includeDeletedInTotals}
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono border transition-colors cursor-pointer ${
                    includeDeletedInTotals
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20'
                      : 'bg-zinc-900 border-zinc-700/80 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      includeDeletedInTotals ? 'bg-emerald-400' : 'bg-zinc-500'
                    }`}
                  />
                  {includeDeletedInTotals ? 'Included in totals & CSV' : 'Excluded from totals'}
                </button>
                {hooksActive && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono bg-cyan-500/10 border border-cyan-500/25 text-cyan-300"
                    title={`Auto-archive hooks active for ${activeHookTools.join(', ')} — snapshots turns even when burn is closed`}
                  >
                    <ShieldCheck className="w-3 h-3 shrink-0" />
                    Offline hooks active ({activeHookTools.join(' · ')})
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close deleted chats popup"
            className="group p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors duration-200 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4 transition-transform duration-200 group-hover:rotate-90 motion-reduce:transition-none" />
          </button>
        </div>

        {/* Mobile: single smooth scroll body below header; Desktop (sm+): sticky summary/toolbar + scrollable list */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain sm:overflow-hidden sm:flex sm:flex-col">
        {/* Responsive Summary Strip (2 cols on mobile, 3 cols on sm+) */}
        <div
          className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3 px-3.5 sm:px-5 py-3 border-b border-zinc-800/80 bg-zinc-950/30 shrink-0 animate-burn-fade-up"
          style={{ animationDelay: '40ms' }}
        >
          <div className="rounded-lg bg-zinc-950/70 border border-zinc-800/80 px-2.5 sm:px-3 py-2 min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 truncate">
              Deleted Chats
            </div>
            <div className="text-base sm:text-lg font-bold font-mono text-zinc-100 mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              <span>{deletedSessions.length}</span>
              {legacyDeletedCount > 0 && (
                <span className="text-[10px] font-normal text-zinc-500 whitespace-nowrap">
                  ({trackedDeletedCount} tracked · {legacyDeletedCount} legacy)
                </span>
              )}
            </div>
          </div>

          <div className="rounded-lg bg-zinc-950/70 border border-zinc-800/80 px-2.5 sm:px-3 py-2 min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 truncate">
              API Cost Preserved
            </div>
            <div className="text-base sm:text-lg font-bold font-mono text-emerald-400 mt-0.5 truncate">
              {formatMoney(deletedCostUSD, currency)}
            </div>
          </div>

          <div className="col-span-2 sm:col-span-1 rounded-lg bg-zinc-950/70 border border-zinc-800/80 px-2.5 sm:px-3 py-2 min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 truncate">
              Tokens / Cache Saved
            </div>
            <div className="text-xs sm:text-sm font-semibold font-mono text-zinc-200 mt-1 truncate">
              {fmtTokens(deletedTokens)}{' '}
              <span className="text-fuchsia-400 text-[11px] sm:text-xs">
                ({formatMoney(deletedCacheSavingsUSD, currency)})
              </span>
            </div>
          </div>
        </div>

        {/* Legacy Banner */}
        {legacyDeletedCount > 0 && (
          <div
            aria-hidden={hideLegacyDeleted}
            className={`grid shrink-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
              hideLegacyDeleted ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
            }`}
          >
            <div className="overflow-hidden">
              <div className="px-3.5 sm:px-5 py-2 border-b border-zinc-800/70 bg-amber-500/5 text-[10.5px] sm:text-[11px] text-amber-200/90 font-mono leading-relaxed">
                {legacyDeletedCount} older chat(s) were deleted before burnrate archived their logs (shown as N/A). New chats are snapshotted automatically via offline hooks even when burnrate is closed.
              </div>
            </div>
          </div>
        )}

        {/* Search Bar & Legacy Actions (mobile-safe stacked/wrapping layout) */}
        {(deletedSessions.length > 0 || dismissedLegacyCount > 0) && (
          <div
            className="px-3.5 sm:px-5 py-2.5 sm:py-3 border-b border-zinc-800/80 bg-zinc-950/40 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 shrink-0 animate-burn-fade-up"
            style={{ animationDelay: '70ms' }}
          >
            {deletedSessions.length > 0 && (
              <div className="relative w-full sm:flex-1 sm:min-w-[180px]">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search deleted chat, workspace, model..."
                  className="w-full h-8 pl-8 pr-7 rounded-lg bg-zinc-950 border border-zinc-800 hover:border-zinc-700 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500/50 font-mono transition-colors duration-200"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear deleted chats search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              {legacyDeletedCount > 0 && (
                <button
                  type="button"
                  onClick={onToggleHideLegacy}
                  aria-pressed={hideLegacyDeleted}
                  className={`h-8 px-2.5 rounded-lg border text-xs font-mono flex items-center gap-1.5 transition-all duration-200 active:scale-[0.98] cursor-pointer select-none ${
                    hideLegacyDeleted
                      ? 'bg-amber-500/15 border-amber-500/35 text-amber-200 hover:bg-amber-500/25'
                      : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-white'
                  }`}
                >
                  {hideLegacyDeleted ? (
                    <Eye className="w-3.5 h-3.5 text-amber-300" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5 text-zinc-400" />
                  )}
                  <span>{hideLegacyDeleted ? 'Show Legacy' : 'Hide Legacy'}</span>
                  <span className="text-[10px] opacity-75">({legacyDeletedCount})</span>
                </button>
              )}

              {!hideLegacyDeleted && visibleLegacySessions.length > 0 && (
                confirmClearLegacy ? (
                  <div className="inline-flex items-center gap-1 animate-burn-expand">
                    <button
                      type="button"
                      disabled={isClearingLegacyBulk}
                      onClick={() => {
                        setConfirmClearLegacy(false);
                        void onDismissLegacy(visibleLegacySessions, true);
                      }}
                      className="h-8 px-2.5 rounded-lg border bg-rose-500/20 border-rose-500/45 text-rose-200 hover:bg-rose-500/30 text-xs font-mono flex items-center gap-1.5 transition-all duration-200 active:scale-[0.98] disabled:opacity-50 cursor-pointer select-none"
                    >
                      <Check className="w-3.5 h-3.5 text-rose-300" />
                      <span>Confirm ({visibleLegacySessions.length})</span>
                    </button>
                    <button
                      type="button"
                      disabled={isClearingLegacyBulk}
                      onClick={() => setConfirmClearLegacy(false)}
                      aria-label="Cancel clear legacy chats"
                      className="h-8 w-8 rounded-lg border bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={isClearingLegacyBulk}
                    onClick={() => setConfirmClearLegacy(true)}
                    className="h-8 px-2.5 rounded-lg border bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-rose-500/40 hover:bg-rose-500/15 hover:text-rose-200 text-xs font-mono flex items-center gap-1.5 transition-all duration-200 active:scale-[0.98] disabled:opacity-50 cursor-pointer select-none"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-rose-400/85" />
                    <span>Clear Legacy</span>
                    <span className="text-[10px] opacity-75">({visibleLegacySessions.length})</span>
                  </button>
                )
              )}

              {dismissedLegacyCount > 0 && (
                <button
                  type="button"
                  disabled={isRestoringLegacy}
                  onClick={() => void onRestoreLegacy()}
                  title={`Restore ${dismissedLegacyCount} dismissed legacy chat(s)`}
                  className="h-8 px-2.5 rounded-lg border bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-emerald-500/40 hover:bg-emerald-500/15 hover:text-emerald-200 text-xs font-mono flex items-center gap-1.5 transition-all duration-200 active:scale-[0.98] disabled:opacity-50 cursor-pointer select-none"
                >
                  <RotateCcw className={`w-3.5 h-3.5 text-emerald-400 ${isRestoringLegacy ? 'animate-spin' : ''}`} />
                  <span>Restore ({dismissedLegacyCount})</span>
                </button>
              )}

              {(searchQuery.trim() || hideLegacyDeleted) && deletedSessions.length > 0 && (
                <span className="text-[11px] font-mono text-zinc-400 ml-auto sm:ml-0">
                  {visibleDeletedSessions.length}/{deletedSessions.length}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Scrollable Deleted Chats List */}
        <div className="sm:flex-1 sm:min-h-0 sm:overflow-y-auto sm:overscroll-contain p-3.5 sm:p-5 space-y-2.5">
          {deletedSessions.length === 0 ? (
            <div className="py-10 text-center space-y-2 animate-burn-fade-up">
              <div className="w-10 h-10 rounded-full bg-zinc-800/70 border border-zinc-700/60 flex items-center justify-center mx-auto text-zinc-500">
                <Trash2 className="w-4 h-4" />
              </div>
              <p className="text-xs font-medium text-zinc-300">No deleted chats in this filter</p>
              <p className="text-[11px] text-zinc-500 max-w-sm mx-auto">
                Whenever you delete a chat in Antigravity, Claude Code or Codex CLI, its API spend and models stay archived here automatically.
              </p>
            </div>
          ) : visibleDeletedSessions.length === 0 ? (
            <div className="py-10 text-center space-y-2 animate-burn-expand">
              <p className="text-xs font-mono text-zinc-400">
                {searchQuery.trim()
                  ? `No deleted chats matching "${searchQuery.trim()}".`
                  : 'No tracked deleted chats yet (legacy chats are hidden).'}
              </p>
              <div className="flex items-center justify-center gap-3">
                {searchQuery.trim() && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="text-[11px] font-mono text-emerald-400 hover:text-emerald-300 underline underline-offset-2 cursor-pointer"
                  >
                    Clear search
                  </button>
                )}
                {hideLegacyDeleted && legacyDeletedCount > 0 && (
                  <button
                    type="button"
                    onClick={onToggleHideLegacy}
                    className="text-[11px] font-mono text-amber-300 hover:text-amber-200 underline underline-offset-2 cursor-pointer"
                  >
                    Show legacy ({legacyDeletedCount})
                  </button>
                )}
              </div>
            </div>
          ) : (
            visibleDeletedSessions.map((chat, idx) => {
              const delTs = fmtPreciseDate(chat.deletedAt || chat.lastActiveAt);
              const chatModels = getSessionModelBreakdown(chat.turnHistory);
              const chatSubagents = getSessionSubagentBreakdown(chat.turnHistory).subagents;
              const isLegacy = Boolean(chat.untrackedHistory);
              const chatKey = `${chat.source}:${chat.sessionId}`;
              const isDismissing = dismissingLegacyKeys.has(chatKey);

              return (
                <div
                  key={chatKey}
                  style={{ animationDelay: `${Math.min(idx, 10) * 24}ms` }}
                  className={`rounded-xl border p-3 sm:p-3.5 transition-all duration-200 animate-burn-fade-up ${
                    isDismissing ? 'opacity-45 scale-[0.99] pointer-events-none' : ''
                  } ${
                    isLegacy
                      ? 'bg-zinc-950/45 border-zinc-800/60 hover:border-zinc-700/75 hover:bg-zinc-900/50'
                      : 'bg-zinc-950/75 border-zinc-800/80 hover:border-zinc-700/80 hover:bg-zinc-900/65'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2.5 sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="text-xs font-semibold text-zinc-100 line-clamp-2 sm:truncate break-words min-w-0"
                          title={chat.sessionTitle || chat.sessionId}
                        >
                          {chat.sessionTitle || chat.sessionId}
                        </span>
                        <CompactSourceBadge source={chat.source} />
                        {isLegacy && (
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-300 border border-amber-500/25 whitespace-nowrap"
                            title="Deleted before burnrate archived its token log"
                          >
                            Legacy · no token log
                          </span>
                        )}
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-zinc-400">
                        <span className="inline-flex items-center gap-1 text-zinc-300 max-w-full truncate" title={chat.workspace}>
                          <FolderGit2 className="w-3 h-3 text-zinc-500 shrink-0" />
                          <span className="truncate">{chat.workspaceName}</span>
                        </span>
                        <span className="text-zinc-600">•</span>
                        <span>
                          {chat.turns} {isLegacy ? 'prompts' : 'turns'}
                        </span>
                        {!isLegacy && (
                          <>
                            <span className="text-zinc-600">•</span>
                            <span>{fmtTokens(chat.totalTokens)} tok</span>
                          </>
                        )}
                        <span className="text-zinc-600">•</span>
                        <span
                          className="text-rose-300/90"
                          title={`${isLegacy ? 'Last active' : 'Deleted'} ${delTs.date} ${delTs.time}`}
                        >
                          {isLegacy ? 'Last seen' : 'Deleted'} {fmtRelativeTime(chat.deletedAt || chat.lastActiveAt)} ({delTs.date})
                        </span>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      {isLegacy ? (
                        <div className="flex items-center gap-1.5 sm:gap-2">
                          <span
                            className="text-xs font-mono text-zinc-500"
                            title="Token log was removed before burnrate ledger tracking"
                          >
                            N/A
                          </span>
                          <button
                            type="button"
                            disabled={isDismissing || isClearingLegacyBulk}
                            onClick={() => void onDismissLegacy([chat])}
                            aria-label={`Remove legacy chat ${chat.sessionTitle || chat.sessionId}`}
                            title="Remove this legacy chat from the deleted list"
                            className="h-8 w-8 sm:h-7 sm:w-7 rounded-lg border border-zinc-800/90 bg-zinc-900/70 text-zinc-400 hover:text-rose-300 hover:bg-rose-500/15 hover:border-rose-500/35 flex items-center justify-center transition-all duration-200 active:scale-95 disabled:opacity-40 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="text-sm font-bold font-mono text-emerald-400">
                            {formatMoney(chat.costUSD, currency)}
                          </div>
                          {chat.cacheSavingsUSD > 0 && (
                            <div className="text-[10px] font-mono text-fuchsia-400">
                              +{formatMoney(chat.cacheSavingsUSD, currency)} saved
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {(chatModels.length > 0 || chatSubagents.length > 0) && (
                    <div className="mt-2.5 pt-2 border-t border-zinc-800/70 flex flex-wrap items-center gap-1.5">
                      {chatModels.map((m) => (
                        <span
                          key={m.modelLabel}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-300"
                        >
                          <span>{m.modelLabel}</span>
                          <span className="text-emerald-400">
                            {formatMoney(m.costUSD, currency)}
                          </span>
                        </span>
                      ))}
                      {chatSubagents.map((sub) => {
                        const isBtw = sub.subagentName === '/btw';
                        return (
                          <span
                            key={sub.subagentId}
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono ${
                              isBtw
                                ? 'bg-sky-950/35 border border-sky-500/30 text-sky-200'
                                : 'bg-violet-950/35 border border-violet-500/30 text-violet-200'
                            }`}
                            title={`${isBtw ? 'Side-chat' : 'Subagent'}: ${sub.subagentName} · ${sub.turns}t · ${fmtTokens(sub.totalTokens)} tok`}
                          >
                            {isBtw ? (
                              <MessageSquare className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                            ) : (
                              <Bot className="w-2.5 h-2.5 text-violet-400 shrink-0" />
                            )}
                            <span>{sub.subagentName}</span>
                            <span className="text-zinc-400">· {sub.turns}t</span>
                            <span className="text-emerald-400">
                              {formatMoney(sub.costUSD, currency)}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
