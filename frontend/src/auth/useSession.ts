/**
 * Session context + `useSession` hook (MNEMO-33). The context object and the
 * hook live here (separate from the `SessionProvider` component file) so both
 * the provider and any consumer import the same context without a circular
 * import, and so this module stays free of JSX/component exports.
 */
import { createContext, useContext } from "react";
import type { Account } from "@/api/auth";

/** Auth state machine: probing on mount, then resolved to one of two terminals. */
export type SessionStatus = "loading" | "authenticated" | "anonymous";

export interface SessionContextValue {
  /** `loading` until the first `/api/me` probe resolves. */
  status: SessionStatus;
  /** The signed-in account, or `null` when loading/anonymous. */
  account: Account | null;
  /** Re-probe `/api/me` (used by the callback page after the cookie is set). */
  refresh: () => Promise<void>;
  /** Log out server-side, then flip to `anonymous`. */
  signOut: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Read the session state. Throws if used outside a `<SessionProvider>` - a
 * programmer error, not a runtime condition.
 */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within a <SessionProvider>");
  }
  return ctx;
}
