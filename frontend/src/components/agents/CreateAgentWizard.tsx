import { type FormEvent, useState } from "react";
import { type DiscoveryStart, startDiscovery } from "@/api/discovery";
import {
  Button,
  FormField,
  Heading,
  Inline,
  Input,
  Panel,
  Stack,
  Text,
  Textarea,
} from "@/components/ui";
import styles from "./CreateAgentWizard.module.css";
import { DiscoveryChat } from "./DiscoveryChat";

export interface CreateAgentWizardProps {
  /** Fired once Discovery is finalized and the agent is provisioned. */
  onCreated: (agentId: string) => void;
}

/**
 * CreateAgentWizard (MNEMO-34) - the two-step create flow that fronts Discovery:
 *
 *   Step 1 "Describe it"  - name + description; "Begin" calls `startDiscovery`.
 *   Step 2 "Discovery"    - the clarify-scope chat (delegated to `DiscoveryChat`).
 *
 * This file is the ORCHESTRATOR: it owns step state and the Discovery handle, and
 * keeps all chat transport in `DiscoveryChat`. It surfaces `onCreated(agentId)`
 * up to the page, which routes to the new agent's detail screen.
 */
export function CreateAgentWizard({ onCreated }: CreateAgentWizardProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [started, setStarted] = useState<DiscoveryStart | null>(null);

  async function onBegin(e: FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName) {
      setError("Give your agent a name.");
      return;
    }
    if (!trimmedDescription) {
      setError(
        "Add a short description so Discovery has something to work from.",
      );
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await startDiscovery({
        name: trimmedName,
        description: trimmedDescription,
      });
      setStarted(result);
    } catch {
      setError("Couldn't start Discovery. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (started) {
    return (
      <Stack gap="5">
        <Stack gap="1">
          <Text size="sm" color="text-muted" weight="medium">
            Step 2 of 2 · Discovery
          </Text>
          <Heading level={2}>Let's scope {name.trim()}</Heading>
          <Text color="text-muted" as="p">
            Answer a few questions so Mnemosyne understands exactly what to
            watch. When it's confident, you'll be able to create the agent.
          </Text>
        </Stack>
        <DiscoveryChat
          discoveryId={started.discoveryId}
          initialState={started.state}
          seedDescription={description.trim()}
          onCreated={onCreated}
        />
      </Stack>
    );
  }

  return (
    <Panel padding="6" className={styles.panel}>
      <form onSubmit={onBegin} noValidate>
        <Stack gap="5">
          <Stack gap="1">
            <Text size="sm" color="text-muted" weight="medium">
              Step 1 of 2 · Describe it
            </Text>
            <Heading level={2} variant="display">
              Create an agent
            </Heading>
            <Text color="text-muted" as="p">
              Name your agent and describe what it should track. Mnemosyne will
              ask a few follow-up questions to scope it before it goes to work.
            </Text>
          </Stack>

          <FormField
            label="Name"
            help="A short, recognizable name (e.g. “Acme competitor watch”)."
          >
            <Input
              name="name"
              placeholder="Acme competitor watch"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </FormField>

          <FormField
            label="Description"
            help="What should this agent research, and why does it matter to you?"
            error={error ?? undefined}
          >
            <Textarea
              name="description"
              rows={5}
              placeholder="Track Acme Corp's product launches, pricing changes, and major hires…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>

          <Inline justify="end">
            <Button type="submit" loading={submitting}>
              Begin
            </Button>
          </Inline>
        </Stack>
      </form>
    </Panel>
  );
}
