/**
 * LoginPage (MNEMO-33) - the passwordless magic-link request screen.
 *
 * A centered card with an email field + "Send magic link". On submit it calls
 * `requestMagicLink(email)` then swaps to a NEUTRAL "check your email"
 * confirmation (with a "use a different email" reset) - it never reveals whether
 * the email is registered, mirroring the backend's anti-enumeration 200. Email
 * format is validated client-side; the button shows its loading state and is
 * disabled while the request is in flight.
 */
import { type FormEvent, useState } from "react";
import { requestMagicLink } from "@/api/auth";
import {
  Button,
  Card,
  FormField,
  Heading,
  Input,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./LoginPage.module.css";

/** Pragmatic email shape check - the real validation is the backend's `z.email()`. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  // Staging-only: the backend returns the magic link directly when Resend isn't
  // configured (non-production), so we can click through without email. Always
  // undefined in production - see `requestMagicLink` / `src/auth/routes.ts`.
  const [devMagicLink, setDevMagicLink] = useState<string | undefined>(
    undefined,
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your email address.");
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await requestMagicLink(trimmed);
      setDevMagicLink(result?.devMagicLink);
      setSent(true);
    } catch {
      // The backend always 200s on a valid email (anti-enumeration), so a thrown
      // error here is a transport/5xx failure - show a neutral retry message
      // that still doesn't reveal whether the address exists.
      setError("Something went wrong sending your link. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setSent(false);
    setError(null);
    setDevMagicLink(undefined);
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.column}>
        <Card className={styles.card} padding="6">
          {sent ? (
            <Stack gap="4">
              <Heading level={2} variant="display">
                Check your email
              </Heading>
              <Stack gap="2">
                <Text color="text-muted" as="p">
                  We sent a sign-in link to
                </Text>
                <Text weight="medium" as="p">
                  {email.trim()}
                </Text>
                <Text color="text-muted" as="p">
                  Open it on this device to finish signing in.
                </Text>
              </Stack>
              {devMagicLink && (
                <Button
                  fullWidth
                  onClick={() => window.location.assign(devMagicLink)}
                >
                  Sign in now
                </Button>
              )}
              <Button variant="ghost" onClick={reset}>
                Use a different email
              </Button>
            </Stack>
          ) : (
            <form onSubmit={onSubmit} noValidate>
              <Stack gap="5">
                <Stack gap="1">
                  <Heading level={2} variant="display">
                    Sign in to Mnemosyne
                  </Heading>
                  <Text color="text-muted" as="p">
                    Enter your email and we'll send you a magic sign-in link.
                  </Text>
                </Stack>
                <FormField label="Email" error={error ?? undefined}>
                  <Input
                    type="email"
                    name="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                  />
                </FormField>
                <Button type="submit" fullWidth loading={submitting}>
                  Send magic link
                </Button>
              </Stack>
            </form>
          )}
        </Card>

        {sent && devMagicLink && (
          <Text
            as="p"
            size="xs"
            color="text-muted"
            className={styles.stagingNote}
          >
            Staging only - email delivery isn't configured
          </Text>
        )}
      </div>
    </div>
  );
}
