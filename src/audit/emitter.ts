/**
 * AuditEmitter - the ONE typed surface every call site uses to write to the
 * glass-cockpit "productivity stream" (PRD §6.7/§7.1, MNEMO-21).
 *
 * Why a facade over the raw AuditLog DO stub:
 *   - call sites never touch the DO stub directly and never have to remember the
 *     right `level` for an event type. The **default altitude rubric** (§6.7:
 *     `milestone` = the calm default stream, `info` = "show the work", `error` =
 *     failures) is encoded ONCE here, per convenience method;
 *   - a failed audit write can NEVER break the agent loop - every forward is
 *     wrapped in a swallow (audit is observability, not control flow, §7.1).
 *
 * Events are a productivity stream, not a raw token/tool dump: callers pass a
 * human summary plus a small structured `payload` (never raw model tokens or a
 * full tool blob - the store JSON-encodes `payload`).
 *
 * Bind a FRESH emitter per research run via {@link AuditEmitter.withSession} so
 * every event carries that run's `sessionId` (the grouping key for one run's
 * stream). Tools build a full {@link AuditInput} themselves and use the generic
 * {@link AuditEmitter.emit} passthrough (it preserves the input's own
 * `sessionId`); the loop / memory / report layers use the typed methods.
 */
import type { AuditInput, AuditLevel, AuditType } from "./types.ts";

/**
 * The minimal RPC surface the emitter drives: the AuditLog DO's `emit`. Declared
 * structurally (NOT as `DurableObjectStub<AuditLog>`) on purpose - the native RPC
 * stub can't type `emit`, because the spike's `AuditEvent.payload: Record<string,
 * unknown>` is not RPC-type-serializable (`unknown` → `never`); that typed-stub
 * boundary is MNEMO-22's to formalize. Until then a caller passes the
 * `getAuditStub(env, id)` result cast through this interface (or, in tests, the
 * real `AuditLog` instance, which satisfies it directly). The return is `unknown`
 * because the emitter is fire-and-forget - it never reads the appended event.
 */
export interface AuditEmitTarget {
  emit(input: AuditInput): unknown;
}

export class AuditEmitter {
  private readonly target: AuditEmitTarget;
  private readonly sessionId: string | null;

  constructor(target: AuditEmitTarget, sessionId: string | null) {
    this.target = target;
    this.sessionId = sessionId;
  }

  /**
   * Factory: bind a NEW emitter to one research run's `sessionId`. Construct one
   * per run (an interactive turn, a headless run, or a scheduled consolidation)
   * so the run's events group under a single id - do NOT share one across runs.
   */
  static withSession(
    target: AuditEmitTarget,
    sessionId: string | null,
  ): AuditEmitter {
    return new AuditEmitter(target, sessionId);
  }

  // ─── Session lifecycle (milestone - the calm default stream) ──────────────
  sessionStarted(
    text: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    return this.send("session.started", "milestone", text, payload);
  }
  sessionCompleted(
    text: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    return this.send("session.completed", "milestone", text, payload);
  }

  // ─── Research activity (info - "show the work") ───────────────────────────
  sourceRead(url: string, text: string): Promise<void> {
    return this.send("source.read", "info", text, { url });
  }
  memoryWrote(path: string, text: string): Promise<void> {
    return this.send("memory.wrote", "info", text, { path });
  }
  memoryLinked(from: string, to: string, text: string): Promise<void> {
    return this.send("memory.linked", "info", text, { from, to });
  }
  toolRan(
    name: string,
    text: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    return this.send("tool.ran", "info", text, { tool: name, ...payload });
  }
  chartRendered(
    text: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    return this.send("chart.rendered", "info", text, payload);
  }
  narration(text: string): Promise<void> {
    return this.send("narration", "info", text);
  }

  // ─── Milestones (headline events for the calm stream) ─────────────────────
  memoryConsolidated(
    text: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    return this.send("memory.consolidated", "milestone", text, payload);
  }
  /** A deep-dive phase boundary (the initial onboarding dive advancing). */
  onboardingPhase(
    text: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    return this.send("onboarding.phase", "milestone", text, payload);
  }
  /** A weekly self-review completed (grade + counts in the payload). */
  assessmentCompleted(
    text: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    return this.send("assessment.completed", "milestone", text, payload);
  }
  /** The agent revised its own operating playbook (system-prompt learning). */
  selfRevised(text: string, payload?: Record<string, unknown>): Promise<void> {
    return this.send("self.revised", "milestone", text, payload);
  }
  toolAuthored(name: string, text: string): Promise<void> {
    return this.send("tool.authored", "milestone", text, { name });
  }
  reportGenerated(
    text: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    return this.send("report.generated", "milestone", text, payload);
  }

  // ─── Failure ───────────────────────────────────────────────────────────────
  error(text: string, payload?: Record<string, unknown>): Promise<void> {
    return this.send("error", "error", text, payload);
  }

  /**
   * Generic passthrough for a fully-formed {@link AuditInput} (the tool path -
   * tools set their own type / level / payload AND their own `sessionId`).
   * Forwarded verbatim, so the input's `sessionId` is preserved (NOT overridden
   * with the emitter's bound one).
   */
  emit(input: AuditInput): Promise<void> {
    return this.forward(input);
  }

  /** Build a rubric-stamped event bound to this emitter's sessionId, then forward. */
  private send(
    type: AuditType,
    level: AuditLevel,
    text: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    return this.forward({
      type,
      level,
      sessionId: this.sessionId,
      text,
      payload: payload ?? {},
    });
  }

  /** The single swallow point: a failed audit write warns but never throws. */
  private async forward(input: AuditInput): Promise<void> {
    try {
      await this.target.emit(input);
    } catch (err) {
      // Audit is observability, not control flow (§7.1): never propagate.
      console.warn(
        `[audit] emit failed (${input.type}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
