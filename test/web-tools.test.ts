import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditInput } from "../src/audit/types.ts";
import type { Env } from "../src/env.ts";
import type { MnemosyneTool, ToolContext } from "../src/tools/index.ts";
import { LARGE_OUTPUT_THRESHOLD_BYTES } from "../src/tools/index.ts";
import { buildWebTools } from "../src/tools/web/searchTools.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-17: buildWebTools returns webFetch/webSearch. Each carries the PRD §6.3
// rails + the MNEMO-16 large-output-to-FS discipline. `fetch` is stubbed so the
// tools are asserted deterministically against a stub sandbox + audit sink.

function makeCtx(env: Partial<Env> = {}, sessionId: string | null = "sess-1") {
  const { stub, client } = stubSandboxClient();
  const emitted: AuditInput[] = [];
  const ctx: ToolContext = {
    env: env as Env,
    agentId: "agent-1",
    accountId: "acct-1",
    sandbox: client,
    sessionId,
    emit: async (e) => {
      emitted.push(e);
    },
  };
  return { stub, ctx, emitted };
}

/** Invoke a tool's execute with a minimal options object (unused by our tools). */
function invoke(tool: MnemosyneTool, input: unknown): Promise<unknown> {
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

/** True if a `source.read` audit event was emitted. */
function readEmitted(emitted: AuditInput[]): boolean {
  return emitted.some((e) => e.type === "source.read");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildWebTools - web-research tools", () => {
  it("exposes exactly webFetch + webSearch", () => {
    const { ctx } = makeCtx();
    expect(Object.keys(buildWebTools(ctx)).sort()).toEqual([
      "webFetch",
      "webSearch",
    ]);
  });

  it("webFetch on a large HTML page returns a path + preview (not the blob), runs htmlToText, and emits source.read", async () => {
    // HTML whose cleaned text exceeds the inline threshold → must spill. The
    // <script> body and tags must be gone after htmlToText.
    const paragraphs = Array.from(
      { length: 400 },
      (_, i) => `<p>Hello world, readable content paragraph number ${i}.</p>`,
    ).join("");
    const html =
      `<html><head><title>Ignored Head</title></head><body>` +
      `<script>var evil = 1; trackUser();</script>${paragraphs}</body></html>`;
    const fetchMock = vi.fn(
      async () =>
        new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { stub, ctx, emitted } = makeCtx();
    const tools = buildWebTools(ctx);

    const result = (await invoke(tools.webFetch, {
      url: "https://example.com/article",
    })) as {
      url: string;
      content: { inline?: string; path?: string; preview?: string };
    };

    // Spilled: a path + preview, NOT the inline blob (PRD §7.1).
    expect(result.content.inline).toBeUndefined();
    expect(result.content.path).toContain("/brain/.tool-out/");
    expect(result.content.preview).toBeDefined();

    // The spilled content went through htmlToText: readable text, no markup,
    // and the <script> body was dropped wholesale.
    const write = stub.writes.find((w) => w.path === result.content.path);
    expect(write).toBeDefined();
    const cleaned = write?.content ?? "";
    expect(cleaned).toContain("Hello world, readable content");
    expect(cleaned).not.toContain("<script");
    expect(cleaned).not.toContain("<p>");
    expect(cleaned).not.toContain("</");
    expect(cleaned).not.toContain("trackUser");
    expect(cleaned).not.toContain("Ignored Head"); // <head> stripped wholesale
    // Sanity: the cleaned text really was over the spill threshold.
    expect(cleaned.length).toBeGreaterThan(LARGE_OUTPUT_THRESHOLD_BYTES);

    // A read happened → source.read narrated for the cockpit.
    const read = emitted.find((e) => e.type === "source.read");
    expect(read).toBeDefined();
    expect(read?.payload?.url).toBe("https://example.com/article");
  });

  it("webFetch on a blocked URL returns a typed error and emits NO source.read", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, emitted } = makeCtx();
    const tools = buildWebTools(ctx);

    const result = (await invoke(tools.webFetch, {
      url: "https://www.spokeo.com/jane-doe",
    })) as { error?: string };

    expect(result.error).toBeDefined();
    expect(result.error).toContain("blocked host");
    // Never hit the network, and never narrated a read.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readEmitted(emitted)).toBe(false);
  });

  it("webFetch surfaces a timeout/transport failure as a typed error (no throw, no source.read)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, emitted } = makeCtx();
    const tools = buildWebTools(ctx);

    const result = (await invoke(tools.webFetch, {
      url: "https://example.com/slow",
    })) as { error?: string };

    expect(result.error).toBeDefined();
    expect(result.error).toContain("fetch failed");
    expect(readEmitted(emitted)).toBe(false);
  });

  it("webSearch returns a typed 'not configured' error when no backend is set", async () => {
    const { ctx, emitted } = makeCtx(); // empty env → unconfigured
    const tools = buildWebTools(ctx);

    const result = (await invoke(tools.webSearch, {
      query: "acme corp founders",
    })) as { error?: string };

    expect(result.error).toBe("search not configured");
    expect(readEmitted(emitted)).toBe(false);
  });

  it("webSearch (keyless duckduckgo) parses HTML hits, resolves the uddg redirect, and emits source.read", async () => {
    // DDG no-JS result markup: a `result__a` link (href wrapped in the
    // /l/?uddg= redirect, with &amp; entity) + a sibling `result__snippet`.
    const ddgHtml = `<html><body>
      <div class="result results_links_deep web-result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha&amp;rut=x">Alpha &amp; Co</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha is a <b>blue-chip</b> stock.</a>
      </div>
      <div class="result results_links_deep web-result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.org%2Fbeta&amp;rut=y">Beta News</a>
        <a class="result__snippet">Beta coverage of the market.</a>
      </div>
      <div class="result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.spokeo.com%2Fperson">Blocked Aggregator</a>
        <a class="result__snippet">people finder</a>
      </div>
    </body></html>`;
    let requestedUrl = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(ddgHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, emitted } = makeCtx({ WEB_SEARCH_PROVIDER: "duckduckgo" });
    const tools = buildWebTools(ctx);

    const result = (await invoke(tools.webSearch, {
      query: "blue chip stocks",
    })) as { count: number; results: { inline?: string } };

    // Hit the keyless HTML endpoint with a real query.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrl).toContain(
      "html.duckduckgo.com/html/?q=blue%20chip%20stocks",
    );

    // Two real hits parsed (the spokeo aggregator is host-filtered out); URLs
    // resolved out of the uddg redirect, titles/snippets de-tagged + de-entitied.
    const inline = result.results.inline ?? "";
    expect(result.count).toBe(2);
    expect(inline).toContain("https://example.com/alpha");
    expect(inline).toContain("https://news.example.org/beta");
    expect(inline).toContain("Alpha & Co");
    expect(inline).toContain("blue-chip stock");
    expect(inline).not.toContain("spokeo");
    expect(inline).not.toContain("<b>");
    expect(readEmitted(emitted)).toBe(true);
  });

  it("rejects a non-URL webFetch input via the Zod schema", () => {
    const { ctx } = makeCtx();
    const tools = buildWebTools(ctx);
    const schema = tools.webFetch.inputSchema as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(schema.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });
});
