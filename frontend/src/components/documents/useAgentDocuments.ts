/**
 * Document-ingestion hook (DOCS-02) - a plain `useEffect`/`useState` lifecycle
 * wrapper over `@/api/documents`, co-located with the feature like the brain's
 * `useBrain` hook (the frontend uses no TanStack Query - MNEMO-32).
 *
 * Exposes `{ documents, loading, error, upload, remove, refresh }` for one agent:
 *   - loads the metadata list on mount / `agentId` change,
 *   - `upload(files)` OPTIMISTICALLY appends `pending` rows, calls the multipart
 *     upload, then refreshes from the server so the real statuses (converted /
 *     seeded / failed) replace the placeholders,
 *   - `remove(docId, opts)` deletes (optionally purging derived neurons) and
 *     refreshes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DocumentRecord,
  deleteDocument,
  type IngestResult,
  listDocuments,
  uploadDocuments,
} from "@/api/documents";

export interface UseAgentDocumentsResult {
  /** The agent's documents (real rows, plus optimistic `pending` rows mid-upload). */
  documents: DocumentRecord[];
  /** True during the initial load / a full refresh. */
  loading: boolean;
  error: Error | null;
  /** True while an upload is in flight. */
  uploading: boolean;
  /** Upload files: optimistic `pending` rows, then refresh. Resolves with results. */
  upload: (files: File[]) => Promise<IngestResult[]>;
  /** Delete a document (optionally purging its derived neurons), then refresh. */
  remove: (docId: string, opts?: { purgeNeurons?: boolean }) => Promise<void>;
  /** Re-fetch the list from the server. */
  refresh: () => void;
}

/** A placeholder row shown immediately while an upload converts/seeds server-side. */
function optimisticRow(agentId: string, file: File): DocumentRecord {
  return {
    // A temp id distinct from any server id; replaced wholesale on the next refresh.
    id: `pending:${file.name}:${file.size}:${file.lastModified}`,
    agent_id: agentId,
    account_id: "",
    discovery_id: null,
    filename: file.name,
    mime_type: file.type || null,
    size_bytes: file.size,
    r2_key: "",
    status: "pending",
    convert_method: null,
    markdown_chars: null,
    neuron_count: null,
    source_slug: null,
    error: null,
    created_at: 0,
  };
}

/** Lifecycle + mutations for one agent's uploaded documents. */
export function useAgentDocuments(agentId: string): UseAgentDocumentsResult {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Guards a late list response from clobbering a newer one (or a unmounted set).
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` is the explicit re-run trigger (manual refresh), not a value read inside the effect.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listDocuments(agentId)
      .then((list) => {
        if (cancelled) return;
        setDocuments(list);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err as Error);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, reloadToken]);

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return [];
      setUploading(true);
      setError(null);
      // Optimistically show pending rows so the list reacts before the server replies.
      const pending = files.map((f) => optimisticRow(agentId, f));
      setDocuments((prev) => [...pending, ...prev]);
      try {
        const results = await uploadDocuments(agentId, files);
        return results;
      } catch (err) {
        setError(err as Error);
        throw err;
      } finally {
        setUploading(false);
        // Refresh either way: success replaces the placeholders with real rows;
        // failure clears the optimistic pending rows that never landed.
        if (liveRef.current) refresh();
      }
    },
    [agentId, refresh],
  );

  const remove = useCallback(
    async (docId: string, opts?: { purgeNeurons?: boolean }) => {
      setError(null);
      try {
        await deleteDocument(agentId, docId, opts);
      } catch (err) {
        setError(err as Error);
        throw err;
      } finally {
        if (liveRef.current) refresh();
      }
    },
    [agentId, refresh],
  );

  return { documents, loading, error, uploading, upload, remove, refresh };
}
