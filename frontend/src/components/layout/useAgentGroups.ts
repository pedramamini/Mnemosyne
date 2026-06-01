/**
 * useAgentGroups (sidebar agent grouping) - lets the operator organize their
 * agents into named, collapsible groups in the sidebar. Grouping is a per-device
 * UI preference today: assignments live in `localStorage`, scoped by account id
 * so two accounts on one machine don't bleed into each other. (Promoting this to
 * cross-device persistence is a nullable `group` column on the agents table +
 * one PATCH field - the sidebar reads through this hook either way.)
 *
 * Groups are DERIVED from assignments: a group exists exactly while ≥1 agent is
 * assigned to it, so there are no empty/orphaned groups to garbage-collect. The
 * per-group collapsed flag is stored separately; stale entries are harmless.
 */
import { useCallback, useMemo } from "react";
import { useSession } from "@/auth/useSession";
import { usePersistentState } from "@/lib/usePersistentState";

/** agentId → group name. A missing entry means the agent is ungrouped. */
type Assignments = Record<string, string>;
/** group name → collapsed? (missing/false ⇒ expanded). */
type CollapsedGroups = Record<string, boolean>;

export interface AgentGroups {
  /** The group an agent belongs to, or `null` if ungrouped. */
  groupOf: (agentId: string) => string | null;
  /** Distinct group names currently in use, sorted (locale-aware, case-insensitive). */
  groupNames: string[];
  /** Assign an agent to a group; pass `null` (or empty) to ungroup it. */
  assign: (agentId: string, group: string | null) => void;
  /** Whether a group is collapsed in the sidebar. */
  isCollapsed: (group: string) => boolean;
  /** Toggle a group's collapsed state. */
  toggleCollapsed: (group: string) => void;
}

export function useAgentGroups(): AgentGroups {
  const { account } = useSession();
  const scope = account?.id ?? "anon";

  const [assignments, setAssignments] = usePersistentState<Assignments>(
    `mnemosyne:agent-groups:${scope}`,
    {},
  );
  const [collapsed, setCollapsed] = usePersistentState<CollapsedGroups>(
    `mnemosyne:agent-groups:collapsed:${scope}`,
    {},
  );

  const groupOf = useCallback(
    (agentId: string): string | null => assignments[agentId] ?? null,
    [assignments],
  );

  const groupNames = useMemo(
    () =>
      Array.from(new Set(Object.values(assignments))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      ),
    [assignments],
  );

  const assign = useCallback(
    (agentId: string, group: string | null) => {
      setAssignments((prev) => {
        const next = { ...prev };
        const trimmed = group?.trim();
        if (trimmed) next[agentId] = trimmed;
        else delete next[agentId];
        return next;
      });
    },
    [setAssignments],
  );

  const isCollapsed = useCallback(
    (group: string) => Boolean(collapsed[group]),
    [collapsed],
  );

  const toggleCollapsed = useCallback(
    (group: string) => {
      setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }));
    },
    [setCollapsed],
  );

  return { groupOf, groupNames, assign, isCollapsed, toggleCollapsed };
}
