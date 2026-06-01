import type { AuditEvent, AuditInput, AuditQuery } from "./types.ts";

/**
 * Minimal SQL surface satisfied by BOTH backends with a thin adapter:
 *   - node:sqlite `DatabaseSync` (the runnable unit test), and
 *   - Durable Object `ctx.storage.sql` (production).
 * Keeping the store dependent only on this interface lets the exact same
 * append/filter/search logic run in a bare-node test and inside the DO.
 */
export interface SqlDriver {
  /** Run one DDL statement (CREATE TABLE/INDEX/TRIGGER/VIRTUAL TABLE). */
  ddl(sql: string): void;
  /** Run one read (or `... RETURNING`) statement with positional params; returns rows. */
  all<T = Record<string, unknown>>(sql: string, params: unknown[]): T[];
}

// One statement per entry so both drivers can run them individually.
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS audit (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     id         TEXT    NOT NULL,
     ts         INTEGER NOT NULL,
     type       TEXT    NOT NULL,
     level      TEXT    NOT NULL,
     session_id TEXT,
     text       TEXT    NOT NULL,
     payload    TEXT    NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS audit_type    ON audit(type)`,
  `CREATE INDEX IF NOT EXISTS audit_ts      ON audit(ts)`,
  `CREATE INDEX IF NOT EXISTS audit_session ON audit(session_id)`,
  // External-content FTS index over the human-readable summary.
  `CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts
     USING fts5(text, content='audit', content_rowid='seq')`,
  // Append-only, so a single AFTER INSERT trigger keeps the index in sync.
  `CREATE TRIGGER IF NOT EXISTS audit_fts_ai AFTER INSERT ON audit BEGIN
     INSERT INTO audit_fts(rowid, text) VALUES (new.seq, new.text);
   END`,
];

const MAX_LIMIT = 1000;

/**
 * Per-agent, append-only audit store. Streamable (via seq cursor), filterable
 * (query), and searchable (FTS5). The DO is already one-per-agent, so rows
 * carry no agentId column - it's stamped from the constructor on read.
 */
export class AuditStore {
  private readonly db: SqlDriver;
  private readonly agentId: string;

  constructor(db: SqlDriver, agentId: string) {
    this.db = db;
    this.agentId = agentId;
  }

  init(): void {
    for (const stmt of SCHEMA) this.db.ddl(stmt);
  }

  /** Append one event; returns it with the assigned seq/id/ts. */
  append(input: AuditInput): AuditEvent {
    const ts = Date.now();
    const id = newId();
    const level: AuditEvent["level"] = input.level ?? "info";
    const sessionId = input.sessionId ?? null;
    const payloadJson = JSON.stringify(input.payload ?? {});

    // RETURNING avoids last_insert_rowid() ambiguity created by the FTS trigger.
    const rows = this.db.all<{ seq: number }>(
      `INSERT INTO audit(id, ts, type, level, session_id, text, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      [id, ts, input.type, level, sessionId, input.text, payloadJson],
    );

    return {
      seq: rows[0].seq,
      id,
      agentId: this.agentId,
      ts,
      type: input.type,
      level,
      sessionId,
      text: input.text,
      payload: input.payload ?? {},
    };
  }

  /** Structured filter, ordered by seq ascending (chronological). */
  query(q: AuditQuery = {}): AuditEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.types?.length) {
      where.push(`type IN (${q.types.map(() => "?").join(",")})`);
      params.push(...q.types);
    }
    if (q.level) {
      where.push(`level = ?`);
      params.push(q.level);
    }
    if (q.sessionId) {
      where.push(`session_id = ?`);
      params.push(q.sessionId);
    }
    if (q.sinceSeq != null) {
      where.push(`seq > ?`);
      params.push(q.sinceSeq);
    }
    if (q.fromTs != null) {
      where.push(`ts >= ?`);
      params.push(q.fromTs);
    }
    if (q.toTs != null) {
      where.push(`ts <= ?`);
      params.push(q.toTs);
    }

    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(q.limit ?? 100, MAX_LIMIT);
    const rows = this.db.all(
      `SELECT * FROM audit ${clause} ORDER BY seq ASC LIMIT ?`,
      [...params, limit],
    );
    return rows.map((r) => this.hydrate(r));
  }

  /** Full-text search over `text` (FTS5). Newest first. */
  search(text: string, limit = 50): AuditEvent[] {
    // Quote as a phrase so user punctuation can't break MATCH syntax.
    const term = `"${text.replace(/"/g, '""')}"`;
    const rows = this.db.all(
      `SELECT a.* FROM audit_fts f JOIN audit a ON a.seq = f.rowid
       WHERE audit_fts MATCH ? ORDER BY a.seq DESC LIMIT ?`,
      [term, Math.min(limit, 200)],
    );
    return rows.map((r) => this.hydrate(r));
  }

  private hydrate(r: Record<string, unknown>): AuditEvent {
    return {
      seq: r.seq as number,
      id: r.id as string,
      agentId: this.agentId,
      ts: r.ts as number,
      type: r.type as AuditEvent["type"],
      level: r.level as AuditEvent["level"],
      sessionId: (r.session_id as string | null) ?? null,
      text: r.text as string,
      payload: JSON.parse(r.payload as string),
    };
  }
}

/** Sortable-ish id; canonical ordering is `seq`. Swap for ULID when we add deps. */
function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
