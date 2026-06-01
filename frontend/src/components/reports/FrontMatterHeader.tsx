import { relativeTime } from "@/components/audit/AuditEventRow";
import { Heading, Inline, Stack, Tag, Text } from "@/components/ui";
import styles from "./FrontMatterHeader.module.css";

export interface FrontMatterHeaderProps {
  /** Parsed Obsidian front matter (may be empty). */
  frontMatter: Record<string, unknown>;
  /** Resolved report title (falls back from the front matter upstream). */
  title: string;
  /** Resolved creation timestamp (ISO-ish string). */
  createdAt: string;
}

/** Keys rendered explicitly (title/date/tags) or that are machine-internal - all
 *  excluded from the generic key/value grid of "other" fields. */
const HANDLED_KEYS = new Set(["title", "tags", "created", "type", "agentId"]);

/** Humanize a snake_case front-matter key (`source_count` -> `Source count`). */
function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Render a scalar front-matter value as a string; skip empty/object values. */
function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/** Read the `tags` array from front matter as a clean string list. */
function tagsOf(frontMatter: Record<string, unknown>): string[] {
  const raw = frontMatter.tags;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => (typeof t === "string" ? t.trim() : String(t)))
    .filter((t) => t.length > 0);
}

/**
 * FrontMatterHeader (MNEMO-41) - the metadata header above a report body. Renders
 * the title, a relative creation date, tag chips, and any other scalar front-matter
 * fields as a compact key/value grid. Object/empty/internal fields (`type`,
 * `agentId`) are skipped - the raw YAML is never shown. Presentational only.
 */
export function FrontMatterHeader({
  frontMatter,
  title,
  createdAt,
}: FrontMatterHeaderProps) {
  const tags = tagsOf(frontMatter);

  const extra = Object.entries(frontMatter)
    .filter(([key]) => !HANDLED_KEYS.has(key))
    .map(([key, value]) => [key, scalarText(value)] as const)
    .filter((entry): entry is [string, string] => entry[1] !== null);

  const created = createdAt ? relativeTime(createdAt) : "";

  return (
    <Stack gap="3" className={styles.header}>
      <Stack gap="1">
        <Heading level={2}>{title}</Heading>
        {created && (
          <Text size="sm" color="text-muted">
            {created}
          </Text>
        )}
      </Stack>

      {tags.length > 0 && (
        <Inline gap="2" wrap>
          {tags.map((tag) => (
            <Tag key={tag} variant="neutral" size="sm">
              {tag}
            </Tag>
          ))}
        </Inline>
      )}

      {extra.length > 0 && (
        <dl className={styles.grid}>
          {extra.map(([key, value]) => (
            <div key={key} className={styles.row}>
              <Text as="dt" size="xs" color="text-muted" className={styles.key}>
                {humanizeKey(key)}
              </Text>
              <Text as="dd" size="sm" className={styles.value}>
                {value}
              </Text>
            </div>
          ))}
        </dl>
      )}
    </Stack>
  );
}
