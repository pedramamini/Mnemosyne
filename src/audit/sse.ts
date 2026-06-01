import type { AuditEvent } from "./types.ts";

/**
 * SSE fan-out for the audit stream, decoupled from the DO so it is unit-testable
 * (PRD §8.6, the "glass cockpit" live tail). One {@link SseHub} tracks the live
 * subscriber stream controllers; `subscribe()` hands back a `text/event-stream`
 * `Response`, `publish()` writes each event to every subscriber.
 */

/**
 * Encode one audit event as a single SSE frame. Pure (no streams) so it can be
 * tested directly.
 *
 * The event `seq` is the SSE `id:`, so a browser's `Last-Event-ID` reconnect
 * header maps directly onto the store's `sinceSeq` cursor (PRD §6.7) - the tail
 * resumes exactly where the dropped socket left off, with no gaps or dupes.
 */
export function formatSseFrame(event: AuditEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Predicate deciding whether a live event reaches one subscriber (the
 * per-subscriber altitude/type/session filter, MNEMO-22). */
export type SseFilter = (event: AuditEvent) => boolean;

/** Options for one {@link SseHub.subscribe} call (MNEMO-22). */
export interface SubscribeOptions {
  /**
   * Reconnect backfill: events the client missed while disconnected (the store's
   * `sinceSeq` query). Written into the new stream as SSE frames BEFORE the
   * subscriber is registered for the live tail, so a reconnecting client gets the
   * gap first then resumes live - no duplicates, no gap (the DO emits nothing
   * between the backfill query and this synchronous registration).
   */
  backfill?: AuditEvent[];
  /**
   * Per-subscriber live filter. Applied in {@link SseHub.publish}; a live event
   * is delivered to this subscriber only when the predicate passes (mirrors the
   * filter used for the backfill query, so stream and backfill agree).
   */
  filter?: SseFilter;
}

/** One live subscriber: its stream controller plus its optional live filter. */
interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  filter?: SseFilter;
}

/**
 * In-memory fan-out of audit events to live SSE subscribers. Holds a set of
 * subscriber records (controller + filter); never persists anything - reconnect
 * backfill is the store's `sinceSeq` query, handed in via {@link SubscribeOptions}
 * - this is purely the live tail.
 */
export class SseHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly encoder = new TextEncoder();

  /**
   * Register a new subscriber and return the `text/event-stream` `Response` to
   * hand back to the client. On start the stream first drains any `backfill`
   * frames, THEN the subscriber is added to the live set - order matters for the
   * no-gap/no-dupe reconnect guarantee (see {@link SubscribeOptions.backfill}).
   * The subscriber is removed when the client disconnects (`cancel`).
   */
  subscribe(opts: SubscribeOptions = {}): Response {
    const subscribers = this.subscribers;
    const encoder = this.encoder;
    let entryRef: Subscriber | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Backfill BEFORE registering for live: the reconnecting client reads the
        // missed gap (in ascending seq), then the live tail resumes seamlessly.
        if (opts.backfill) {
          for (const event of opts.backfill) {
            controller.enqueue(encoder.encode(formatSseFrame(event)));
          }
        }
        entryRef = { controller, filter: opts.filter };
        subscribers.add(entryRef);
      },
      cancel() {
        if (entryRef) subscribers.delete(entryRef);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }

  /**
   * Serialize `event` as an SSE frame and write it to every live subscriber whose
   * filter passes, dropping any whose controller has errored/closed (so a dead
   * client never blocks the others).
   */
  publish(event: AuditEvent): void {
    const frame = this.encoder.encode(formatSseFrame(event));
    for (const sub of this.subscribers) {
      if (sub.filter && !sub.filter(event)) continue;
      try {
        sub.controller.enqueue(frame);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  /** Number of live subscribers (for tests/metrics). */
  get size(): number {
    return this.subscribers.size;
  }
}
