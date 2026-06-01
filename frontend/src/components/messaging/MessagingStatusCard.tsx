import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { ApiError } from "@/api/client";
import {
  disableMessaging,
  enableMessaging,
  type MessagingStatus,
} from "@/api/messaging";
import {
  Badge,
  Banner,
  Button,
  Code,
  Icon,
  Inline,
  Input,
  Panel,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";

export interface MessagingStatusCardProps {
  agentId: string;
  status: MessagingStatus | null;
  loading: boolean;
  error: Error | null;
  /** Re-fetch status after an enable/disable. */
  onChanged: () => void;
}

/**
 * MessagingStatusCard - the per-agent SMS on/off control (PRD §9.1). Shows the
 * provisioned number when enabled (with a Disable action), or an enable affordance
 * (optional area code) when off. Surfaces the 10DLC-not-ready case (HTTP 409) as a
 * banner rather than a generic failure.
 */
export function MessagingStatusCard({
  agentId,
  status,
  loading,
  error,
  onChanged,
}: MessagingStatusCardProps) {
  const [busy, setBusy] = useState(false);
  const [areaCode, setAreaCode] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  async function onEnable() {
    setBusy(true);
    setActionError(null);
    try {
      await enableMessaging(agentId, areaCode.trim() || undefined);
      setAreaCode("");
      onChanged();
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status === 409
          ? "10DLC onboarding isn't complete yet, so a number can't be provisioned. An operator needs to finish brand/campaign registration first."
          : "Couldn't enable messaging. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    setBusy(true);
    setActionError(null);
    try {
      await disableMessaging(agentId);
      onChanged();
    } catch {
      setActionError("Couldn't disable messaging. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel padding="4">
      <Stack gap="3">
        <Inline gap="2" align="center">
          <Icon icon={MessageSquare} size="sm" />
          <Text weight="semibold">Text messaging</Text>
          {status &&
            (status.enabled ? (
              <Badge variant="success">On</Badge>
            ) : (
              <Badge variant="neutral" appearance="subtle">
                Off
              </Badge>
            ))}
        </Inline>

        {error && (
          <Banner variant="danger" title="Couldn't load messaging status">
            Please try again.
          </Banner>
        )}
        {actionError && <Banner variant="danger">{actionError}</Banner>}

        {loading ? (
          <Spinner size="sm" label="Loading messaging status" />
        ) : status?.enabled ? (
          <Stack gap="3">
            <Text size="sm" color="text-muted">
              This agent receives and replies to texts at its own number.
            </Text>
            <Inline gap="2" align="center">
              <Text size="sm" color="text-muted">
                Number
              </Text>
              <Code>{status.e164 ?? "-"}</Code>
            </Inline>
            <div>
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                onClick={onDisable}
              >
                Disable messaging
              </Button>
            </div>
          </Stack>
        ) : (
          <Stack gap="3">
            <Text size="sm" color="text-muted">
              Give this agent a phone number so people can text it. Optionally
              pick a US area code.
            </Text>
            <Inline gap="2" align="end" wrap>
              <Input
                aria-label="Area code (optional)"
                placeholder="Area code (optional)"
                inputMode="numeric"
                maxLength={3}
                value={areaCode}
                onChange={(e) =>
                  setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))
                }
                fullWidth={false}
              />
              <Button loading={busy} onClick={onEnable}>
                Enable messaging
              </Button>
            </Inline>
          </Stack>
        )}
      </Stack>
    </Panel>
  );
}
