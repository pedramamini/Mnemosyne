import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ReportAsset } from "@/api/reports";
import styles from "./MarkdownRenderer.module.css";

export interface MarkdownRendererProps {
  /** The report markdown body (front matter already stripped). */
  markdown: string;
  /** Embedded chart assets, used to resolve relative image sources. */
  assets?: ReportAsset[];
}

/** Last path segment of an image src (so `charts/foo.png` matches asset `foo.png`). */
function basename(src: string): string {
  return src.split("/").pop() ?? src;
}

/**
 * Rewrite Obsidian-style `![[file.png]]` embeds to standard markdown images so the
 * GFM renderer picks them up; the `img` renderer then resolves them like any other
 * relative source. Standard `![alt](src)` images are left untouched.
 */
function normalizeEmbeds(markdown: string): string {
  return markdown.replace(/!\[\[([^\]]+)\]\]/g, (_m, target: string) => {
    const name = target.trim();
    return `![${name}](${name})`;
  });
}

/**
 * MarkdownRenderer (MNEMO-41) - renders a report's markdown body with `react-markdown`
 * + `remark-gfm`, sanitized via `rehype-sanitize` (so any raw `<script>`/HTML in the
 * body is stripped). A custom `img` renderer resolves RELATIVE chart sources (e.g.
 * `charts/foo.png`, or an Obsidian `![[foo.png]]` embed) against the report's
 * `assets` list by file name, so embedded PNG charts display from their MNEMO-25
 * asset URLs; external `https` images render as-is. Presentational only.
 */
export function MarkdownRenderer({ markdown, assets }: MarkdownRendererProps) {
  const source = useMemo(() => normalizeEmbeds(markdown), [markdown]);

  const components = useMemo<Components>(() => {
    const byName = new Map((assets ?? []).map((a) => [a.name, a.url]));
    return {
      img({ src, alt, title }) {
        const raw = typeof src === "string" ? src : "";
        const resolved = /^https?:\/\//i.test(raw)
          ? raw
          : (byName.get(basename(raw)) ?? raw);
        return (
          <img
            className={styles.image}
            src={resolved}
            alt={alt ?? ""}
            title={title}
            loading="lazy"
          />
        );
      },
      // Wrap tables so a wide table scrolls horizontally inside its own container
      // on narrow viewports instead of forcing page-level horizontal overflow.
      table({ children }) {
        return (
          <div className={styles.tableScroll}>
            <table>{children}</table>
          </div>
        );
      },
    };
  }, [assets]);

  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
