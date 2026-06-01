import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addToWhitelist, createAccount, createAgent } from "../src/db/index.ts";
import { decideAccess } from "../src/messaging/access.ts";
import { tierConstraints } from "../src/messaging/tiers.ts";

// MNEMO-47: messaging access control (PRD §9.6). Runs in the workers pool so the
// D1 `DB` binding (the whitelist lookup) is real. The capability TIER - not the
// access list - is the safety boundary: these assert decideAccess resolves the
// right tier per sender, and that tierConstraints gates private-memory disclosure.

const OWNER = "+15550000001";
const KNOWN = "+15550000002";
const STRANGER = "+15550000003";

/** Seed account → agent (FK target for message_whitelist); return the agent id. */
async function seedAgent(): Promise<string> {
  const account = await createAccount(env, {
    email: `access-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Access agent",
  });
  return agent.id;
}

describe("decideAccess (PRD §9.6)", () => {
  it("resolves the owner number to the `owner` tier (1:1)", async () => {
    const agentId = await seedAgent();
    const d = await decideAccess(env, {
      agentId,
      ownerNumber: OWNER,
      from: OWNER,
      threadId: null,
      openToWorld: false,
    });
    expect(d).toMatchObject({ accept: true, tier: "owner" });
  });

  it("resolves a whitelisted non-owner to `known_contact`", async () => {
    const agentId = await seedAgent();
    await addToWhitelist(env, agentId, KNOWN);
    const d = await decideAccess(env, {
      agentId,
      ownerNumber: OWNER,
      from: KNOWN,
      threadId: null,
      openToWorld: false,
    });
    expect(d).toMatchObject({ accept: true, tier: "known_contact" });
  });

  it("resolves an unknown sender to `open_world` ONLY when the flag is on", async () => {
    const agentId = await seedAgent();
    const open = await decideAccess(env, {
      agentId,
      ownerNumber: OWNER,
      from: STRANGER,
      threadId: null,
      openToWorld: true,
    });
    expect(open).toMatchObject({ accept: true, tier: "open_world" });
  });

  it("rejects an unknown sender when the agent is closed (whitelist-by-default)", async () => {
    const agentId = await seedAgent();
    const d = await decideAccess(env, {
      agentId,
      ownerNumber: OWNER,
      from: STRANGER,
      threadId: null,
      openToWorld: false,
    });
    expect(d.accept).toBe(false);
    expect(d.tier).toBeNull();
  });

  it("resolves to `group_member` whenever a threadId is present - even the owner, even when closed", async () => {
    const agentId = await seedAgent();
    // A stranger in a group is accepted (permissive, §9.6) despite a closed agent.
    const stranger = await decideAccess(env, {
      agentId,
      ownerNumber: OWNER,
      from: STRANGER,
      threadId: "G-123",
      openToWorld: false,
    });
    expect(stranger).toMatchObject({ accept: true, tier: "group_member" });

    // The owner in a (mixed/unverified) group is group_member, NOT owner - a group
    // never gets owner-1:1 disclosure (§9.6).
    const ownerInGroup = await decideAccess(env, {
      agentId,
      ownerNumber: OWNER,
      from: OWNER,
      threadId: "G-123",
      openToWorld: false,
    });
    expect(ownerInGroup.tier).toBe("group_member");
  });
});

describe("tierConstraints (PRD §9.6 - the real safety boundary)", () => {
  it("leaves the owner unconstrained (full memory + tools)", () => {
    const c = tierConstraints("owner");
    expect(c.allowPrivateMemory).toBe(true);
    expect(c.allowSensitiveTools).toBe(true);
    expect(c.systemConstraint).toBe("");
  });

  it("denies private memory for `group_member` and `open_world`", () => {
    expect(tierConstraints("group_member").allowPrivateMemory).toBe(false);
    expect(tierConstraints("open_world").allowPrivateMemory).toBe(false);
    // open_world also loses sensitive tools (the safe public persona).
    expect(tierConstraints("open_world").allowSensitiveTools).toBe(false);
    // Both carry a non-empty disclosure guard injected into the system prompt.
    expect(tierConstraints("group_member").systemConstraint).not.toBe("");
    expect(tierConstraints("open_world").systemConstraint).not.toBe("");
  });

  it("allows private memory for `known_contact` but still adds a discretion guard", () => {
    const c = tierConstraints("known_contact");
    expect(c.allowPrivateMemory).toBe(true);
    expect(c.systemConstraint).not.toBe("");
  });
});
