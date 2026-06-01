/**
 * Artifact API adapter - the single source of truth for the renderHtml artifact
 * routes (mirrors `conversations.ts`/`discovery.ts`). An artifact is a
 * self-contained HTML view the agent rendered into the chat; the chat references
 * it by id via a `data-artifact` message part (see `conversations.ts`), and the
 * UI loads its body straight into a SANDBOXED iframe from the raw URL below.
 *
 *   GET /agents/:agentId/artifacts                 → metadata list
 *   GET /agents/:agentId/artifacts/:artifactId/raw → the HTML body (iframe src),
 *       served behind a locked-down CSP/sandbox by the backend so the agent HTML
 *       can't reach the app, the session, or the network.
 *
 * The raw URL is consumed as an `<iframe src>`, not via `apiFetch` - the browser
 * sends the session cookie on the iframe's same-origin navigation, so we reuse
 * `apiUrl` for the one source of truth on the API origin (same as the chat
 * streaming transport) rather than fetching + blob-URL-ing the body ourselves.
 */
import { apiUrl } from "./client";

/** One artifact's metadata (the list-route shape). */
export interface ArtifactSummary {
  id: string;
  title: string;
  content_type: string;
  byte_size: number;
  created_at: string;
  conversation_id: string | null;
}

/**
 * Absolute URL for an artifact's HTML body - the `<iframe src>`. Same-origin (or
 * via the dev proxy), so the iframe navigation carries the session cookie and the
 * backend's ownership guard + hardened CSP apply.
 */
export function artifactRawUrl(agentId: string, artifactId: string): string {
  return apiUrl(
    `/agents/${encodeURIComponent(agentId)}/artifacts/${encodeURIComponent(
      artifactId,
    )}/raw`,
  );
}
