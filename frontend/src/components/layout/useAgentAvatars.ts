/**
 * useAgentAvatars - per-agent custom avatar images, chosen by the operator. Like
 * agent grouping, this is a per-device UI preference today: a downscaled JPEG
 * data URL per agent, stored in `localStorage` scoped by account id. (Promoting
 * it to cross-device persistence is an `avatar_url` column + an upload to object
 * storage; the card/sidebar read through this hook either way.)
 *
 * Backed by `usePersistentState`, so a change made on a dashboard card is
 * reflected live in the sidebar (same-key instances stay in sync).
 */
import { useCallback } from "react";
import { useSession } from "@/auth/useSession";
import { usePersistentState } from "@/lib/usePersistentState";

/** agentId → data-URL image. A missing entry falls back to initials. */
type AvatarMap = Record<string, string>;

export interface AgentAvatars {
  /** The custom avatar data URL for an agent, or `undefined` if none set. */
  avatarOf: (agentId: string) => string | undefined;
  /** Set (or clear, with `null`) an agent's custom avatar. */
  setAvatar: (agentId: string, dataUrl: string | null) => void;
}

export function useAgentAvatars(): AgentAvatars {
  const { account } = useSession();
  const scope = account?.id ?? "anon";
  const [map, setMap] = usePersistentState<AvatarMap>(
    `mnemosyne:agent-avatars:${scope}`,
    {},
  );

  const avatarOf = useCallback(
    (agentId: string): string | undefined => map[agentId],
    [map],
  );

  const setAvatar = useCallback(
    (agentId: string, dataUrl: string | null) => {
      setMap((prev) => {
        const next = { ...prev };
        if (dataUrl) next[agentId] = dataUrl;
        else delete next[agentId];
        return next;
      });
    },
    [setMap],
  );

  return { avatarOf, setAvatar };
}
