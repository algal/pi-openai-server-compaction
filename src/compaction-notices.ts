/**
 * UI-neutral notice state for surfacing remote compaction outcomes.
 *
 * This module deliberately has no TUI dependency. Rendering belongs at the
 * extension edge; these helpers only define notice text and per-session
 * pending state.
 */

export const OPENAI_COMPACTION_NOTICE_ENTRY_TYPE = "openai-compaction";

export type CompactionNotice = "remote-applied" | "pi-text-fallback";

const NOTICE_LABELS: Record<CompactionNotice, string> = {
  "remote-applied": "[openai-compaction] remote compaction applied",
  "pi-text-fallback": "[openai-compaction] remote failed; used Pi text compaction",
};

export function compactionNoticeLabel(notice: CompactionNotice): string {
  return NOTICE_LABELS[notice];
}

export type PendingCompactionNotices = {
  set(sessionId: string, notice: CompactionNotice): void;
  take(sessionId: string): CompactionNotice | undefined;
  clear(sessionId: string): void;
  clearAll(): void;
};

export function createPendingCompactionNotices(): PendingCompactionNotices {
  const notices = new Map<string, CompactionNotice>();

  return {
    set(sessionId, notice) {
      notices.set(sessionId, notice);
    },
    take(sessionId) {
      const notice = notices.get(sessionId);
      notices.delete(sessionId);
      return notice;
    },
    clear(sessionId) {
      notices.delete(sessionId);
    },
    clearAll() {
      notices.clear();
    },
  };
}
