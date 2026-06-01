/**
 * Canonical brain filesystem layout (PRD §6.2 / §6.9).
 *
 * The agent's memory IS its filesystem (PRD §6.2): notes/neurons are `.md`
 * files, self-authored tools live under `/brain/tools/`, and reports archive
 * under `/brain/reports/`. PRD §6.9 makes `/brain` a git repo inside the
 * sandbox, auto-committed on every write - so this module is the single source
 * of truth for WHERE things live, shared by the git helper (src/memory/git.ts),
 * the sandbox persistence layer (src/sandbox/persistence.ts), and every future
 * memory-write path (MNEMO-10).
 *
 * Pure constants + helpers - NO filesystem calls. The path helpers exist to make
 * one guarantee load-bearing: a slug or tool name coming from the model (or a
 * user) can NEVER escape `/brain`. `notePath`/`toolPath` reject path traversal
 * (`..`), absolute escapes (`/etc/...`), and backslash tricks, then verify the
 * joined result stays contained - defense in depth against a malicious write.
 */

/** Brain FS root inside the sandbox container. All brain paths live under here. */
export const BRAIN_ROOT = "/brain";

/** Notes/neurons - `.md` files the agent reasons over as a `[[wikilink]]` graph. */
export const NOTES_DIR = `${BRAIN_ROOT}/notes`;

/** Self-authored, reusable tools (the largest security surface - PRD §6.2). */
export const TOOLS_DIR = `${BRAIN_ROOT}/tools`;

/** Archived computed reports (PRD §6.4). */
export const REPORTS_DIR = `${BRAIN_ROOT}/reports`;

/**
 * Rendered report assets - chart PNGs the Code Interpreter produces (MNEMO-23).
 * A subdir of {@link REPORTS_DIR} so report artifacts version + archive with the
 * rest of the brain; PNGs (not SVG) are the canonical embeddable form (PRD §6.4).
 */
export const REPORT_ASSETS_DIR = `${REPORTS_DIR}/assets`;

/** The directories `initBrainRepo` (src/memory/git.ts) creates on provisioning. */
export const BRAIN_DIRS: readonly string[] = [
  NOTES_DIR,
  TOOLS_DIR,
  REPORTS_DIR,
];

/**
 * Thrown when a slug/name would resolve outside its brain subdirectory. Surfaced
 * as a typed error (not a silent clamp) so callers fail loud on a hostile name.
 */
export class BrainPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainPathError";
  }
}

/**
 * Collapse `.`/`..` segments POSIX-style WITHOUT touching a filesystem. Used only
 * as a containment cross-check after the explicit rejects below - so even an
 * exotic input that slips past them can't yield a path outside `dir`.
 */
function normalizePosix(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      // An absolute path can't climb above its root - drop the `..`.
    } else {
      out.push(seg);
    }
  }
  return (absolute ? "/" : "") + out.join("/");
}

/**
 * Join `name` under `dir`, rejecting anything that could escape `dir`. The
 * explicit checks give clear errors for the common attacks; the final
 * containment assertion is the backstop that actually enforces the invariant.
 */
function safeJoin(dir: string, name: string): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new BrainPathError("brain path name must be a non-empty string");
  }
  if (name.startsWith("/") || name.includes("\\")) {
    throw new BrainPathError(`brain path may not be absolute: ${name}`);
  }
  if (name.split("/").some((seg) => seg === "..")) {
    throw new BrainPathError(`brain path may not traverse upward: ${name}`);
  }

  const joined = `${dir}/${name}`;
  const normalized = normalizePosix(joined);
  if (normalized !== dir && !normalized.startsWith(`${dir}/`)) {
    throw new BrainPathError(`brain path escapes ${dir}: ${name}`);
  }
  return normalized;
}

/**
 * Resolve a note slug to its `.md` path under `NOTES_DIR`. Appends `.md` if the
 * slug doesn't already carry it, so `notePath("acme")` and `notePath("acme.md")`
 * both land at `/brain/notes/acme.md`. Rejects traversal/absolute slugs.
 */
export function notePath(slug: string): string {
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new BrainPathError("note slug must be a non-empty string");
  }
  const file = slug.endsWith(".md") ? slug : `${slug}.md`;
  return safeJoin(NOTES_DIR, file);
}

/**
 * Resolve a tool name to its path under `TOOLS_DIR`. Unlike notes, no extension
 * is assumed - a tool may be `.py`, `.sh`, etc. Rejects traversal/absolute names.
 */
export function toolPath(name: string): string {
  return safeJoin(TOOLS_DIR, name);
}

/**
 * The single guard for a *general* brain path (MNEMO-11 explorer): unlike
 * `notePath`/`toolPath` (which pin a name under one subdir), this validates an
 * arbitrary path the explorer wants to touch anywhere under `/brain` - `notes/`,
 * `tools/`, `reports/`, or a nested file - and returns the canonical ABSOLUTE
 * path. Accepts either an absolute path already rooted at `/brain` or a path
 * relative to it; in both cases the result is normalized and asserted to stay
 * inside `/brain`, so a `..`, an absolute escape (`/etc/...`), or a backslash
 * trick can never reach the FS. Reuses {@link normalizePosix} so there is ONE
 * containment implementation, not a per-call-site copy.
 */
export function assertInsideBrain(path: string): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw new BrainPathError("brain path must be a non-empty string");
  }
  if (path.includes("\\")) {
    throw new BrainPathError(`brain path may not contain backslashes: ${path}`);
  }
  // An absolute path must ALREADY be rooted at `/brain` - a bare absolute escape
  // (`/etc/passwd`) is rejected loud, never silently reinterpreted. A relative
  // path is joined under the root.
  if (
    path.startsWith("/") &&
    path !== BRAIN_ROOT &&
    !path.startsWith(`${BRAIN_ROOT}/`)
  ) {
    throw new BrainPathError(
      `brain path may not be absolute outside ${BRAIN_ROOT}: ${path}`,
    );
  }
  const candidate = path.startsWith("/") ? path : `${BRAIN_ROOT}/${path}`;
  // Normalize so even an embedded `..` that would climb out of `/brain`
  // (`/brain/../etc`) is caught by the containment check below.
  const normalized = normalizePosix(candidate);
  if (normalized !== BRAIN_ROOT && !normalized.startsWith(`${BRAIN_ROOT}/`)) {
    throw new BrainPathError(`brain path escapes ${BRAIN_ROOT}: ${path}`);
  }
  return normalized;
}

/**
 * Whether `absPath` (an already-validated absolute brain path) addresses a note
 * neuron: a `.md` file under `/brain/notes`. Note edits from the explorer go
 * through the MNEMO-10 write pipeline so they reindex + commit exactly like agent
 * writes; everything else (tools/reports/binaries) is a raw write+commit.
 */
export function isNotePath(absPath: string): boolean {
  return absPath.startsWith(`${NOTES_DIR}/`) && absPath.endsWith(".md");
}

/**
 * The note slug for an absolute note path - the inverse of {@link notePath}, so
 * `noteSlugFromPath("/brain/notes/sub/foo.md")` → `sub/foo.md` round-trips back
 * to the same path through `notePath`. Only meaningful when {@link isNotePath} is
 * true; the slug keeps its `.md` (notePath is idempotent on the extension).
 */
export function noteSlugFromPath(absPath: string): string {
  return absPath.slice(NOTES_DIR.length + 1);
}
