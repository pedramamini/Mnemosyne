import type { SqlDriver } from "./store.ts";

/**
 * Production twin of the `NodeDriver` test adapter in `test/audit-store.test.ts`.
 *
 * Adapts a Durable Object `SqlStorage` handle (`ctx.storage.sql`) to the shared
 * {@link SqlDriver} surface (`ddl`/`all`) that the untouched `AuditStore`
 * consumes. The store's `SCHEMA` / `... RETURNING` / FTS5 usage is chosen for
 * parity between `node:sqlite` (the bare-node spike test) and `ctx.storage.sql`
 * (here), which is exactly why the same `AuditStore` logic runs in both backends
 * with no changes - this class supplies the production half of that contract.
 *
 * Pure adapter: no business logic. (A near-identical `sqlDriver` factory exists
 * in `src/agent/sql.ts` for the AGENT DO; the audit module keeps its own class
 * so it stays self-contained - `audit/` never imports the agent module.)
 */
export class DoSqlDriver implements SqlDriver {
  /**
   * The DO storage's SQL runner, bound once (mirrors `src/agent/sql.ts`). One
   * call form covers reads and writes; `RETURNING` rows come back via `toArray`,
   * empty otherwise - exactly as the node:sqlite test adapter behaves.
   */
  private readonly run: SqlStorage["exec"];

  constructor(sql: SqlStorage) {
    this.run = sql.exec.bind(sql);
  }

  /** Run one parameterless DDL statement (CREATE TABLE/INDEX/TRIGGER/VIRTUAL TABLE). */
  ddl(sql: string): void {
    this.run(sql);
  }

  /** Run one query with spread positional params; materialize the cursor as `T[]`. */
  all<T = Record<string, unknown>>(sql: string, params: unknown[]): T[] {
    return Array.from(this.run(sql, ...params)) as T[];
  }
}
