import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createAccount,
  createAgent,
  createReport,
  getAccountByEmail,
  getAgent,
  listAgentsByAccount,
  listReportsByAgent,
  updateAgent,
} from "../src/db/index.ts";

// Schema is seeded by test/apply-migrations.ts (setupFile) against the local
// D1 bound as `DB`. Each test creates its own account so rows don't collide.

describe("D1 access layer", () => {
  it("round-trips an account → agent → report chain with FKs intact", async () => {
    const email = `chain-${crypto.randomUUID()}@example.com`;
    const account = await createAccount(env, { email });
    expect(account.id).toBeTruthy();
    expect(account.email).toBe(email);
    expect(account.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Account reads back identically through the Zod helper.
    expect(await getAccountByEmail(env, email)).toEqual(account);

    const agent = await createAgent(env, {
      account_id: account.id,
      name: "Acme vendor watch",
      description: "Tracks Acme releases",
      template: "vendor",
    });
    // FK to accounts holds.
    expect(agent.account_id).toBe(account.id);
    expect(agent.template).toBe("vendor");
    expect(agent.status).toBe("active"); // DB default applied via COALESCE
    expect(agent.schedule_cron).toBeNull();
    expect(await getAgent(env, agent.id)).toEqual(agent);
    expect(await listAgentsByAccount(env, account.id)).toContainEqual(agent);

    const report = await createReport(env, {
      agent_id: agent.id,
      title: "Weekly digest",
      r2_key: `reports/${agent.id}/0001.md`,
      front_matter: JSON.stringify({ tags: ["vendor"], week: 21 }),
    });
    // FK to agents holds.
    expect(report.agent_id).toBe(agent.id);
    expect(await listReportsByAgent(env, agent.id)).toContainEqual(report);
  });

  it("updateAgent applies a partial patch and preserves other columns", async () => {
    const account = await createAccount(env, {
      email: `upd-${crypto.randomUUID()}@example.com`,
    });
    const agent = await createAgent(env, {
      account_id: account.id,
      name: "Initial name",
    });
    expect(agent.template).toBeNull();

    const updated = await updateAgent(env, agent.id, {
      name: "Renamed",
      status: "paused",
      template: "investor",
    });
    expect(updated).not.toBeNull();
    expect(updated?.name).toBe("Renamed");
    expect(updated?.status).toBe("paused");
    expect(updated?.template).toBe("investor");
    // Untouched columns survive the partial update.
    expect(updated?.account_id).toBe(account.id);
    expect(updated?.created_at).toBe(agent.created_at);

    // An empty patch is a no-op that returns the current row.
    expect(await updateAgent(env, agent.id, {})).toEqual(updated);
  });

  it("returns null for absent rows", async () => {
    expect(await getAccountByEmail(env, "nobody@example.com")).toBeNull();
    expect(await getAgent(env, crypto.randomUUID())).toBeNull();
    expect(
      await updateAgent(env, crypto.randomUUID(), { name: "x" }),
    ).toBeNull();
  });

  it("lists are scoped to their parent", async () => {
    const a1 = await createAccount(env, {
      email: `scope1-${crypto.randomUUID()}@example.com`,
    });
    const a2 = await createAccount(env, {
      email: `scope2-${crypto.randomUUID()}@example.com`,
    });
    const agent1 = await createAgent(env, {
      account_id: a1.id,
      name: "A1 agent",
    });
    await createAgent(env, { account_id: a2.id, name: "A2 agent" });

    const a1Agents = await listAgentsByAccount(env, a1.id);
    expect(a1Agents).toHaveLength(1);
    expect(a1Agents[0]).toEqual(agent1);
  });
});
