/**
 * Runnable here with zero install:
 *   node --experimental-sqlite --test test/audit-store.test.ts
 *
 * Exercises the audit log's load-bearing logic (append / filter / FTS search)
 * against node:sqlite. The SAME AuditStore runs in the DO via ctx.storage.sql.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AuditStore, type SqlDriver } from "../src/audit/store.ts";

/** node:sqlite adapter - the test-side implementation of SqlDriver. */
class NodeDriver implements SqlDriver {
  private db = new DatabaseSync(":memory:");
  ddl(sql: string): void {
    this.db.prepare(sql).run();
  }
  all<T>(sql: string, params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
}

function freshStore(): AuditStore {
  const store = new AuditStore(new NodeDriver(), "agent-test");
  store.init();
  return store;
}

test("append assigns monotonic seq and stamps agentId + payload", () => {
  const s = freshStore();
  const a = s.append({ type: "narration", text: "starting research on Acme" });
  const b = s.append({
    type: "source.read",
    level: "milestone",
    text: "read TechCrunch on Acme",
    payload: { url: "https://techcrunch.com/acme" },
  });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(a.agentId, "agent-test");
  assert.equal(a.level, "info"); // default
  assert.equal(b.payload.url, "https://techcrunch.com/acme");
});

test("query filters by level (the milestone altitude) and by type", () => {
  const s = freshStore();
  s.append({ type: "narration", text: "thinking out loud" });
  s.append({
    type: "memory.wrote",
    level: "milestone",
    text: "wrote neuron acme.md",
  });
  s.append({
    type: "memory.linked",
    level: "milestone",
    text: "linked acme.md -> funding.md",
  });

  assert.equal(s.query({ level: "milestone" }).length, 2);
  const writes = s.query({ types: ["memory.wrote"] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].type, "memory.wrote");
});

test("query supports seq cursor (sinceSeq) for incremental/live streaming", () => {
  const s = freshStore();
  for (let i = 0; i < 5; i++)
    s.append({ type: "narration", text: `step ${i}` });
  const tail = s.query({ sinceSeq: 3 });
  assert.deepEqual(
    tail.map((e) => e.seq),
    [4, 5],
  );
});

test("query filters by time window", () => {
  const s = freshStore();
  const first = s.append({ type: "narration", text: "old" });
  s.append({ type: "narration", text: "new" });
  assert.ok(s.query({ fromTs: first.ts }).length >= 1);
  assert.equal(s.query({ toTs: 0 }).length, 0);
});

test("search does full-text retrieval over text via FTS5", () => {
  const s = freshStore();
  s.append({
    type: "source.read",
    level: "milestone",
    text: "Acme raised a Series B led by Sequoia",
  });
  s.append({
    type: "source.read",
    level: "milestone",
    text: "Globex shipped a new product",
  });

  const hits = s.search("series");
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /Series B/);
  assert.equal(s.search("Sequoia").length, 1);
  assert.equal(s.search("nonexistentterm").length, 0);
});

test("search is injection-safe against FTS punctuation/operators", () => {
  const s = freshStore();
  s.append({ type: "report.generated", text: "report: q2-2026 (final)" });
  assert.doesNotThrow(() => s.search("q2-2026 (final)"));
  assert.doesNotThrow(() => s.search('"unbalanced AND OR'));
});
