import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createAccount,
  createAgent,
  isWhitelisted,
  listWhitelist,
} from "../src/db/index.ts";
import {
  decideAccess,
  expandWhitelistForGroup,
} from "../src/messaging/access.ts";

// MNEMO-47: permissive group whitelist auto-expansion (PRD §9.6, "decided
// permissive"). Pulling a bot into a group grants every member the right to DM it
// - but safety rests on the TIER, not the list: a group-added member messaging 1:1
// resolves to `known_contact` (guarded), NEVER `owner`. Runs in the workers pool
// (real D1 `message_whitelist`).

const OWNER = "+15551110000";
const MEMBERS = ["+15551110001", "+15551110002", "+15551110003"];

async function seedAgent(): Promise<string> {
  const account = await createAccount(env, {
    email: `group-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Group agent",
  });
  return agent.id;
}

describe("expandWhitelistForGroup (PRD §9.6)", () => {
  it("whitelists every member with scope 'group'", async () => {
    const agentId = await seedAgent();
    await expandWhitelistForGroup(env, agentId, MEMBERS);

    for (const m of MEMBERS) {
      expect(await isWhitelisted(env, agentId, m)).toBe(true);
    }
    const rows = await listWhitelist(env, agentId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.scope === "group")).toBe(true);
  });

  it("a group-added member messaging 1:1 resolves to known_contact, NOT owner", async () => {
    const agentId = await seedAgent();
    await expandWhitelistForGroup(env, agentId, MEMBERS);

    // A 1:1 (no threadId) from a member who is ALSO the registered owner number for
    // a DIFFERENT agent is irrelevant here; the point is: a group-granted contact in
    // a 1:1 is `known_contact`, the guarded tier - never the owner tier.
    const d = await decideAccess(env, {
      agentId,
      ownerNumber: OWNER, // owner is someone else entirely
      from: MEMBERS[0],
      threadId: null,
      openToWorld: false,
    });
    expect(d).toMatchObject({ accept: true, tier: "known_contact" });
    expect(d.tier).not.toBe("owner");
  });

  it("is idempotent - re-running on the same group adds no duplicates", async () => {
    const agentId = await seedAgent();
    await expandWhitelistForGroup(env, agentId, MEMBERS);
    await expandWhitelistForGroup(env, agentId, MEMBERS);
    expect(await listWhitelist(env, agentId)).toHaveLength(3);
  });
});
