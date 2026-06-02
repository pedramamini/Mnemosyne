import { describe, expect, it } from "vitest";
import { convertToMarkdown } from "../src/documents/convert.ts";
import { ALLOWED_EXTENSIONS } from "../src/documents/types.ts";
import type { Env } from "../src/env.ts";

// DOCS-01: unit-test the converter with `env.AI.toMarkdown` MOCKED. No model is
// invoked - we drive the four ConvertOutcome branches deterministically and pin
// the "never call toMarkdown for an unsupported type" + "empty is not success"
// contracts.

type Conversion =
  | {
      id: string;
      name: string;
      mimeType: string;
      format: "markdown";
      tokens: number;
      data: string;
    }
  | {
      id: string;
      name: string;
      mimeType: string;
      format: "error";
      error: string;
    };

/** The native formats `supported()` reports (mirrors the static accept-list). */
const SUPPORTED = [...ALLOWED_EXTENSIONS].map((extension) => ({
  extension,
  mimeType: "application/octet-stream",
}));

/**
 * A fake `env.AI` whose `toMarkdown(doc)` returns `result` (or throws when
 * `throwOn` is set), and whose `toMarkdown().supported()` reports the native set.
 * `docCalls` counts ONLY the conversion calls (not the `supported()` lookups), so
 * a test can assert an unsupported type never reached the converter.
 */
function makeEnv(opts: { result?: Conversion; throws?: boolean }): {
  env: Env;
  docCalls: () => number;
} {
  let docCalls = 0;
  const toMarkdown = (files?: unknown) => {
    if (files === undefined) {
      return { supported: async () => SUPPORTED };
    }
    docCalls += 1;
    if (opts.throws) throw new Error("toMarkdown blew up");
    return Promise.resolve(opts.result);
  };
  const env = { AI: { toMarkdown } } as unknown as Env;
  return { env, docCalls: () => docCalls };
}

const bytes = new TextEncoder().encode("fake-binary-bytes");

describe("convertToMarkdown", () => {
  it("(a) returns ok + the markdown for a native format", async () => {
    const { env } = makeEnv({
      result: {
        id: "1",
        name: "doc.pdf",
        mimeType: "application/pdf",
        format: "markdown",
        tokens: 12,
        data: "# Title\n\nBody text.",
      },
    });

    const out = await convertToMarkdown(env, { name: "doc.pdf", bytes });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.method).toBe("tomarkdown");
      expect(out.markdown).toContain("# Title");
      expect(out.mimetype).toBe("application/pdf");
    }
  });

  it("(b) surfaces a format:'error' result as CONVERSION_FAILED (not a throw)", async () => {
    const { env } = makeEnv({
      result: {
        id: "1",
        name: "doc.pdf",
        mimeType: "application/pdf",
        format: "error",
        error: "corrupt file",
      },
    });

    const out = await convertToMarkdown(env, { name: "doc.pdf", bytes });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("CONVERSION_FAILED");
      expect(out.detail).toContain("corrupt file");
    }
  });

  it("(b') a thrown toMarkdown becomes CONVERSION_FAILED, not a throw", async () => {
    const { env } = makeEnv({ throws: true });
    const out = await convertToMarkdown(env, { name: "doc.pdf", bytes });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("CONVERSION_FAILED");
  });

  it("(c) an unsupported extension returns UNSUPPORTED_FORMAT WITHOUT calling toMarkdown", async () => {
    const { env, docCalls } = makeEnv({
      result: {
        id: "1",
        name: "legacy.doc",
        mimeType: "application/msword",
        format: "markdown",
        tokens: 1,
        data: "should not be produced",
      },
    });

    for (const name of ["legacy.doc", "deck.pptx", "memo.rtf"]) {
      const out = await convertToMarkdown(env, { name, bytes });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe("UNSUPPORTED_FORMAT");
    }
    // The converter was never invoked for any unsupported type.
    expect(docCalls()).toBe(0);
  });

  it("(d) a 'markdown' result with empty data is EMPTY_RESULT, never an empty success", async () => {
    const { env } = makeEnv({
      result: {
        id: "1",
        name: "doc.pdf",
        mimeType: "application/pdf",
        format: "markdown",
        tokens: 0,
        data: "   \n  ",
      },
    });

    const out = await convertToMarkdown(env, { name: "doc.pdf", bytes });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("EMPTY_RESULT");
  });
});
