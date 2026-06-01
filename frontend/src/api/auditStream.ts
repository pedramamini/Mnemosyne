/**
 * Audit SSE stream client (MNEMO-37) - the live tail behind the glass cockpit.
 *
 * Uses `fetch` + a `ReadableStream` reader rather than `EventSource` because the
 * tail must send `credentials: "include"` (the MNEMO-03 session cookie) and pass
 * `sinceSeq`/filters as query params - `EventSource` can set neither cleanly.
 * Frames are the MNEMO-22 SSE shape (`id: <seq>\nevent: <type>\ndata: <json>\n\n`);
 * we parse the `data:` line into a `BackendAuditEvent` and map it via the shared
 * {@link toAuditEvent} so the stream and the REST adapter agree on one wire shape.
 *
 * On disconnect we auto-reconnect with exponential backoff, resuming from the
 * HIGHEST `seq` seen (passed as `?sinceSeq=`). MNEMO-22 backfills the missed gap
 * (`seq > sinceSeq`) into the new stream BEFORE the live tail resumes, so a
 * reconnect never drops or duplicates an event (§6.7). Connection status is
 * surfaced via `onStatus`; keep-alive comment lines (`:`-prefixed) are tolerated.
 */

import {
  type AuditAltitude,
  type AuditEvent,
  type AuditEventType,
  type BackendAuditEvent,
  toAuditEvent,
} from "./audit";
import { apiUrl } from "./client";

/** Lifecycle of the live tail, surfaced to the UI's status indicator. */
export type AuditStreamStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed";

/** Server-side filters applied to the live tail (type/altitude/session). */
export interface AuditStreamFilters {
  type?: AuditEventType[];
  /** Altitude - `milestone` (calm) or `all` (Show the work). Omit ⇒ backend default. */
  level?: AuditAltitude;
  sessionId?: string;
}

/** Open options: where to resume from + the live filters. */
export interface OpenAuditStreamOptions {
  /** Resume cursor - backfill `seq > sinceSeq` before the live tail. */
  sinceSeq?: number;
  filters?: AuditStreamFilters;
}

/** Handle to a live stream; call `close()` to stop and release the socket. */
export interface AuditStreamHandle {
  close(): void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * Open the audit SSE tail for `agentId`. Calls `onEvent` for each parsed event
 * and `onStatus` on every lifecycle transition. Returns a handle whose `close()`
 * aborts the in-flight request, cancels any pending reconnect, and emits `closed`.
 */
export function openAuditStream(
  agentId: string,
  opts: OpenAuditStreamOptions,
  onEvent: (event: AuditEvent) => void,
  onStatus: (status: AuditStreamStatus) => void,
): AuditStreamHandle {
  let closed = false;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  // The highest seq delivered so far - the reconnect cursor. Seeded from the
  // initial page's `nextSeq` so the first connect backfills onward from there.
  let lastSeq: number | undefined = opts.sinceSeq;

  function buildUrl(): string {
    const params = new URLSearchParams();
    if (lastSeq != null) params.set("sinceSeq", String(lastSeq));
    for (const t of opts.filters?.type ?? []) params.append("type", t);
    if (opts.filters?.level) params.set("level", opts.filters.level);
    if (opts.filters?.sessionId)
      params.set("sessionId", opts.filters.sessionId);
    const qs = params.toString();
    return apiUrl(
      `/agents/${encodeURIComponent(agentId)}/audit/stream${qs ? `?${qs}` : ""}`,
    );
  }

  /** Parse one `\n\n`-terminated SSE frame and deliver its event (if any). */
  function handleFrame(frame: string): void {
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.length === 0 || line.startsWith(":")) continue; // keep-alive/comment
      if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
      // `id:`/`event:` are informational - the seq lives in the JSON payload.
    }
    if (!data) return;
    try {
      const event = toAuditEvent(JSON.parse(data) as BackendAuditEvent);
      lastSeq = lastSeq == null ? event.seq : Math.max(lastSeq, event.seq);
      onEvent(event);
    } catch {
      // Tolerate a partial/non-JSON frame; the next read completes it.
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    onStatus("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    try {
      const res = await fetch(buildUrl(), {
        credentials: "include",
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`audit stream ${res.status}`);

      onStatus("live");
      backoff = INITIAL_BACKOFF_MS; // reset after a clean connect

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          handleFrame(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Network error / aborted - fall through to the reconnect path below.
    }
    if (closed) return;
    scheduleReconnect();
  }

  onStatus("connecting");
  void connect();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller?.abort();
      onStatus("closed");
    },
  };
}
