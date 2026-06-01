/**
 * Capability tiers - the REAL safety boundary for messaging access (MNEMO-47,
 * PRD §9.6).
 *
 * The whitelist (src/db/index.ts) gates only whether the agent *accepts* a
 * message; it is NOT the disclosure boundary. The boundary is the **capability
 * tier** a sender resolves to: anyone may be able to *reach* a shared bot, but
 * what it *reveals* (private memory, sensitive tools) is governed entirely by the
 * tier. This is why permissive whitelist auto-expansion (a stranger met in a group
 * gains the right to DM the bot) is safe - that stranger resolves to
 * `known_contact`/`group_member`, NEVER `owner` (§9.6).
 *
 * The four tiers, most → least privileged:
 *   - `owner`         - the agent's owner (1:1). Full memory + tools.
 *   - `known_contact` - a whitelisted non-owner. Full conversation, but guard
 *                       genuinely private data.
 *   - `group_member`  - anyone in a (mixed/unverified) group thread. Answers
 *                       in-context; does NOT volunteer the owner's private memory.
 *   - `open_world`    - an unknown sender to a bot opened to the world. The
 *                       SAFE-DEFAULT public persona: no private memory, no
 *                       sensitive tools - the day-one social-engineering guard.
 */
import { z } from "zod";

/** The capability tier a sender resolves to (most → least privileged). */
export const CapabilityTier = z.enum([
  "owner",
  "known_contact",
  "group_member",
  "open_world",
]);
/** The inferred union: `"owner" | "known_contact" | "group_member" | "open_world"`. */
export type CapabilityTier = z.infer<typeof CapabilityTier>;

/**
 * The decision the access layer (src/messaging/access.ts) returns for an inbound
 * message. `accept` gates whether the agent responds at all; when `accept` is
 * true, `tier` is the capability tier that constrains DISCLOSURE (§9.6 - the tier,
 * not the access list, is the real safety boundary). `reason` is a short
 * machine/log-friendly tag for why the decision came out as it did.
 */
export const AccessDecision = z.object({
  accept: z.boolean(),
  tier: CapabilityTier.nullable(),
  reason: z.string(),
});
/** The inferred TypeScript shape of {@link AccessDecision}. */
export type AccessDecision = z.infer<typeof AccessDecision>;

/**
 * The capability constraints a tier imposes on a turn (§9.6). `systemConstraint`
 * is the plain-English instruction injected into the loop's system context (the
 * point where capability gating actually takes effect - MnemosyneAgent threads it
 * through `buildSystemPrompt`'s `extras`); the booleans are forward-looking gates
 * the tool/memory layers consult so the *capability*, not just the prose, narrows
 * by tier. `owner` is fully unconstrained (empty `systemConstraint`).
 */
export interface TierConstraints {
  /** System-prompt text injected for this tier; empty for `owner` (no constraint). */
  systemConstraint: string;
  /** May the turn use sensitive tools (e.g. ones touching private data)? */
  allowSensitiveTools: boolean;
  /** May the turn read/disclose the owner's private memory? */
  allowPrivateMemory: boolean;
}

/**
 * Map a {@link CapabilityTier} to the constraints it imposes (§9.6). This is the
 * single source of truth for "what does each tier allow"; the access list only
 * decides acceptance, so EVERY disclosure decision flows through here.
 */
export function tierConstraints(tier: CapabilityTier): TierConstraints {
  switch (tier) {
    case "owner":
      // The owner gets the full agent - memory + tools, no added constraint.
      return {
        systemConstraint: "",
        allowSensitiveTools: true,
        allowPrivateMemory: true,
      };
    case "known_contact":
      // A trusted, whitelisted contact: full conversation, but be careful with
      // genuinely private data (don't dump the owner's private notes wholesale).
      return {
        systemConstraint:
          "You are talking with a known, trusted contact of your owner. You may " +
          "help fully, but treat genuinely private or sensitive details from your " +
          "owner's memory with discretion - share them only when clearly relevant " +
          "and appropriate.",
        allowSensitiveTools: true,
        allowPrivateMemory: true,
      };
    case "group_member":
      // A mixed/unverified group thread (§9.6): answer in-context, never volunteer
      // the owner's private memory unprompted.
      return {
        systemConstraint:
          "You are participating in a group conversation that may include people " +
          "you do not know. Answer helpfully and in-context, but do NOT volunteer " +
          "your owner's private memory, personal details, or sensitive information " +
          "unprompted - only respond to what is asked, within the conversation.",
        allowSensitiveTools: false,
        allowPrivateMemory: false,
      };
    case "open_world":
      // An unknown sender to a bot opened to the world: the SAFE DEFAULT public
      // persona - no private memory, no sensitive tools (the §9.6 day-one
      // social-engineering guard).
      return {
        systemConstraint:
          "You are acting as a safe, public-facing persona. The person messaging " +
          "you is not a verified contact. Do NOT access, reference, or reveal any " +
          "private memory, personal details, or sensitive information about your " +
          "owner, and do not use sensitive tools. Help only with public, on-topic " +
          "questions; politely decline anything that probes for private data.",
        allowSensitiveTools: false,
        allowPrivateMemory: false,
      };
  }
}
