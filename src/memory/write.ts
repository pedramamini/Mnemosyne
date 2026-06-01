/**
 * The single note-write pipeline (PRD §6.2 / §6.9, MNEMO-10).
 *
 * Every note mutation - write, append, delete - funnels through here so the
 * three views of the brain stay in lockstep:
 *
 *   write file (sandbox `writeFile`)  →  reindex the neuron (DO graph, MNEMO-08)
 *                                      →  auto-commit (git, MNEMO-07)
 *
 * That ordering is load-bearing: the reindex runs BEFORE the commit, so the
 * committed tree and the DO graph index always agree (a reader never sees a
 * commit whose graph edges haven't landed yet). Paths are resolved through
 * `notePath` (src/memory/layout.ts), which rejects traversal/absolute slugs, so
 * a model-supplied slug can never escape `/brain`.
 *
 * The graph + commit operations live on the DO (MnemosyneAgent, MNEMO-04), so
 * this module takes them as injected {@link BrainWriteHooks} rather than calling
 * a self-addressed DO stub - a DO invoking its own RPC stub would deadlock
 * (single-threaded input gating). The DO passes `this`-bound methods; tests pass
 * recording mocks. The sandbox handle is injectable for the same testability
 * reason as the git helper (src/memory/git.ts).
 */
import type { Env } from "../env.ts";
import { getSandbox, type SandboxClient } from "../sandbox/client.ts";
import { deleteCommitMsg, writeCommitMsg } from "./commit-messages.ts";
import { shQuote } from "./git.ts";
import { notePath } from "./layout.ts";

/** Body of a full note write - `title` is optional metadata for the neuron. */
export interface NoteWriteInput {
  slug: string;
  title?: string;
  content: string;
}

/** Body of an append - existing content is preserved, `content` is added. */
export interface NoteAppendInput {
  slug: string;
  content: string;
}

/** What every write path returns: the FS path written and the commit sha (or null). */
export interface NoteWriteResult {
  path: string;
  commit: string | null;
}

/**
 * The DO-side graph + commit operations the pipeline composes (MNEMO-04/07/08).
 * Injected so the pipeline is unit-testable without a DO/container and so the DO
 * supplies `this`-bound methods instead of a self-RPC stub. `commitBrain` is the
 * seam the consolidation apply pass (src/memory/consolidation-apply.ts) overrides
 * with a no-op to defer per-op commits into one pass-wide commit.
 */
export interface BrainWriteHooks {
  /** Re-index the neuron at `path` from its on-disk content (MNEMO-08). */
  reindexNote(path: string): Promise<void>;
  /** Drop the neuron at `path` from the index (MNEMO-08, delete path). */
  removeNeuron(path: string): Promise<void> | void;
  /** Auto-commit the brain with a structured message → sha, or null (MNEMO-07). */
  commitBrain(message: string): Promise<string | null>;
}

/**
 * Write a full note: resolve + validate the path, write the file, reindex the
 * neuron, then commit. A `title` (when given and not already declared by the
 * content) is prepended as an H1 so the on-disk note is self-describing - the
 * reindex re-reads the file and derives the neuron's slug from that title.
 */
export async function writeNote(
  env: Env,
  agentId: string,
  input: NoteWriteInput,
  hooks: BrainWriteHooks,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<NoteWriteResult> {
  // notePath throws BrainPathError on a traversal/absolute slug - BEFORE any
  // write, so a hostile slug never touches the FS.
  const path = notePath(input.slug);
  await sandbox.writeFile(path, composeNote(input.title, input.content));
  await hooks.reindexNote(path);
  const commit = await hooks.commitBrain(writeCommitMsg(input.slug));
  return { path, commit };
}

/**
 * Append to a note (read-then-write): the existing body is preserved and the new
 * content is added after a blank-line separator. A missing note is treated as
 * empty, so an append doubles as a create. Reindex + commit follow the same
 * ordered pipeline as {@link writeNote}.
 */
export async function appendNote(
  env: Env,
  agentId: string,
  input: NoteAppendInput,
  hooks: BrainWriteHooks,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<NoteWriteResult> {
  const path = notePath(input.slug);
  const existing = await readIfExists(sandbox, path);
  const merged =
    existing === null
      ? input.content
      : `${existing.replace(/\n+$/, "")}\n\n${input.content}`;
  await sandbox.writeFile(path, merged);
  await hooks.reindexNote(path);
  const commit = await hooks.commitBrain(writeCommitMsg(input.slug));
  return { path, commit };
}

/**
 * Delete a note: remove the file, drop its neuron (incoming links go dangling,
 * see GraphIndex.removeNeuron), then commit. Mirrors the write pipeline so
 * history/index stay consistent on removal too.
 */
export async function deleteNote(
  env: Env,
  agentId: string,
  slug: string,
  hooks: BrainWriteHooks,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<NoteWriteResult> {
  const path = notePath(slug);
  // `rm -f` so deleting an already-absent note is not an error. The path is
  // shell-quoted (it came through notePath, but quoting is the invariant the
  // git helper also holds - never trust a path to be shell-safe).
  await sandbox.run(`rm -f ${shQuote(path)}`);
  await hooks.removeNeuron(path);
  const commit = await hooks.commitBrain(deleteCommitMsg(slug));
  return { path, commit };
}

/**
 * Read a file if it exists, else null. Probes with `test -f` rather than relying
 * on `readFile` throwing a particular shape (the Beta SDK's error surface is not
 * a stable contract - see src/sandbox/client.ts).
 */
async function readIfExists(
  sandbox: SandboxClient,
  path: string,
): Promise<string | null> {
  const probe = await sandbox.run(
    `test -f ${shQuote(path)} && echo y || echo n`,
  );
  return probe.stdout.trim() === "y" ? await sandbox.readFile(path) : null;
}

/**
 * Prepend the title as an H1 when one is supplied and the content does not
 * already declare its own (front matter or a leading `# heading`). Keeps the
 * note self-describing so the neuron index derives the right title/slug, while
 * never clobbering a caller that wrote its own header.
 */
function composeNote(title: string | undefined, content: string): string {
  if (!title) return content;
  const lead = content.replace(/^\s+/, "");
  if (lead.startsWith("---") || /^#\s+/.test(lead)) return content;
  return `# ${title}\n\n${content}`;
}
