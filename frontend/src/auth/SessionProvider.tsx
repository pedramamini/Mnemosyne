/**
 * SessionProvider (MNEMO-33) - app-wide auth state derived from an authenticated
 * probe (`GET /api/me`), since the SPA can't read the HttpOnly session cookie.
 *
 * On mount it probes once: a success → `authenticated` (with the account), an
 * `isUnauthorized` (401) → `anonymous`. `refresh()` re-runs the probe (the
 * callback page calls it after the Worker sets the cookie). `signOut()` calls
 * `logout()` then flips to `anonymous`. It also subscribes to the global 401
 * notification (`onUnauthorized`) so an expired session surfaced by ANY
 * authenticated call flips the app to `anonymous` for a clean bounce to /login.
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type Account, getMe, logout } from "@/api/auth";
import { isUnauthorized, onUnauthorized } from "@/api/client";
import {
  SessionContext,
  type SessionContextValue,
  type SessionStatus,
} from "./useSession";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [account, setAccount] = useState<Account | null>(null);

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      const me = await getMe();
      setAccount(me);
      setStatus("authenticated");
    } catch (err) {
      setAccount(null);
      setStatus("anonymous");
      // A 401 is the expected "not signed in" signal. A non-401 (network/5xx)
      // isn't proof of being signed out, but we still surface anonymous so the
      // UI stays usable rather than stuck loading; log it for visibility.
      if (!isUnauthorized(err)) {
        console.warn("session probe failed (non-401)", err);
      }
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } finally {
      setAccount(null);
      setStatus("anonymous");
    }
  }, []);

  // Probe once on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A 401 from any authenticated call (mid-session expiry) → anonymous.
  useEffect(
    () =>
      onUnauthorized(() => {
        setAccount(null);
        setStatus("anonymous");
      }),
    [],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ status, account, refresh, signOut }),
    [status, account, refresh, signOut],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
