/**
 * MNEMO-50 - observability: structured logger, request context, metrics.
 *
 * `requestContext()` sets `x-request-id` and the SAME id appears in the
 * `http_request` access log; `log()`/`withContext()` emit valid single-line JSON
 * with bound context; `counter`/`timing` emit `metric` lines with the expected
 * name/value/tags. `console.log` is captured with a spy.
 */
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/auth/middleware.ts";
import { log, withContext } from "../src/obs/logger.ts";
import { counter, timing } from "../src/obs/metrics.ts";
import { requestContext } from "../src/obs/requestContext.ts";

/** Parse every captured console.log line as JSON; non-JSON lines are dropped. */
function jsonLines(
  spy: ReturnType<typeof vi.spyOn>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    try {
      out.push(JSON.parse(call[0] as string));
    } catch {
      // not a JSON log line
    }
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger", () => {
  it("log() emits a single valid JSON line with ts/level/event + fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("info", "thing_happened", { a: 1, b: "two" });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.level).toBe("info");
    expect(line.event).toBe("thing_happened");
    expect(line.a).toBe(1);
    expect(line.b).toBe("two");
    expect(typeof line.ts).toBe("number");
  });

  it("withContext() binds context onto every line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const scoped = withContext({ requestId: "req-123", accountId: "acct-9" });
    scoped.error("boom", { detail: "x" });
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.level).toBe("error");
    expect(line.event).toBe("boom");
    expect(line.requestId).toBe("req-123");
    expect(line.accountId).toBe("acct-9");
    expect(line.detail).toBe("x");
  });
});

describe("metrics", () => {
  it("counter() emits a metric line with kind=counter + value + tags", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    counter("widgets_made", 3, { color: "blue" });
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.event).toBe("metric");
    expect(line.metric).toBe("widgets_made");
    expect(line.value).toBe(3);
    expect(line.kind).toBe("counter");
    expect(line.tags).toEqual({ color: "blue" });
  });

  it("counter() defaults value to 1 and tags to {}", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    counter("hits");
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.value).toBe(1);
    expect(line.tags).toEqual({});
  });

  it("timing() emits a metric line with kind=timing + ms value", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    timing("op_ms", 125, { op: "boot" });
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.event).toBe("metric");
    expect(line.metric).toBe("op_ms");
    expect(line.value).toBe(125);
    expect(line.kind).toBe("timing");
    expect(line.tags).toEqual({ op: "boot" });
  });
});

describe("requestContext", () => {
  it("sets x-request-id and emits a matching http_request access log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const app = new Hono<AppEnv>();
    app.use("*", requestContext());
    app.get("/ping", (c) => c.text("pong"));

    const res = await app.request("/ping", {}, env);
    expect(res.status).toBe(200);
    const headerId = res.headers.get("x-request-id");
    expect(headerId).toBeTruthy();

    const access = jsonLines(spy).find((l) => l.event === "http_request");
    expect(access).toBeDefined();
    expect(access?.requestId).toBe(headerId);
    expect(access?.method).toBe("GET");
    expect(access?.path).toBe("/ping");
    expect(access?.status).toBe(200);
    expect(typeof access?.durationMs).toBe("number");
  });

  it("honors an inbound x-request-id", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const app = new Hono<AppEnv>();
    app.use("*", requestContext());
    app.get("/ping", (c) => c.text("pong"));

    const res = await app.request(
      "/ping",
      { headers: { "x-request-id": "inbound-abc" } },
      env,
    );
    expect(res.headers.get("x-request-id")).toBe("inbound-abc");
  });
});
