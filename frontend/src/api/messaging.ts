/**
 * Messaging API (PRD §9) - a typed client over the MNEMO-46/47 messaging routes
 * for one agent's SMS / group-thread presence. Mirrors the `apiFetch` transport
 * used elsewhere; the session cookie rides along via `credentials: "include"`.
 *
 * Reads (MNEMO-46):
 *   getMessagingStatus(id)               GET    /messaging/status
 *   listMessagingSessions(id)            GET    /messaging/sessions
 *   listSessionMessages(id, sessionId)   GET    /messaging/sessions/:id/messages
 *   getMessagingAccess(id)               GET    /messaging/access
 * Writes (MNEMO-47):
 *   enableMessaging(id, areaCode?)       POST   /messaging/enable
 *   disableMessaging(id)                 POST   /messaging/disable
 *   updateMessagingAccess(id, patch)     PUT    /messaging/access
 *   addWhitelistContact(id, e164)        POST   /messaging/whitelist
 *   removeWhitelistContact(id, e164)     DELETE /messaging/whitelist/:e164
 *
 * Shapes mirror `src/messaging/persistence.ts` + the route handlers.
 */
import { del, get, post, put } from "./client";

/** Transport channel a session/message rode in on (§9.5 badge). */
export type Channel = "sms" | "imessage" | "rcs";
/** A 1:1 daily thread vs. a stable multi-agent group thread. */
export type SessionKind = "1to1" | "group";
/** Inbound (from a contact) vs. outbound (from the agent). */
export type MessageDirection = "in" | "out";

/** Shared 10DLC brand/campaign registration state (only `status` is surfaced). */
export interface A2pStatus {
  brand: { status: string } | null;
  campaign: { status: string } | null;
}

/** `GET /messaging/status` - is messaging enabled + the agent's number + A2P state. */
export interface MessagingStatus {
  enabled: boolean;
  e164: string | null;
  a2p: A2pStatus;
}

/** `POST /messaging/enable` - the provisioned (or already-assigned) number. */
export interface EnableResult {
  e164: string;
  alreadyEnabled?: boolean;
}

/** A conversation in the list (newest first), with a per-session channel + count. */
export interface MessagingSession {
  id: string;
  counterparty: string;
  threadId: string | null;
  channel: Channel;
  kind: SessionKind;
  /** UTC day (`YYYY-MM-DD`) for 1:1 sessions; `null` for group threads. */
  day: string | null;
  createdAt: number;
  messageCount: number;
}

/** One message in a session's transcript. */
export interface MessagingMessage {
  seq: number;
  sessionId: string;
  /** Sender identity - an E.164 number, or `"agent"`. */
  from: string;
  direction: MessageDirection;
  channel: Channel;
  body: string;
  ts: number;
}

/** A whitelisted contact allowed to reach the agent. */
export interface WhitelistEntry {
  contactE164: string;
  scope: string;
  createdAt: string;
}

/** `GET /messaging/access` - the access policy (flag + owner number + whitelist). */
export interface MessagingAccess {
  openToWorld: boolean;
  ownerNumber: string | null;
  whitelist: WhitelistEntry[];
}

const base = (agentId: string) =>
  `/agents/${encodeURIComponent(agentId)}/messaging`;

export function getMessagingStatus(agentId: string): Promise<MessagingStatus> {
  return get<MessagingStatus>(`${base(agentId)}/status`);
}

/** Enable messaging (provisions a number). May reject 409 if 10DLC isn't ready. */
export function enableMessaging(
  agentId: string,
  areaCode?: string,
): Promise<EnableResult> {
  return post<EnableResult>(
    `${base(agentId)}/enable`,
    areaCode ? { areaCode } : {},
  );
}

export function disableMessaging(agentId: string): Promise<{ ok?: boolean }> {
  return post<{ ok?: boolean }>(`${base(agentId)}/disable`, {});
}

export function listMessagingSessions(
  agentId: string,
): Promise<MessagingSession[]> {
  return get<MessagingSession[]>(`${base(agentId)}/sessions`);
}

export function listSessionMessages(
  agentId: string,
  sessionId: string,
): Promise<MessagingMessage[]> {
  return get<MessagingMessage[]>(
    `${base(agentId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
}

export function getMessagingAccess(agentId: string): Promise<MessagingAccess> {
  return get<MessagingAccess>(`${base(agentId)}/access`);
}

/** Patch the access policy. Returns the persisted flag + owner number. */
export function updateMessagingAccess(
  agentId: string,
  patch: { openToWorld?: boolean; ownerNumber?: string | null },
): Promise<{ openToWorld: boolean; ownerNumber: string | null }> {
  return put(`${base(agentId)}/access`, patch);
}

export function addWhitelistContact(
  agentId: string,
  contactE164: string,
): Promise<{ ok: boolean; contactE164: string }> {
  return post(`${base(agentId)}/whitelist`, { contactE164 });
}

export function removeWhitelistContact(
  agentId: string,
  contactE164: string,
): Promise<{ ok: boolean }> {
  return del(`${base(agentId)}/whitelist/${encodeURIComponent(contactE164)}`);
}
