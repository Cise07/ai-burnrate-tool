import { useEffect, useMemo, useRef, useState } from 'react';
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
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-md font-mono font-medium bg-[var(--accent-sky-soft)] text-[var(--tool-antigravity)] border border-[var(--accent-sky-border)] whitespace-nowrap">
        <Terminal className="w-2.5 h-2.5 shrink-0" />
        Antigravity
      </span>
    );
  }
  if (source === 'claude') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-md font-mono font-medium bg-[var(--accent-violet-soft)] text-[var(--tool-claude)] border border-[var(--accent-violet-border)] whitespace-nowrap">
        <Sparkles className="w-2.5 h-2.5 shrink-0" />
        Claude Code
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-md font-mono font-medium bg-[var(--accent-amber-soft)] text-[var(--tool-codex)] border border-[var(--accent-amber-border)] whitespace-nowrap">
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
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmClearLegacy, setConfirmClearLegacy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
      setConfirmClearLegacy(false);
      setSearchQuery('');
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      setConfirmClearLegacy(false);
      setSearchQuery('');
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

  const activeHookTools: string[] = [];
  if (hooksStatus?.antigravity) activeHookTools.push('Antigravity');
  if (hooksStatus?.claude) activeHookTools.push('Claude Code');
  if (hooksStatus?.codex) activeHookTools.push('Codex CLI');
  const hooksActive = activeHookTools.length > 0;

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="deleted-modal-title"
      className="dash-dialog w-[min(calc(100vw-1rem),42rem)]"
    >
      {/* Modal Header */}
      <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-[var(--border-hairline)] flex items-start justify-between gap-2.5 bg-[var(--bg-modal-band)] shrink-0">
        <div className="flex items-start gap-2.5 sm:gap-3 min-w-0">
          <div className="p-2 rounded-xl bg-[var(--accent-rose-soft)] border border-[var(--accent-rose-border)] text-[var(--accent-rose)] mt-0.5 shrink-0">
            <Trash2 className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h1 id="deleted-modal-title" className="text-sm font-semibold text-[var(--ink-primary)] leading-snug">
              Deleted Chats &amp; Preserved API Spend
            </h1>
            <p className="text-[11px] sm:text-xs text-[var(--ink-tertiary)] mt-0.5 leading-relaxed">
              Removed chats stay out of active workspaces while preserving their spent API cost &amp; models.
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={onToggleIncludeInTotals}
                aria-pressed={includeDeletedInTotals}
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono border transition-colors cursor-pointer ${
                  includeDeletedInTotals
                    ? 'bg-[var(--accent-teal-soft)] border-[var(--accent-teal-border)] text-[var(--accent-teal)] font-medium'
                    : 'glass-control text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]'
                }`}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: includeDeletedInTotals ? 'var(--accent-teal)' : 'var(--ink-tertiary)' }}
                />
                {includeDeletedInTotals ? 'Included in totals & CSV' : 'Excluded from totals'}
              </button>
              {hooksActive && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono bg-[var(--accent-sky-soft)] border border-[var(--accent-sky-border)] text-[var(--accent-sky)]"
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
          onClick={() => dialogRef.current?.close()}
          aria-label="Close deleted chats popup"
          className="group p-1.5 rounded-lg text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)] hover:bg-[var(--table-hover)] transition-colors duration-200 cursor-pointer shrink-0"
        >
          <X className="w-4 h-4 transition-transform duration-200 group-hover:rotate-90 motion-reduce:transition-none" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain sm:overflow-hidden sm:flex sm:flex-col">
        {/* Responsive Summary Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3 px-3.5 sm:px-5 py-3 border-b border-[var(--border-hairline)] bg-transparent shrink-0">
          <div className="glass-subcard rounded-lg px-2.5 sm:px-3 py-2 min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--ink-tertiary)] truncate">
              Deleted Chats
            </div>
            <div className="text-base sm:text-lg font-bold font-mono tabular text-[var(--ink-primary)] mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              <span>{deletedSessions.length}</span>
              {legacyDeletedCount > 0 && (
                <span className="text-[10px] font-normal text-[var(--ink-tertiary)] whitespace-nowrap">
                  ({trackedDeletedCount} tracked · {legacyDeletedCount} legacy)
                </span>
              )}
            </div>
          </div>

          <div className="glass-subcard rounded-lg px-2.5 sm:px-3 py-2 min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--ink-tertiary)] truncate">
              API Cost Preserved
            </div>
            <div className="text-base sm:text-lg font-bold font-mono tabular text-[var(--accent-teal)] mt-0.5 truncate">
              {formatMoney(deletedCostUSD, currency)}
            </div>
          </div>

          <div className="col-span-2 sm:col-span-1 glass-subcard rounded-lg px-2.5 sm:px-3 py-2 min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--ink-tertiary)] truncate">
              Tokens / Cache Saved
            </div>
            <div className="text-xs sm:text-sm font-semibold font-mono tabular text-[var(--ink-primary)] mt-1 truncate">
              {fmtTokens(deletedTokens)}{' '}
              <span className="text-[var(--accent-violet)] text-[11px] sm:text-xs">
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
              <div className="px-3.5 sm:px-5 py-2 border-b border-[var(--border-hairline)] bg-[var(--accent-amber-soft)] text-[10.5px] sm:text-[11px] text-[var(--accent-amber)] font-mono leading-relaxed">
                {legacyDeletedCount} older chat(s) were deleted before burnrate archived their logs (shown as N/A). New chats are snapshotted automatically via offline hooks even when burnrate is closed.
              </div>
            </div>
          </div>
        )}

        {/* Search Bar & Legacy Actions */}
        {(deletedSessions.length > 0 || dismissedLegacyCount > 0) && (
          <div className="px-3.5 sm:px-5 py-2.5 sm:py-3 border-b border-[var(--border-hairline)] bg-[var(--bg-modal-band)] flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 shrink-0">
            {deletedSessions.length > 0 && (
              <div className="relative w-full sm:flex-1 sm:min-w-[180px]">
                <Search className="w-3.5 h-3.5 text-[var(--ink-tertiary)] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search deleted chat, workspace, model..."
                  className="glass-input w-full h-8 pl-8 pr-7 rounded-lg text-xs font-mono transition-colors duration-200"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear deleted chats search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
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
                      ? 'bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber)]'
                      : 'glass-control text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  {hideLegacyDeleted ? (
                    <Eye className="w-3.5 h-3.5 text-[var(--accent-amber)]" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5 text-[var(--ink-tertiary)]" />
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
                      className="h-8 px-2.5 rounded-lg border bg-[var(--accent-rose-soft)] border-[var(--accent-rose-border)] text-[var(--accent-rose)] font-medium text-xs font-mono flex items-center gap-1.5 transition-all duration-200 active:scale-[0.98] disabled:opacity-50 cursor-pointer select-none"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Confirm ({visibleLegacySessions.length})</span>
                    </button>
                    <button
                      type="button"
                      disabled={isClearingLegacyBulk}
                      onClick={() => setConfirmClearLegacy(false)}
                      aria-label="Cancel clear legacy chats"
                      className="h-8 w-8 rounded-lg glass-control text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={isClearingLegacyBulk}
                    onClick={() => setConfirmClearLegacy(true)}
                    className="h-8 px-2.5 rounded-lg glass-control text-[var(--ink-secondary)] hover:border-[var(--accent-rose-border)] hover:bg-[var(--accent-rose-soft)] hover:text-[var(--accent-rose)] text-xs font-mono flex items-center gap-1.5 transition-all duration-200 active:scale-[0.98] disabled:opacity-50 cursor-pointer select-none"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-[var(--accent-rose)]" />
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
                  className="h-8 px-2.5 rounded-lg glass-control text-[var(--ink-secondary)] hover:border-[var(--accent-teal-border)] hover:bg-[var(--accent-teal-soft)] hover:text-[var(--accent-teal)] text-xs font-mono flex items-center gap-1.5 transition-all duration-200 active:scale-[0.98] disabled:opacity-50 cursor-pointer select-none"
                >
                  <RotateCcw className={`w-3.5 h-3.5 text-[var(--accent-teal)] ${isRestoringLegacy ? 'animate-spin' : ''}`} />
                  <span>Restore ({dismissedLegacyCount})</span>
                </button>
              )}

              {(searchQuery.trim() || hideLegacyDeleted) && deletedSessions.length > 0 && (
                <span className="text-[11px] font-mono text-[var(--ink-tertiary)] ml-auto sm:ml-0">
                  {visibleDeletedSessions.length}/{deletedSessions.length}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Scrollable Deleted Chats List */}
        <div className="sm:flex-1 sm:min-h-0 sm:overflow-y-auto sm:overscroll-contain p-3.5 sm:p-5 space-y-2.5">
          {deletedSessions.length === 0 ? (
            <div className="py-10 text-center space-y-2">
              <div className="w-10 h-10 rounded-full glass-control flex items-center justify-center mx-auto text-[var(--ink-tertiary)]">
                <Trash2 className="w-4 h-4" />
              </div>
              <p className="text-xs font-medium text-[var(--ink-primary)]">No deleted chats in this filter</p>
              <p className="text-[11px] text-[var(--ink-tertiary)] max-w-sm mx-auto">
                Whenever you delete a chat in Antigravity, Claude Code or Codex CLI, its API spend and models stay archived here automatically.
              </p>
            </div>
          ) : visibleDeletedSessions.length === 0 ? (
            <div className="py-10 text-center space-y-2">
              <p className="text-xs font-mono text-[var(--ink-secondary)]">
                {searchQuery.trim()
                  ? `No deleted chats matching "${searchQuery.trim()}".`
                  : 'No tracked deleted chats yet (legacy chats are hidden).'}
              </p>
              <div className="flex items-center justify-center gap-3">
                {searchQuery.trim() && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="text-[11px] font-mono text-[var(--accent-teal)] hover:underline underline-offset-2 cursor-pointer"
                  >
                    Clear search
                  </button>
                )}
                {hideLegacyDeleted && legacyDeletedCount > 0 && (
                  <button
                    type="button"
                    onClick={onToggleHideLegacy}
                    className="text-[11px] font-mono text-[var(--accent-amber)] hover:underline underline-offset-2 cursor-pointer"
                  >
                    Show legacy ({legacyDeletedCount})
                  </button>
                )}
              </div>
            </div>
          ) : (
            visibleDeletedSessions.map((chat) => {
              const delTs = fmtPreciseDate(chat.deletedAt || chat.lastActiveAt);
              const chatModels = getSessionModelBreakdown(chat.turnHistory);
              const chatSubagents = getSessionSubagentBreakdown(chat.turnHistory).subagents;
              const isLegacy = Boolean(chat.untrackedHistory);
              const chatKey = `${chat.source}:${chat.sessionId}`;
              const isDismissing = dismissingLegacyKeys.has(chatKey);

              return (
                <div
                  key={chatKey}
                  className={`glass-subcard rounded-xl p-3 sm:p-3.5 transition-all duration-150 hover:border-[var(--border-strong)] ${
                    isDismissing ? 'opacity-45 scale-[0.99] pointer-events-none' : ''
                  } ${isLegacy ? 'opacity-85' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2.5 sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="text-xs font-semibold text-[var(--ink-primary)] line-clamp-2 sm:truncate break-words min-w-0"
                          title={chat.sessionTitle || chat.sessionId}
                        >
                          {chat.sessionTitle || chat.sessionId}
                        </span>
                        <CompactSourceBadge source={chat.source} />
                        {isLegacy && (
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border border-[var(--accent-amber-border)] whitespace-nowrap"
                            title="Deleted before burnrate archived its token log"
                          >
                            Legacy · no token log
                          </span>
                        )}
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-[var(--ink-tertiary)]">
                        <span className="inline-flex items-center gap-1 text-[var(--ink-secondary)] max-w-full truncate" title={chat.workspace}>
                          <FolderGit2 className="w-3 h-3 text-[var(--ink-tertiary)] shrink-0" />
                          <span className="truncate">{chat.workspaceName}</span>
                        </span>
                        <span>•</span>
                        <span>
                          {chat.turns} {isLegacy ? 'prompts' : 'turns'}
                        </span>
                        {!isLegacy && (
                          <>
                            <span>•</span>
                            <span>{fmtTokens(chat.totalTokens)} tok</span>
                          </>
                        )}
                        <span>•</span>
                        <span
                          className="text-[var(--accent-rose)]"
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
                            className="text-xs font-mono text-[var(--ink-tertiary)]"
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
                            className="h-8 w-8 sm:h-7 sm:w-7 rounded-lg glass-control text-[var(--ink-tertiary)] hover:text-[var(--accent-rose)] hover:bg-[var(--accent-rose-soft)] hover:border-[var(--accent-rose-border)] flex items-center justify-center transition-all duration-150 active:scale-95 disabled:opacity-40 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="text-sm font-bold font-mono tabular text-[var(--accent-teal)]">
                            {formatMoney(chat.costUSD, currency)}
                          </div>
                          {chat.cacheSavingsUSD > 0 && (
                            <div className="text-[10px] font-mono tabular text-[var(--accent-violet)]">
                              +{formatMoney(chat.cacheSavingsUSD, currency)} saved
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {(chatModels.length > 0 || chatSubagents.length > 0) && (
                    <div className="mt-2.5 pt-2 border-t border-[var(--border-hairline)] flex flex-wrap items-center gap-1.5">
                      {chatModels.map((m) => (
                        <span
                          key={m.modelLabel}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md glass-control text-[10px] font-mono text-[var(--ink-secondary)]"
                        >
                          <span>{m.modelLabel}</span>
                          <span className="text-[var(--accent-teal)] font-semibold">
                            {formatMoney(m.costUSD, currency)}
                          </span>
                        </span>
                      ))}
                      {chatSubagents.map((sub) => {
                        const isBtw = sub.subagentName === '/btw';
                        return (
                          <span
                            key={sub.subagentId}
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono border ${
                              isBtw
                                ? 'bg-[var(--accent-sky-soft)] border-[var(--accent-sky-border)] text-[var(--accent-sky)]'
                                : 'bg-[var(--accent-violet-soft)] border-[var(--accent-violet-border)] text-[var(--accent-violet)]'
                            }`}
                            title={`${isBtw ? 'Side-chat' : 'Subagent'}: ${sub.subagentName} · ${sub.turns}t · ${fmtTokens(sub.totalTokens)} tok`}
                          >
                            {isBtw ? (
                              <MessageSquare className="w-2.5 h-2.5 shrink-0" />
                            ) : (
                              <Bot className="w-2.5 h-2.5 shrink-0" />
                            )}
                            <span>{sub.subagentName}</span>
                            <span className="text-[var(--ink-tertiary)]">· {sub.turns}t</span>
                            <span className="text-[var(--accent-teal)] font-semibold">
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
    </dialog>
  );
}
