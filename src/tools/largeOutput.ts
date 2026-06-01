/**
 * Large-output-to-FS-path - the enforcement point for PRD §7.1 context
 * discipline.
 *
 * The Vercel AI SDK does NOT compact the in-loop message array, so anything a
 * tool feeds back becomes permanent context for every subsequent turn. A long
 * shell stdout or Python result fed back inline would therefore bloat the loop
 * indefinitely. Every sandbox-driving tool routes its output through
 * {@link spillIfLarge}: small results are inlined; anything at/over
 * {@link LARGE_OUTPUT_THRESHOLD_BYTES} is written to the brain FS and the loop
 * is handed a PATH + a short preview, never the blob. The agent can then read
 * the path with the `readFile` tool if it actually needs the full content.
 */
import { BRAIN_ROOT } from "../memory/layout.ts";
import { LARGE_OUTPUT_THRESHOLD_BYTES, type ToolContext } from "./types.ts";

/** Brain subdir holding spilled tool outputs, partitioned by research session. */
const TOOL_OUT_DIR = `${BRAIN_ROOT}/.tool-out`;

/** How many leading characters of a spilled blob to keep as an inline preview. */
const PREVIEW_CHARS = 500;

/**
 * Result of routing one tool output through the size gate. Exactly one of
 * `inline` (small enough to feed back directly) or `path` (spilled - read it
 * from the FS if needed) is set; `bytes` is always the true UTF-8 size, and
 * `preview` accompanies a spill so the loop sees a glimpse without the blob.
 */
export interface SpillResult {
  inline?: string;
  path?: string;
  bytes: number;
  preview?: string;
}

/**
 * Inline `content` if it is under {@link LARGE_OUTPUT_THRESHOLD_BYTES}, else
 * spill it to `/brain/.tool-out/<sessionId>/<name>-<timestamp>.txt` and return a
 * path + preview (NOT the blob). On a spill, emits a `narration` audit note so
 * the glass cockpit shows that a large output was written to a path.
 *
 * Size is measured in UTF-8 BYTES (not JS string length) so multibyte content
 * is gated by its real on-the-wire cost. `name` tags the spill file so a later
 * reader can tell which tool produced it.
 */
export async function spillIfLarge(
  ctx: ToolContext,
  name: string,
  content: string,
): Promise<SpillResult> {
  const bytes = utf8ByteLength(content);
  if (bytes < LARGE_OUTPUT_THRESHOLD_BYTES) {
    return { inline: content, bytes };
  }

  // Partition by session so a long-running research run's spills group together
  // (and a sessionless/interactive turn still has a stable bucket).
  const session = ctx.sessionId ?? "no-session";
  const dir = `${TOOL_OUT_DIR}/${session}`;
  const path = `${dir}/${name}-${Date.now()}.txt`;

  // writeFile does not create parent dirs; mkdir -p first (idempotent).
  await ctx.sandbox.mkdir(dir);
  await ctx.sandbox.writeFile(path, content);

  const preview = content.slice(0, PREVIEW_CHARS);
  await ctx.emit({
    type: "narration",
    level: "info",
    sessionId: ctx.sessionId,
    text: `Spilled large ${name} output (${bytes} bytes) to ${path}`,
    payload: { name, bytes, path },
  });

  return { path, bytes, preview };
}

/** True UTF-8 byte length of a string (multibyte-aware), for the size gate. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
