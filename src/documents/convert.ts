/**
 * Document → Markdown conversion (DOCS-01).
 *
 * `env.AI.toMarkdown` is the SOLE converter (DOCS-01 header): it natively handles
 * PDF, `.docx`, the Excel/open spreadsheet variants, `.ods/.odt/.numbers`,
 * CSV/HTML/XML, and images. There is NO sandbox fallback - legacy/unsupported
 * formats (`.doc`, `.ppt/.pptx`, `.rtf`, `.pages`, …) are rejected with a typed
 * `UNSUPPORTED_FORMAT` error rather than written as a garbage neuron (a future
 * DOCS-03 with a LibreOffice-baked image could add them; out of scope here).
 *
 * The function NEVER throws: a thrown `toMarkdown` call, an `error`-format
 * result, or an empty/whitespace conversion all become a typed `ConvertOutcome`
 * the caller surfaces per-file. Empty markdown is explicitly NOT success.
 */
import type { Env } from "../env.ts";
import { ALLOWED_EXTENSIONS, type ConvertOutcome } from "./types.ts";

/** Input bytes for {@link convertToMarkdown}. */
export interface ConvertInput {
  name: string;
  bytes: Uint8Array | ArrayBuffer;
  mimeType?: string;
}

/**
 * Cached native-format set from `env.AI.toMarkdown().supported()`. Only populated
 * on a successful call (so a transient failure doesn't poison the cache); until
 * then the static {@link ALLOWED_EXTENSIONS} is the fallback. Module-scoped so the
 * (network) `supported()` call happens at most once per isolate.
 */
let supportedCache: ReadonlySet<string> | null = null;

/**
 * The extensions `toMarkdown` reports it can convert, or the static accept-list
 * when that call is unavailable. Normalizes each entry (strips a leading dot,
 * lowercases) so the membership test is uniform.
 */
async function nativeExtensions(env: Env): Promise<ReadonlySet<string>> {
  if (supportedCache) return supportedCache;
  try {
    const list = await env.AI.toMarkdown().supported();
    const set = new Set(
      list.map((f) => f.extension.replace(/^\./, "").toLowerCase()),
    );
    if (set.size > 0) {
      supportedCache = set;
      return set;
    }
  } catch {
    // `supported()` unavailable - fall back to the static accept-list below.
  }
  return ALLOWED_EXTENSIONS;
}

/** The lowercase extension of `name` (no dot), or "" when it has none. */
export function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Normalize the input bytes to a `Uint8Array` (Blob accepts either, but be explicit). */
function toBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * Convert one document's bytes to Markdown via `env.AI.toMarkdown`. Returns a
 * typed {@link ConvertOutcome}:
 *  - `UNSUPPORTED_FORMAT` - the extension isn't in the `toMarkdown`-native set
 *    (a safety net BEHIND the upload-time accept-list; `toMarkdown` is never
 *    called for these);
 *  - `CONVERSION_FAILED`  - `toMarkdown` returned `format: 'error'` OR threw;
 *  - `EMPTY_RESULT`       - a `markdown` result whose `data` is empty/whitespace;
 *  - `{ ok: true, … }`    - a non-empty markdown conversion.
 */
export async function convertToMarkdown(
  env: Env,
  input: ConvertInput,
): Promise<ConvertOutcome> {
  const ext = extensionOf(input.name);
  const native = await nativeExtensions(env);
  if (ext === "" || !native.has(ext)) {
    return {
      ok: false,
      code: "UNSUPPORTED_FORMAT",
      detail: ext
        ? `Unsupported file type ".${ext}" - only PDF, Office/Open documents, spreadsheets, CSV/HTML/XML, and images are supported.`
        : "File has no extension, so its type can't be determined.",
    };
  }

  try {
    const blob = new Blob([toBytes(input.bytes)], {
      type: input.mimeType ?? "application/octet-stream",
    });
    const result = await env.AI.toMarkdown({ name: input.name, blob });

    if (result.format === "error") {
      return {
        ok: false,
        code: "CONVERSION_FAILED",
        detail: result.error || "toMarkdown returned an error.",
      };
    }
    // `format === 'markdown'`: guard against an empty/whitespace conversion so a
    // blank neuron is never written.
    if (!result.data || result.data.trim() === "") {
      return {
        ok: false,
        code: "EMPTY_RESULT",
        detail: "Conversion produced no readable text.",
      };
    }
    return {
      ok: true,
      markdown: result.data,
      method: "tomarkdown",
      mimetype: result.mimeType,
    };
  } catch (err) {
    return {
      ok: false,
      code: "CONVERSION_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
