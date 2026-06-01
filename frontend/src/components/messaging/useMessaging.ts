/**
 * Messaging data hooks (PRD §9) - plain fetch-on-mount + manual `refetch` hooks
 * over `@/api/messaging`, matching the no-global-cache pattern used across the
 * app (see `useAgentMetrics`, `useBrainGraph`). Each owns its own loading/error
 * state; mutations live in the components and call `refetch` to reconcile.
 */
import { useCallback, useEffect, useState } from "react";
import {
  getMessagingAccess,
  getMessagingStatus,
  listMessagingSessions,
  type MessagingAccess,
  type MessagingSession,
  type MessagingStatus,
} from "@/api/messaging";

interface AsyncResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/** Shared fetch-on-mount hook with a manual refetch token. */
function useFetch<T>(load: () => Promise<T>, deps: unknown[]): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [token, setToken] = useState(0);

  const refetch = useCallback(() => setToken((t) => t + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` identity isn't stable; the caller's `deps` (+ refetch token) are the real triggers.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err as Error);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, token]);

  return { data, loading, error, refetch };
}

export function useMessagingStatus(
  agentId: string,
): AsyncResult<MessagingStatus> {
  return useFetch(() => getMessagingStatus(agentId), [agentId]);
}

export function useMessagingSessions(
  agentId: string,
): AsyncResult<MessagingSession[]> {
  return useFetch(() => listMessagingSessions(agentId), [agentId]);
}

export function useMessagingAccess(
  agentId: string,
): AsyncResult<MessagingAccess> {
  return useFetch(() => getMessagingAccess(agentId), [agentId]);
}
