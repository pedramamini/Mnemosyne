/**
 * Public surface of the per-agent DO module. The Worker re-exports
 * `MnemosyneAgent` from `src/index.ts` so Wrangler can register the DO class;
 * the schemas/factories are shared by routes and tests.
 */
import type { Env } from "../env.ts";
import type { MnemosyneAgent } from "./MnemosyneAgent.ts";

export { MnemosyneAgent } from "./MnemosyneAgent.ts";
export {
  AgentSchedule,
  AgentSettings,
  defaultSchedule,
  defaultSettings,
} from "./types.ts";

/**
 * Resolve the per-agent Durable Object stub. One instance per agent via
 * `idFromName` - no allocation logic (mirrors Crema). Public methods on the
 * returned stub (`getSettings`, `updateSettings`, …) are callable directly via
 * native Workers RPC, so callers round-trip into the DO without a fetch switch
 * (see `MnemosyneAgent`'s class comment).
 *
 * Lives here (the agent module's public surface) rather than in `src/index.ts`
 * so the registry service layer can resolve the DO without importing the Worker
 * entrypoint - `src/index.ts` re-exports it for backward compatibility.
 */
export function getAgentStub(
  env: Env,
  agentId: string,
): DurableObjectStub<MnemosyneAgent> {
  return env.AGENT.get(env.AGENT.idFromName(agentId));
}
