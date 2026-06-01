/**
 * Messaging access control (MNEMO-47, PRD §9.6).
 *
 * THE ACCESS LIST GATES ACCEPTANCE; THE RETURNED TIER CONSTRAINS DISCLOSURE.
 * `decideAccess` answers two separable questions for one inbound message: (1) does
 * the agent respond at all, and (2) at what capability TIER. The whitelist only
 * informs (1) - the real safety boundary is the tier (src/messaging/tiers.ts),
 * which governs what private memory / sensitive tools the turn may use (§9.6). A
 * stranger met in a group can *reach* the bot, but never gets owner-1:1 disclosure.
 *
 * Resolution order (most → least privileged), first match wins:
 *   1. sender === ownerNumber          → `owner`         (full memory + tools)
 *   2. threadId present (group thread)  → `group_member`  (PERMISSIVE: any member)
 *   3. sender on the whitelist          → `known_contact` (guarded private data)
 *   4. agent is open to the world       → `open_world`    (safe public persona)
 *   5. otherwise                        → `{ accept: false }` (whitelist-by-default)
 */
import { addToWhitelist, isWhitelisted } from "../db/index.ts";
import type { Env } from "../env.ts";
import type { AccessDecision } from "./tiers.ts";

/** Inputs the gateway resolves before asking for an access decision. */
export interface DecideAccessInput {
  /** The destination agent (owns the number that was texted). */
  agentId: string;
  /**
   * The agent owner's verified E.164, or null when none is registered. A sender
   * matching this resolves to `owner`; null means the `owner` tier is unreachable
   * (the owner simply hasn't registered a number) - every other tier still works.
   */
  ownerNumber: string | null;
  /** The sender's E.164. */
  from: string;
  /** The group-thread id (MNEMO-48) when this arrived in a group, else null. */
  threadId: string | null;
  /** The agent's `open-to-the-world` flag (whitelist-by-default ⇒ usually false). */
  openToWorld: boolean;
}

/**
 * Decide whether to accept an inbound message and at what {@link CapabilityTier}.
 * See the module comment for the resolution order. The whitelist lookup is the
 * only IO (a bounded D1 existence check) and runs only when the sender is neither
 * the owner nor in a group thread.
 *
 * NB (§9.6): a `group_member` decision is deliberately PERMISSIVE - ANY sender in
 * a group thread is accepted, with safety resting on the tier (group_member never
 * discloses the owner's private memory), NOT on the access list.
 */
export async function decideAccess(
  env: Env,
  input: DecideAccessInput,
): Promise<AccessDecision> {
  // 1. The owner, 1:1 (not in a group), gets the full agent.
  if (
    !input.threadId &&
    input.ownerNumber &&
    input.from === input.ownerNumber
  ) {
    return { accept: true, tier: "owner", reason: "owner number" };
  }

  // 2. A group thread accepts ANY member (permissive auto-expansion, §9.6); the
  // tier - not acceptance - is what guards disclosure for the unverified crowd.
  if (input.threadId) {
    return {
      accept: true,
      tier: "group_member",
      reason: "group thread member",
    };
  }

  // 3. A whitelisted non-owner contact: full conversation, guarded private data.
  if (await isWhitelisted(env, input.agentId, input.from)) {
    return {
      accept: true,
      tier: "known_contact",
      reason: "whitelisted contact",
    };
  }

  // 4. Open-to-the-world: an unknown sender gets the safe public persona.
  if (input.openToWorld) {
    return { accept: true, tier: "open_world", reason: "open to the world" };
  }

  // 5. Whitelist-by-default: an unknown sender to a closed agent is not accepted.
  return {
    accept: false,
    tier: null,
    reason: "not whitelisted; agent is closed",
  };
}

/**
 * Permissive group whitelist auto-expansion (§9.6, "decided permissive"): pulling
 * a bot into a group thread GRANTS every member of that group the right to message
 * it 1:1 thereafter. Each member is added to the whitelist with `scope: 'group'`
 * (idempotent - re-running on the same group is a no-op via `INSERT OR IGNORE`).
 *
 * Safety rests on the capability TIER, not the list: a member added this way later
 * messaging 1:1 (no `threadId`) resolves to `known_contact` (guarded), NEVER
 * `owner`. The MNEMO-48 group coordinator calls this when an agent joins a thread;
 * it is exported here so that phase can reuse the one access module.
 */
export async function expandWhitelistForGroup(
  env: Env,
  agentId: string,
  memberNumbers: string[],
): Promise<void> {
  // De-dupe so a member listed twice in the roster is one write; each add is
  // already idempotent at the DB layer (`INSERT OR IGNORE`). The `'group'` scope
  // marks how the contact earned the right to message - distinct from an
  // owner-added `'global'` contact.
  const unique = new Set(memberNumbers.filter((n) => n.trim() !== ""));
  for (const number of unique) {
    await addToWhitelist(env, agentId, number, "group");
  }
}
