/**
 * Public surface of the audit-log module (PRD §7.4/§8.6 - the "glass cockpit").
 *
 * The Worker re-exports {@link AuditLog} from `src/index.ts` so Wrangler can
 * register the DO class behind the `AUDIT` binding; {@link getAuditStub} resolves
 * one instance per agent via `idFromName`. The store + types are the untouched
 * `src/audit` spike; {@link AuditEmitter} (MNEMO-21) is the typed write facade the
 * agent loop / tools / memory layer narrate through.
 */
import type { Env } from "../env.ts";
import { AuditLog } from "./AuditLog.ts";

export { type AuditEmitTarget, AuditEmitter } from "./emitter.ts";
export { AuditStore, type SqlDriver } from "./store.ts";
export type {
  AuditEvent,
  AuditInput,
  AuditLevel,
  AuditQuery,
  AuditType,
} from "./types.ts";
export { AuditLog };

/**
 * Resolve the per-agent {@link AuditLog} Durable Object stub (MNEMO-20). One
 * instance per agent via `idFromName` - no allocation logic - mirroring
 * `getAgentStub`, but on the DEDICATED `AUDIT` namespace so the audit index is
 * independent of the `AGENT` DO and can be queried without waking the agent loop
 * (PRD §7.4/§8.6). Lives here (not in `src/index.ts`) so the agent DO can resolve
 * its own audit stub without importing the Worker entrypoint (a circular import);
 * `src/index.ts` re-exports it for route callers.
 */
export function getAuditStub(
  env: Env,
  agentId: string,
): DurableObjectStub<AuditLog> {
  return env.AUDIT.get(env.AUDIT.idFromName(agentId));
}
