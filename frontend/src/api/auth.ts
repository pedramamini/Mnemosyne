/**
 * Auth API (MNEMO-33) - typed client functions over the MNEMO-32 `apiFetch`
 * transport. Pure functions, no React. The session is an HttpOnly cookie the
 * Worker owns, so these calls just ride `credentials: "include"` (set in
 * `client.ts`); the SPA never sees or sends the token itself.
 *
 *   requestMagicLink(email) → POST /auth/request  (always 200; anti-enumeration)
 *   getMe()                 → GET  /api/me         (account, or throws ApiError 401)
 *   logout()                → POST /auth/logout    (clears the session cookie)
 */
import { get, post, put } from "./client";

/**
 * The account owner's profile - account-level context every agent reads: their
 * IANA `timezone` (so dates render in their local time; null ⇒ UTC), how to
 * address them (`name`), and freeform `notes` (how they like to work, goals).
 */
export interface OwnerProfile {
  timezone: string | null;
  name: string | null;
  notes: string | null;
}

/** The authenticated account, as returned by `GET /api/me`. */
export interface Account {
  id: string;
  email: string;
  profile: OwnerProfile;
}

/** Neutral 200 body of `POST /auth/request`. `devMagicLink` is present ONLY on
 * non-production backends (staging convenience - see `src/auth/routes.ts`). */
interface MagicLinkResponse {
  ok: boolean;
  devMagicLink?: string;
}

/**
 * Request a magic-link sign-in email. Resolves on the backend's neutral 200
 * regardless of whether the email is registered - the UI must NOT branch on
 * existence (anti-enumeration, mirrors the backend's `POST /auth/request`).
 *
 * Returns the staging-only `devMagicLink` when the backend includes it (it never
 * does in production), so the login screen can offer a click-through without email.
 */
export async function requestMagicLink(
  email: string,
): Promise<{ devMagicLink?: string }> {
  const res = await post<MagicLinkResponse>("/auth/request", { email });
  return { devMagicLink: res?.devMagicLink };
}

/**
 * Probe the current session. Resolves with the account on 200; lets an
 * `ApiError` propagate on failure so callers treat a 401 as "not signed in"
 * via `isUnauthorized` (see `client.ts`).
 */
export function getMe(): Promise<Account> {
  return get<Account>("/api/me");
}

/** End the session server-side (the Worker clears the HttpOnly cookie). */
export async function logout(): Promise<void> {
  await post("/auth/logout");
}

/**
 * Update the owner profile (timezone / name / notes). Send only the fields you
 * want to change; `null` clears one. Resolves with the saved profile (the
 * backend echoes it back), so callers can update local state without a re-probe.
 */
export async function updateProfile(
  patch: Partial<OwnerProfile>,
): Promise<OwnerProfile> {
  const res = await put<{ profile: OwnerProfile }>("/api/me/profile", patch);
  return res.profile;
}
