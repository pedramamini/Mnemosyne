/**
 * @-mention parsing for the group floor override (MNEMO-48, PRD §9.4 - "a named
 * agent always responds").
 *
 * Pure helpers, NO I/O - so the override rule is unit-testable without a DO. The
 * coordinator (src/messaging/ThreadCoordinator.ts) runs {@link parseMentions} over
 * the inbound body against the member roster: a mentioned agent BYPASSES the cheap
 * triage gate entirely and is ALWAYS a floor winner (it can exceed the normal
 * MAX_FLOOR_WINNERS cap), because a directly-addressed agent must answer.
 *
 * Matching is deliberately CONSERVATIVE so a stray `@` never false-triggers a
 * response: a mention token must follow a word boundary (start-of-string or
 * whitespace) and contain at least one name character, so `foo@bar` (an email) and
 * a lone `@` are ignored. Comparison is case-insensitive and punctuation-folded so
 * `@Atlas`, `@atlas`, and `@atlas,` all match a member named "Atlas".
 */

/** A group member as the mention parser sees it: an agentId + how it's addressed. */
export interface MentionMember {
  /** The member's agent id (what {@link parseMentions} returns when matched). */
  agentId: string;
  /** The member's display name (e.g. "Atlas"). */
  name: string;
  /** An optional explicit handle (e.g. "scout") matched alongside the name. */
  handle?: string;
}

/**
 * Mention tokens are `@` at a word boundary followed by one or more name chars
 * (letters/digits/underscore/hyphen). The leading boundary (`^` or whitespace)
 * keeps `foo@bar` (an email) from registering as a `@bar` mention, and the `+`
 * means a bare `@` matches nothing - the conservative-matching guard (§9.4).
 */
const MENTION_RE = /(?:^|\s)@([A-Za-z0-9_-]+)/g;

/** Fold a name/handle/token to a comparison key: lowercase, drop non-alphanumerics. */
function foldKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Return the agentIds explicitly @-mentioned in `body`, matched against `members`
 * by name or handle (case-insensitive, punctuation-folded). A member matches if a
 * mention token folds to the same key as the member's `handle`, its full `name`,
 * or the first word of its `name` (so "@atlas" hits a member named "Atlas Vendor
 * Watch"). Order follows the member list; each agent appears at most once.
 *
 * A mentioned agent bypasses the triage gate and is always a floor winner (§9.4).
 */
export function parseMentions(
  body: string,
  members: MentionMember[],
): string[] {
  const tokens = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    const key = foldKey(match[1]);
    if (key) tokens.add(key);
  }
  if (tokens.size === 0) return [];

  const matched: string[] = [];
  for (const member of members) {
    const candidates = new Set<string>();
    if (member.handle) candidates.add(foldKey(member.handle));
    candidates.add(foldKey(member.name));
    const firstWord = member.name.trim().split(/\s+/)[0];
    if (firstWord) candidates.add(foldKey(firstWord));
    candidates.delete(""); // a name that folds to nothing can't be addressed

    if ([...candidates].some((c) => tokens.has(c)))
      matched.push(member.agentId);
  }
  return matched;
}
