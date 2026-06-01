/**
 * Containment rules for self-authored tools (PRD §6.2 / §7.3 / §8.4).
 *
 * These scripts run ONLY inside the agent's own isolated sandbox (§7.3/§8.4):
 * there is no shared interpreter, no cross-agent filesystem, and the Worker/DO
 * process NEVER executes agent-authored code. That per-agent container isolation
 * is the real security boundary. The guards in this module are defense-in-depth
 * on top of it:
 *   - `validateToolName` keeps a tool name a pure slug, so it can never escape
 *     `/brain/tools/` via path traversal or absolute/backslash tricks.
 *   - `assertWithinToolDir` re-checks every write a tool makes, so an entrypoint
 *     or output path can never resolve outside `/brain/tools/<name>/`.
 *   - any input we accept for a tool is validated against its declared
 *     JSON-Schema (`validateInput`) BEFORE the script ever sees it.
 */
import { assertInsideBrain } from "../../memory/layout.ts";
import { TOOL_NAME_PATTERN, toolDir } from "./manifest.ts";

/**
 * Per-run wall-clock cap for a self-authored tool. Mirrors the core registry's
 * 60s command guard (src/tools/registry.ts): an agent-authored script is just
 * another sandbox command and must not pin a billed container (§8.4).
 *
 * Memory/output cap: a self-authored tool's stdout/stderr is NOT special-cased -
 * it flows through the same `spillIfLarge` gate as every other tool (PRD §7.1),
 * so a runaway-output script spills to a brain path instead of bloating the loop.
 */
export const SELF_AUTHORED_RUN_TIMEOUT_MS = 60_000;

/** Thrown when a tool name or write path would break containment. */
export class ToolSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolSecurityError";
  }
}

/**
 * Assert `name` is a valid tool slug and return it. The slug pattern
 * (`^[a-z0-9-]+$`) alone rejects every escape vector: `..` (has dots), `a/b`
 * (has a slash), `.hidden` (leading dot), `Caps` (uppercase), and `""` (empty).
 */
export function validateToolName(name: string): string {
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    throw new ToolSecurityError(
      `invalid tool name (must match ${TOOL_NAME_PATTERN}): ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * Resolve `path` (an entrypoint or output path, relative to the tool dir or an
 * absolute brain path) and assert it stays under `/brain/tools/<name>/`. Reuses
 * {@link assertInsideBrain} for the canonical `/brain` containment + normalization
 * (so `..`/absolute/backslash escapes are caught once, not re-implemented here),
 * then tightens it to the single tool's directory. Returns the normalized path.
 */
export function assertWithinToolDir(path: string, name: string): string {
  const dir = toolDir(validateToolName(name));
  // A relative path is joined under the tool dir; an absolute one is checked
  // as-is. assertInsideBrain normalizes away any `..` and rejects escapes from
  // /brain outright (throwing BrainPathError) - a deep climb like `../../../x`
  // can leave /brain entirely. We catch that and re-throw as a ToolSecurityError
  // so every containment violation surfaces as ONE error type for callers.
  const candidate = path.startsWith("/") ? path : `${dir}/${path}`;
  let normalized: string;
  try {
    normalized = assertInsideBrain(candidate);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ToolSecurityError(`path escapes ${dir}: ${path} (${detail})`);
  }
  if (normalized !== dir && !normalized.startsWith(`${dir}/`)) {
    throw new ToolSecurityError(`path escapes ${dir}: ${path}`);
  }
  return normalized;
}

/** Minimal structural shape of the JSON-Schema subset {@link validateInput} reads. */
interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
}

/** Whether `value` matches a single JSON-Schema primitive `type`. */
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "null":
      return value === null;
    default:
      // Unknown/unsupported type keyword - don't reject on it.
      return true;
  }
}

/** Recursively collect validation errors for one schema node against `value`. */
function collectErrors(
  schema: JsonSchemaNode,
  value: unknown,
  path: string,
  errors: string[],
): void {
  const label = path || "value";
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${label}: expected ${types.join("|")}`);
      return; // type mismatch - descending further would be noise
    }
  }

  const isObject =
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isObject) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in obj))
          errors.push(`${path ? `${path}.` : ""}${key}: required`);
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) {
          collectErrors(sub, obj[key], path ? `${path}.${key}` : key, errors);
        }
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    value.forEach((item, i) => {
      collectErrors(
        schema.items as JsonSchemaNode,
        item,
        `${label}[${i}]`,
        errors,
      );
    });
  }
}

/** Result of {@link validateInput}: ok, or a list of human-readable errors. */
export type InputValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate `value` against a tool's declared JSON-Schema BEFORE the script runs
 * (the §6.2 "input is validated before the script sees it" rule). Supports the
 * common subset - `type`, `properties`, `required`, `items`, and union types -
 * which is what `authorTool` lets the model declare; unknown keywords are
 * ignored (lenient, not silently-permissive on the parts we DO understand).
 */
export function validateInput(
  schema: Record<string, unknown>,
  value: unknown,
): InputValidation {
  const errors: string[] = [];
  collectErrors(schema as JsonSchemaNode, value, "", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
