/**
 * CallbackPage (MNEMO-33) - the magic-link landing at `/auth/callback`.
 *
 * In the normal flow the Worker's `GET /auth/callback?token=` sets the cookie
 * and 302-redirects to `/`, so the SPA usually never renders this. It exists for
 * the defensive case where the SPA receives `?token=` or `?error=` directly:
 * show a centered spinner, re-probe the session (`refresh()`), then navigate to
 * `/agents` on success or show an "expired or invalid link" message on failure.
 * It is resilient to being hit with no params at all (just re-probe + redirect).
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "@/auth/useSession";
import { Banner, Button, Card, Spinner, Stack, Text } from "@/components/ui";
import styles from "./CallbackPage.module.css";

export function CallbackPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { status, refresh } = useSession();
  // A link the Worker rejected (`?error=`) is a terminal failure - don't probe.
  const linkError = params.get("error") != null;
  const [failed, setFailed] = useState(linkError);

  // Kick a fresh probe once (unless the link already carried an error). The
  // probe sets `status` to `loading` then resolves to authenticated/anonymous.
  useEffect(() => {
    if (linkError) return;
    void refresh();
  }, [linkError, refresh]);

  // React to the probe result: navigate on success, fail on anonymous, keep the
  // spinner while loading.
  useEffect(() => {
    if (failed) return;
    if (status === "authenticated") {
      navigate("/agents", { replace: true });
    } else if (status === "anonymous") {
      setFailed(true);
    }
  }, [status, failed, navigate]);

  return (
    <div className={styles.wrap}>
      <Card className={styles.card} padding="6">
        {failed ? (
          <Stack gap="4" align="center">
            <Banner variant="danger" title="That sign-in link didn't work">
              It may have expired or already been used. Request a fresh link to
              try again.
            </Banner>
            <Button onClick={() => navigate("/login", { replace: true })}>
              Back to sign in
            </Button>
          </Stack>
        ) : (
          <Stack gap="4" align="center">
            <Spinner size="lg" label="Signing you in" />
            <Text color="text-muted" as="p">
              Signing you in…
            </Text>
          </Stack>
        )}
      </Card>
    </div>
  );
}
