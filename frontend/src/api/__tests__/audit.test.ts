import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUrl, installFetchMock, jsonResponse } from "../../test/apiMock";
import type { BackendAuditEvent } from "../audit";
import { fetchAuditPage, searchAudit, toAuditEvent } from "../audit";

function row(over: Partial<BackendAuditEvent> = {}): BackendAuditEvent {
  return {
    seq: 1,
    id: "e1",
    agentId: "a1",
    ts: 0,
    type: "session.started",
    level: "milestone",
    sessionId: "s1",
    text: "started",
    payload: {},
    ...over,
  };
}

describe("audit - toAuditEvent mapping", () => {
  it("maps epoch ms → ISO and carries summary from text", () => {
    const ev = toAuditEvent(row({ ts: 0, text: "hi" }));
    expect(ev.ts).toBe("1970-01-01T00:00:00.000Z");
    expect(ev.summary).toBe("hi");
  });

  it("coerces a null sessionId to an empty string", () => {
    expect(toAuditEvent(row({ sessionId: null })).sessionId).toBe("");
  });

  it("drops an empty payload (no detail to disclose) but keeps a non-empty one", () => {
    expect(toAuditEvent(row({ payload: {} })).detail).toBeUndefined();
    expect(toAuditEvent(row({ payload: { command: "ls" } })).detail).toEqual({
      command: "ls",
    });
  });
});

describe("audit - fetchAuditPage", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds the query string from every filter + cursor option", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await fetchAuditPage("a1", {
      sinceSeq: 7,
      type: ["tool.ran", "report.generated"],
      level: "all",
      sessionId: "s9",
      from: 100,
      to: 200,
      limit: 50,
    });
    const url = fetchUrl(fetchMock);
    expect(url).toContain("/agents/a1/audit/events?");
    expect(url).toContain("sinceSeq=7");
    expect(url).toContain("type=tool.ran");
    expect(url).toContain("type=report.generated");
    expect(url).toContain("level=all");
    expect(url).toContain("sessionId=s9");
    expect(url).toContain("fromTs=100");
    expect(url).toContain("toTs=200");
    expect(url).toContain("limit=50");
  });

  it("derives nextSeq from the last row and maps events", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([row({ seq: 3 }), row({ seq: 8 })]),
    );
    const page = await fetchAuditPage("a1");
    expect(page.events).toHaveLength(2);
    expect(page.nextSeq).toBe(8);
  });

  it("keeps the requested sinceSeq as nextSeq on an empty page", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    expect((await fetchAuditPage("a1", { sinceSeq: 42 })).nextSeq).toBe(42);
    expect((await fetchAuditPage("a1")).nextSeq).toBe(0);
  });
});

describe("audit - searchAudit", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("passes q (+ optional limit) and maps the rows", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row({ seq: 5 })]));
    const out = await searchAudit("a1", "boom", { limit: 10 });
    const url = fetchUrl(fetchMock);
    expect(url).toContain("/agents/a1/audit/search?");
    expect(url).toContain("q=boom");
    expect(url).toContain("limit=10");
    expect(out[0].seq).toBe(5);
  });
});
