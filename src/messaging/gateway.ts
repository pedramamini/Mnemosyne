/**
 * Inbound messaging gateway - the public webhook Twilio POSTs to when someone
 * texts an agent's number (MNEMO-45, PRD §9.3/§9.6).
 *
 * Contract (§9.3): "ack the webhook immediately, never reply inline." The handler
 * authenticates the call (the Twilio signature is the credential - this route is
 * intentionally NOT behind `requireAuth`, Twilio is not a logged-in user),
 * resolves the destination number to its owning agent, normalizes the Twilio form
 * payload into the channel-agnostic {@link InboundMessage}, FIRE-AND-FORGETS the
 * handoff to the per-agent DO via `executionCtx.waitUntil(...)`, then returns
 * Twilio's expected empty-TwiML ack - it MUST never block on the agent loop. The
 * actual reply is async and built in MNEMO-46.
 *
 * Sender access control (whitelist / capability tiers) lands in MNEMO-47; group
 * thread orchestration (routing to the ThreadCoordinator DO) lands in MNEMO-48 -
 * see {@link groupThreadIdFor} for the gated SMS-group path.
 */
import type { Hono } from "hono";
import { getAgentStub } from "../agent/index.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { getAgentIdByNumber } from "../db/index.ts";
import type { Env } from "../env.ts";
import { decideAccess } from "./access.ts";
import type { GroupInbound } from "./groupTypes.ts";
import { MalformedInboundError, normalizeTwilioInbound } from "./normalize.ts";
import { validateTwilioSignature } from "./twilioSignature.ts";
import type { InboundMessage } from "./types.ts";

/** Twilio's expected ack: an empty TwiML document means "no inline reply". */
const EMPTY_TWIML = "<Response></Response>";

/**
 * Register `POST /webhooks/twilio/sms` on the Hono app - the public Twilio
 * inbound webhook. See the module comment for the §9.3 ack-immediately contract.
 */
export function mountMessagingGateway(app: Hono<AppEnv>): void {
  app.post("/webhooks/twilio/sms", async (c) => {
    const env = c.env;

    // (1) Read the raw form body. Twilio posts application/x-www-form-urlencoded;
    // collect the string fields into the channel-agnostic shape the rest expects.
    const formData = await c.req.formData();
    const form: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") form[key] = value;
    }

    // (2) Authenticate: the X-Twilio-Signature is computed over the EXACT full URL
    // Twilio signed (the URL the Worker received) plus the sorted POST params. On
    // failure, 403 immediately and do nothing else (PRD §9.6).
    const valid = await validateTwilioSignature(
      env.TWILIO_AUTH_TOKEN,
      c.req.url,
      form,
      c.req.header("X-Twilio-Signature") ?? "",
    );
    if (!valid) return c.text("invalid signature", 403);

    // (3) Normalize the (now-authenticated) payload to InboundMessage. A validly
    // signed Twilio SMS always carries From/To/Body; a structurally broken one
    // throws MalformedInboundError → 400 (surfaces the bug, never reaches a DO).
    let msg: ReturnType<typeof normalizeTwilioInbound>;
    try {
      msg = normalizeTwilioInbound(form);
    } catch (err) {
      if (err instanceof MalformedInboundError) {
        return c.text("malformed inbound payload", 400);
      }
      throw err;
    }

    // (4) Resolve the destination number → owning agent. No owner ⇒ return an
    // empty 204 so Twilio doesn't retry, and warn (no audit log - no agent to
    // attribute it to). Nothing is handed off.
    const agentId = await getAgentIdByNumber(env, msg.to);
    if (!agentId) {
      console.warn(`inbound SMS to unprovisioned number ${msg.to} - dropped`);
      return c.body(null, 204);
    }

    // (5) Access control (MNEMO-47, PRD §9.6). Load the agent's owner number +
    // open-to-the-world flag from its DO (agent_meta), then decide acceptance +
    // capability tier. The access list gates ONLY acceptance; the returned tier
    // constrains what the agent discloses (the real safety boundary, §9.6).
    const stub = getAgentStub(env, agentId);
    const access = await stub.getMessagingAccess();
    const decision = await decideAccess(env, {
      agentId,
      ownerNumber: access.ownerNumber,
      from: msg.from,
      threadId: msg.threadId,
      openToWorld: access.openToWorld,
    });

    // Not accepted (whitelist-by-default: an unknown sender to a closed agent).
    // Still ack with the empty TwiML so Twilio doesn't retry, but invoke NO loop -
    // a closed agent stays silent to strangers. No audit log here: a dropped
    // message has no session to attribute it to.
    if (!decision.accept) {
      console.warn(
        `inbound SMS to ${msg.to} from ${msg.from} rejected: ${decision.reason}`,
      );
      return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
    }

    // (6) Hand off, FIRE-AND-FORGET via waitUntil so the loop runs AFTER the ack
    // returns - the ack must never block on agent work (§9.3).
    const groupThreadId = groupThreadIdFor(env, msg);
    if (groupThreadId) {
      // Group thread (MNEMO-48 §9.4): route to the per-thread ThreadCoordinator DO
      // instead of a single agent DO. The coordinator fans the message to every
      // member, runs the triage gate + floor control, and invokes only the winners.
      c.executionCtx.waitUntil(routeToGroup(env, msg, groupThreadId, agentId));
    } else {
      // 1:1 (the default): straight to the destination agent's DO. The resolved
      // `tier` rides along so the reply's system context is constrained to it
      // (MNEMO-47 §9.6 capability gating). `tier` is non-null on an accept.
      c.executionCtx.waitUntil(
        stub.onInboundMessage(msg, decision.tier ?? "owner"),
      );
    }

    // (7) Ack immediately: empty TwiML, text/xml, 200. The reply is async (§9.3).
    return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
  });
}

/**
 * The group `threadId` for an inbound message, or `null` for a 1:1 (the default).
 *
 * A group-capable transport supplies its OWN native thread id (`msg.threadId`), and
 * we honor it directly. SMS has NO native group thread (MNEMO-44
 * `capabilities.group=false`), so an SMS group is OPT-IN behind the
 * `MESSAGING_SMS_GROUPS` flag (§9.4 "gate this path behind a clear flag"): when
 * enabled, the thread id is DERIVED deterministically from the sorted participant
 * set (see {@link deriveGroupThreadId}) so the same group always maps to one
 * coordinator. Flag off ⇒ every SMS is 1:1.
 */
function groupThreadIdFor(env: Env, msg: InboundMessage): string | null {
  if (msg.threadId) return msg.threadId; // native group id from the transport
  if (env.MESSAGING_SMS_GROUPS === "enabled") {
    return deriveGroupThreadId([msg.from, msg.to]);
  }
  return null;
}

/**
 * Derive a STABLE group `threadId` from a participant set: sort the E.164s (so the
 * id is independent of who sent the current message) and hash them. This is the
 * scheme SMS group threads use until a transport offers native group ids - the
 * same group of numbers always resolves to the same `ThreadCoordinator` instance.
 * Exported so an explicit group-provisioning flow can mint the same id. Pure.
 */
export function deriveGroupThreadId(participants: string[]): string {
  const sorted = [...new Set(participants)].sort();
  let hash = 5381;
  const joined = sorted.join(",");
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
  }
  return `smsgrp-${(hash >>> 0).toString(36)}`;
}

/**
 * Hand a group inbound to its {@link ThreadCoordinator} (one per `threadId`). The
 * member roster is the orchestration's source of truth: a group-capable transport
 * carries it, and explicit SMS group provisioning supplies it. Until then we seed
 * the roster with the destination agent + the two known numbers - the documented
 * extension point where the full multi-agent roster is resolved. The coordinator
 * decides the floor; the gateway only routes (§9.4).
 */
async function routeToGroup(
  env: Env,
  msg: InboundMessage,
  threadId: string,
  destAgentId: string,
): Promise<void> {
  const input: GroupInbound = {
    threadId,
    from: msg.from,
    body: msg.body,
    channel: msg.channel,
    // Extension point: a real group transport / explicit provisioning supplies the
    // full member roster. Seeded here with the addressed agent + known participants.
    memberAgentIds: [destAgentId],
    memberNumbers: [msg.from, msg.to],
    ts: Date.now(),
  };
  const coordinator = env.THREAD.get(env.THREAD.idFromName(threadId));
  await coordinator.onGroupMessage(input);
}
