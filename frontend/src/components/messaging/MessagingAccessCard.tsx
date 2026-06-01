import { ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  addWhitelistContact,
  type MessagingAccess,
  removeWhitelistContact,
  updateMessagingAccess,
} from "@/api/messaging";
import {
  Badge,
  Banner,
  Button,
  Code,
  FormField,
  Icon,
  IconButton,
  Inline,
  Input,
  Panel,
  Spinner,
  Stack,
  Switch,
  Text,
} from "@/components/ui";

export interface MessagingAccessCardProps {
  agentId: string;
  access: MessagingAccess | null;
  loading: boolean;
  error: Error | null;
  /** Re-fetch access after a mutation. */
  onChanged: () => void;
}

/**
 * MessagingAccessCard - the access policy editor (PRD §9.6). Toggles the
 * open-to-the-world flag (whitelist-by-default), sets the owner's verified
 * number, and manages the contact whitelist. Each mutation persists immediately
 * and re-fetches via `onChanged`.
 */
export function MessagingAccessCard({
  agentId,
  access,
  loading,
  error,
  onChanged,
}: MessagingAccessCardProps) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ownerDraft, setOwnerDraft] = useState("");
  const [newContact, setNewContact] = useState("");

  // Keep the owner-number field in step with the loaded value.
  useEffect(() => {
    setOwnerDraft(access?.ownerNumber ?? "");
  }, [access?.ownerNumber]);

  async function run(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      onChanged();
    } catch {
      setActionError(failure);
    } finally {
      setBusy(false);
    }
  }

  const ownerChanged = (access?.ownerNumber ?? "") !== ownerDraft.trim();

  return (
    <Panel padding="4">
      <Stack gap="4">
        <Inline gap="2" align="center">
          <Icon icon={ShieldCheck} size="sm" />
          <Text weight="semibold">Access &amp; safety</Text>
        </Inline>

        {error && (
          <Banner variant="danger" title="Couldn't load access settings">
            Please try again.
          </Banner>
        )}
        {actionError && <Banner variant="danger">{actionError}</Banner>}

        {loading || !access ? (
          <Spinner size="sm" label="Loading access settings" />
        ) : (
          <Stack gap="4">
            <Stack gap="1">
              <Switch
                label="Open to the world"
                checked={access.openToWorld}
                disabled={busy}
                onChange={(e) =>
                  run(
                    () =>
                      updateMessagingAccess(agentId, {
                        openToWorld: e.target.checked,
                      }),
                    "Couldn't update the open-to-world setting.",
                  )
                }
              />
              <Text size="sm" color="text-muted">
                {access.openToWorld
                  ? "Anyone can text this agent. It runs in a safe persona with no private memory or sensitive tools."
                  : "Only whitelisted contacts (and you) can text this agent."}
              </Text>
            </Stack>

            <FormField
              label="Your verified number"
              help="A 1:1 sender matching this number is treated as the owner."
            >
              <Inline gap="2" align="center" wrap={false}>
                <Input
                  value={ownerDraft}
                  placeholder="+14155551212"
                  onChange={(e) => setOwnerDraft(e.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  disabled={!ownerChanged}
                  onClick={() =>
                    run(
                      () =>
                        updateMessagingAccess(agentId, {
                          ownerNumber: ownerDraft.trim() || null,
                        }),
                      "Couldn't save the owner number (use E.164, e.g. +14155551212).",
                    )
                  }
                >
                  Save
                </Button>
              </Inline>
            </FormField>

            <Stack gap="2">
              <Text size="sm" weight="medium">
                Whitelist{" "}
                <Badge variant="neutral" appearance="subtle" size="sm">
                  {access.whitelist.length}
                </Badge>
              </Text>
              {access.whitelist.length === 0 ? (
                <Text size="sm" color="text-muted">
                  No whitelisted contacts yet.
                </Text>
              ) : (
                <Stack gap="1">
                  {access.whitelist.map((entry) => (
                    <Inline
                      key={entry.contactE164}
                      gap="2"
                      align="center"
                      justify="between"
                      wrap={false}
                    >
                      <Code>{entry.contactE164}</Code>
                      <IconButton
                        label={`Remove ${entry.contactE164}`}
                        icon={<Icon icon={Trash2} size="sm" />}
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () =>
                              removeWhitelistContact(
                                agentId,
                                entry.contactE164,
                              ),
                            "Couldn't remove that contact.",
                          )
                        }
                      />
                    </Inline>
                  ))}
                </Stack>
              )}

              <Inline gap="2" align="center" wrap={false}>
                <Input
                  aria-label="Add a contact number"
                  placeholder="+14155551212"
                  value={newContact}
                  onChange={(e) => setNewContact(e.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  disabled={newContact.trim() === ""}
                  onClick={() =>
                    run(async () => {
                      await addWhitelistContact(agentId, newContact.trim());
                      setNewContact("");
                    }, "Couldn't add that contact (use E.164, e.g. +14155551212).")
                  }
                >
                  Add
                </Button>
              </Inline>
            </Stack>
          </Stack>
        )}
      </Stack>
    </Panel>
  );
}
