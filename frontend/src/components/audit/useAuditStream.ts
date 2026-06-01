/**
 * useAuditStream (MNEMO-37) - the live audit-tail lifecycle for one agent.
 *
 * Given an `agentId`, the active `filters`, and the altitude `level`, it:
 *   1. loads an initial page via `fetchAuditPage`,
 *   2. opens the live SSE tail from that page's last seq (`openAuditStream`),
 *   3. merges incoming events deduped + ordered by `seq`, capping the in-memory
 *      buffer (newest kept) and exposing "load older" to page back down via the
 *      `fetchAuditPage` cursor.
 *
 * The hook OWNS all lifecycle: changing `agentId`/`filters`/`level` re-subscribes
 * cleanly (closes the old handle, resets, reloads), so components stay declarative
 * and just render `{ events, status, loadOlder, hasOlder }`.
 *
 * NB on paging: MNEMO-22's `/events` is a FORWARD cursor (`seq > sinceSeq`, ascending),
 * so the initial page loads the oldest slice and the stream's backfill-from-cursor
 * fills the gap to live - gapless, no dupes. "Load older" walks a seq window
 * backward via the same forward cursor; with type/session filters seqs are sparse,
 * so the window cursor advances every call (the control never gets stuck).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AuditAltitude,
  type AuditEvent,
  type AuditFilters,
  fetchAuditPage,
} from "@/api/audit";
import {
  type AuditStreamHandle,
  type AuditStreamStatus,
  openAuditStream,
} from "@/api/auditStream";

/** Initial + per-"load older" page size. */
const PAGE_SIZE = 100;
/** Max events held in memory from the live tail (newest kept; older paged back in). */
const BUFFER_CAP = 1000;

export interface UseAuditStreamResult {
  /** Events ascending by seq (newest at the bottom of the list). */
  events: AuditEvent[];
  /** Live-tail connection status. */
  status: AuditStreamStatus;
  /** Fetch the page of events just older than the current oldest, prepending them. */
  loadOlder: () => void;
  /** Whether older events than the current oldest may exist (drives the trigger). */
  hasOlder: boolean;
  /** True while a `loadOlder` fetch is in flight. */
  loadingOlder: boolean;
  /** True until the initial page has loaded (drives the first-paint skeleton). */
  loading: boolean;
}

/** Merge `incoming` into `existing`, dedupe by seq, sort ascending. */
function mergeBySeq(
  existing: AuditEvent[],
  incoming: AuditEvent[],
): AuditEvent[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, AuditEvent>();
  for (const e of existing) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function useAuditStream(
  agentId: string,
  filters: AuditFilters,
  level: AuditAltitude,
): UseAuditStreamResult {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [status, setStatus] = useState<AuditStreamStatus>("connecting");
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);

  // The lower bound we've paged back to (the `sinceSeq` of the oldest fetch).
  const olderCursorRef = useRef(0);

  // Stabilize `filters` by its NORMALIZED content, not its object identity: a
  // caller that passes a fresh `{}` (or a new array) every render must not thrash
  // the subscription. `stableFilters` keeps the same reference until the content
  // actually changes, so the subscribe effect re-runs only on a real filter edit.
  const filtersKey = JSON.stringify({
    type: filters.type ? [...filters.type].sort() : null,
    sessionId: filters.sessionId ?? null,
    from: filters.from ?? null,
    to: filters.to ?? null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity intentionally tracks the serialized content (filtersKey), not the object reference.
  const stableFilters = useMemo(() => filters, [filtersKey]);

  // (Re)subscribe whenever the agent, filters, or altitude change. The effect
  // closes the prior handle on cleanup, so a level/filter flip never leaves two
  // live tails running or interleaves their events.
  useEffect(() => {
    let cancelled = false;
    let handle: AuditStreamHandle | null = null;

    setEvents([]);
    setLoading(true);
    setHasOlder(false);
    setStatus("connecting");

    const wireFilters = {
      type: stableFilters.type,
      sessionId: stableFilters.sessionId,
    };

    fetchAuditPage(agentId, {
      ...stableFilters,
      level,
      limit: PAGE_SIZE,
    })
      .then((page) => {
        if (cancelled) return;
        setEvents(page.events);
        setLoading(false);
        // The oldest seq we hold; if it's above the very first event, older exist.
        const oldest = page.events[0]?.seq ?? 0;
        olderCursorRef.current = oldest;
        setHasOlder(oldest > 1);

        handle = openAuditStream(
          agentId,
          { sinceSeq: page.nextSeq, filters: { ...wireFilters, level } },
          (event) => {
            if (cancelled) return;
            setEvents((prev) => {
              const merged = mergeBySeq(prev, [event]);
              // Cap the live buffer to the newest BUFFER_CAP; older ones can be
              // paged back in via loadOlder. Only trims on live appends, never
              // fighting an explicit "load older".
              if (merged.length > BUFFER_CAP) {
                const trimmed = merged.slice(merged.length - BUFFER_CAP);
                setHasOlder(true);
                return trimmed;
              }
              return merged;
            });
          },
          (s) => {
            if (!cancelled) setStatus(s);
          },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        setStatus("closed");
      });

    return () => {
      cancelled = true;
      handle?.close();
    };
  }, [agentId, level, stableFilters]);

  const loadOlder = useCallback(() => {
    const from = Math.max(0, olderCursorRef.current - PAGE_SIZE);
    if (from === olderCursorRef.current) {
      setHasOlder(false);
      return;
    }
    setLoadingOlder(true);
    fetchAuditPage(agentId, {
      ...stableFilters,
      level,
      sinceSeq: from,
      limit: PAGE_SIZE,
    })
      .then((page) => {
        setEvents((prev) => mergeBySeq(prev, page.events));
        olderCursorRef.current = from;
        setHasOlder(from > 0);
      })
      .finally(() => setLoadingOlder(false));
  }, [agentId, stableFilters, level]);

  return { events, status, loadOlder, hasOlder, loadingOlder, loading };
}
