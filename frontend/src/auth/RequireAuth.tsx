/**
 * RequireAuth (MNEMO-33) - the protected-route gate. Reads `useSession()` and:
 *   - `loading`       → a full-screen `Spinner` (the probe is in flight),
 *   - `anonymous`     → `<Navigate to="/login" replace>`, preserving the
 *                       attempted location in router state so a post-login flow
 *                       can return to it,
 *   - `authenticated` → renders `children` (or `<Outlet/>` for a layout route).
 *
 * The complementary mid-session-expiry handling lives in `SessionProvider`
 * (subscribed to `onUnauthorized` in `client.ts`): any authenticated call that
 * 401s flips the session to `anonymous`, and this gate then bounces to /login.
 */
import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useSession } from "@/auth/useSession";
import { Spinner } from "@/components/ui";
import styles from "./RequireAuth.module.css";

export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status } = useSession();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className={styles.center}>
        <Spinner size="lg" label="Loading" />
      </div>
    );
  }

  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children ?? <Outlet />}</>;
}
