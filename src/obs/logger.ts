/**
 * Structured JSON logging (MNEMO-50, PRD §3).
 *
 * Observability is **structured JSON logs** - one `JSON.stringify` line per event,
 * written to `console`, which the Workers runtime captures into Logpush for
 * querying. No external deps, no heavyweight APM: a log line is a flat object the
 * edge can index and filter.
 *
 * Every line carries `{ ts, level, event, ...fields }`. The well-known correlation
 * fields - `requestId` (minted at the edge by {@link requestContext}), `accountId`,
 * `agentId` - ride in as ordinary `fields`/bound context, so a single grep on
 * `requestId` stitches a request together across the Worker, the DO, and the audit
 * log. Bind them ONCE with {@link withContext} and every subsequent line inherits
 * them.
 */

/** Severity ordering matches the usual syslog-ish levels; `error` is the only one the gate reacts to. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Arbitrary structured fields merged into a log line. Keep values JSON-serializable. */
export type LogFields = Record<string, unknown>;

/** A logger with bound context - returned by {@link withContext}. */
export interface Logger {
  /** Emit one line at `level` for `event`, merging the bound context with `fields`. */
  log(level: LogLevel, event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Derive a child logger with additional bound context (the parent's wins on key clash via spread order). */
  withContext(extra: LogFields): Logger;
  /** The context bound to this logger (read for tests / propagation). */
  readonly fields: LogFields;
}

/**
 * Emit a single structured JSON log line to `console`. `ts`/`level`/`event` lead;
 * the well-known `requestId`/`accountId`/`agentId` (when present) and any other
 * fields follow. One line per event so Logpush captures it whole.
 */
export function log(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  // Structured logs ARE the observability sink - the Workers runtime captures
  // console JSON into Logpush. One line per event.
  console.log(JSON.stringify({ ts: Date.now(), level, event, ...fields }));
}

/**
 * Bind a base set of fields (typically `{ requestId }`, later `{ accountId }` /
 * `{ agentId }`) and return a scoped {@link Logger} whose every line carries them.
 * `withContext` on the result composes further - the new context is layered on top.
 */
export function withContext(base: LogFields = {}): Logger {
  const bound: LogFields = { ...base };
  const scopedLog = (
    level: LogLevel,
    event: string,
    fields?: LogFields,
  ): void => {
    log(level, event, { ...bound, ...fields });
  };
  return {
    fields: bound,
    log: scopedLog,
    debug: (event, fields) => scopedLog("debug", event, fields),
    info: (event, fields) => scopedLog("info", event, fields),
    warn: (event, fields) => scopedLog("warn", event, fields),
    error: (event, fields) => scopedLog("error", event, fields),
    withContext: (extra) => withContext({ ...bound, ...extra }),
  };
}

/**
 * Mint a request id at the edge. Reuses the sortable-ish `newId()` shape from
 * `src/audit/store.ts` (time prefix + random suffix) - canonical, dependency-free,
 * good enough to correlate a request across services without pulling in a UUID lib.
 */
export function newRequestId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
