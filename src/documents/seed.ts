/**
 * Seed a converted document into an agent's brain (DOCS-01).
 *
 * Reuses the MNEMO-10 {@link writeNote} pipeline for every neuron, so each write
 * reindexes + commits through the normal chokepoint and the synapse graph is
 * built "for free" - we never touch git or the graph index directly. The source-
 * index neuron is written FIRST so each chunk's back-link resolves immediately;
 * the index's forward links to the chunks back-fill as each chunk lands (the
 * dangling-synapse resolution in `src/memory/graph-index.ts`).
 */
import type { Env } from "../env.ts";
import { NOTES_DIR } from "../memory/layout.ts";
import { type BrainWriteHooks, writeNote } from "../memory/write.ts";
import type { SandboxClient } from "../sandbox/client.ts";
import { chunkMarkdown, INGESTED_AT_PLACEHOLDER } from "./chunk.ts";

export interface SeedInput {
  markdown: string;
  filename: string;
  /** Epoch-ms the document was ingested; fills the chunk `ingested_at` field. */
  ingestedAt: number;
}

export interface SeedResult {
  /** The parent source-index neuron's path slug (stored as `source_slug`). */
  sourceSlug: string;
  /** Total neurons written (source index + one per chunk). */
  neuronCount: number;
}

/**
 * Chunk `markdown` and write the source-index neuron + one neuron per chunk into
 * the agent's brain via {@link writeNote}. Returns the source slug + neuron count
 * the caller records on the D1 document row. Pure-ish: all persistence goes
 * through the injected `hooks`/`sandbox`, so this is exercised with the recording
 * stub in tests.
 */
export async function seedDocumentIntoBrain(
  env: Env,
  agentId: string,
  hooks: BrainWriteHooks,
  sandbox: SandboxClient,
  input: SeedInput,
): Promise<SeedResult> {
  const { sourceSlug, index, chunks } = chunkMarkdown({
    markdown: input.markdown,
    filename: input.filename,
  });
  const ingestedAtFill = `"${new Date(input.ingestedAt).toISOString()}"`;
  const fill = (content: string): string =>
    content.replaceAll(INGESTED_AT_PLACEHOLDER, ingestedAtFill);

  // Best-effort: ensure the namespaced source directory exists before writing
  // nested notes (mkdir -p semantics; harmless if writeFile already creates it).
  const dirSlug = sourceSlug.replace(/\/index$/, "");
  await sandbox.mkdir(`${NOTES_DIR}/${dirSlug}`);

  // Source index first so chunk back-links resolve on write.
  await writeNote(
    env,
    agentId,
    { slug: index.slug, title: index.title, content: fill(index.content) },
    hooks,
    sandbox,
  );
  for (const chunk of chunks) {
    await writeNote(
      env,
      agentId,
      { slug: chunk.slug, title: chunk.title, content: fill(chunk.content) },
      hooks,
      sandbox,
    );
  }

  return { sourceSlug, neuronCount: chunks.length + 1 };
}
