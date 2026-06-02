import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AGENT_TEMPLATES,
  type Agent,
  type AgentTemplate,
  deleteAgent,
  type UpdateAgentBody,
  updateAgent,
} from "@/api/agents";
import { DocumentsManager } from "@/components/documents/DocumentsManager";
import {
  Banner,
  Button,
  FormField,
  Heading,
  Input,
  Modal,
  Panel,
  Select,
  Stack,
  Text,
  Textarea,
} from "@/components/ui";
import { useAgentDetail } from "@/pages/agents/AgentDetailPage";
import styles from "./SettingsTab.module.css";
import {
  CADENCE_OPTIONS,
  type Cadence,
  cadenceToCron,
  cronToCadence,
} from "./schedule";

const TEMPLATE_OPTIONS = [
  { label: "None", value: "" },
  ...AGENT_TEMPLATES.map((t) => ({
    label: t.charAt(0).toUpperCase() + t.slice(1),
    value: t,
  })),
];

const STATUS_OPTIONS = [
  { label: "Active", value: "active" },
  { label: "Paused", value: "paused" },
];

/** Editable form state, all strings so controlled inputs stay simple. */
interface FormState {
  name: string;
  description: string;
  template: string;
  system_prompt: string;
  cadence: Cadence;
  rawCron: string;
  status: string;
}

/** Derive the initial form state from a loaded agent. */
function toForm(agent: Agent): FormState {
  return {
    name: agent.name,
    description: agent.description ?? "",
    template: agent.template ?? "",
    system_prompt: agent.system_prompt ?? "",
    cadence: cronToCadence(agent.schedule_cron),
    rawCron:
      cronToCadence(agent.schedule_cron) === "custom"
        ? (agent.schedule_cron ?? "")
        : "",
    status: agent.status,
  };
}

/** Build a PATCH body containing only the fields that actually changed. */
function diffAgent(agent: Agent, form: FormState): UpdateAgentBody {
  const patch: UpdateAgentBody = {};

  if (form.name !== agent.name) patch.name = form.name.trim();

  const description = form.description.trim() === "" ? null : form.description;
  if (description !== (agent.description ?? null))
    patch.description = description;

  const template = (
    form.template === "" ? null : form.template
  ) as AgentTemplate | null;
  if (template !== (agent.template ?? null)) patch.template = template;

  const systemPrompt =
    form.system_prompt.trim() === "" ? null : form.system_prompt;
  if (systemPrompt !== (agent.system_prompt ?? null))
    patch.system_prompt = systemPrompt;

  const cron = cadenceToCron(form.cadence, form.rawCron);
  if (cron !== (agent.schedule_cron ?? null)) patch.schedule_cron = cron;

  if (form.status !== agent.status) patch.status = form.status;

  return patch;
}

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * SettingsTab (MNEMO-36) - edit an agent's name, description, template, system
 * prompt, schedule (friendly cadence presets + a raw-cron escape hatch), and
 * status. Prefilled from the loaded agent; "Save" PATCHes only the changed
 * fields (MNEMO-05) and reflects the updated agent back into the shell header.
 */
export function SettingsTab() {
  const { agent, onAgentUpdated } = useAgentDetail();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(() => toForm(agent));
  const [save, setSave] = useState<SaveState>("idle");
  const [nameError, setNameError] = useState<string | null>(null);

  // Type-the-name delete: an irreversible cascade across DO + R2 + D1 (the
  // backend DELETE /agents/:id route), gated behind a separate confirm modal.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const confirmMatches = confirmName === agent.name;

  function openDelete() {
    setConfirmName("");
    setDeleteError(false);
    setDeleteOpen(true);
  }

  function closeDelete() {
    if (deleting) return;
    setDeleteOpen(false);
  }

  async function handleDelete() {
    if (!confirmMatches) return;
    setDeleting(true);
    setDeleteError(false);
    try {
      await deleteAgent(agent.id);
      // The agent is gone - bail to the list before the page tries to refetch a 404.
      navigate("/agents");
    } catch {
      setDeleteError(true);
      setDeleting(false);
    }
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSave("idle");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (form.name.trim() === "") {
      setNameError("Name is required.");
      return;
    }
    setNameError(null);

    const patch = diffAgent(agent, form);
    if (Object.keys(patch).length === 0) {
      setSave("saved");
      return;
    }

    setSave("saving");
    try {
      const updated = await updateAgent(agent.id, patch);
      onAgentUpdated(updated);
      setForm(toForm(updated));
      setSave("saved");
    } catch {
      setSave("error");
    }
  }

  return (
    <Stack gap="5">
      <Panel padding="5" className={styles.panel}>
        <form onSubmit={handleSubmit}>
          <Stack gap="5">
            {save === "saved" && (
              <Banner variant="success" title="Saved">
                Your changes were saved.
              </Banner>
            )}
            {save === "error" && (
              <Banner variant="danger" title="Couldn't save">
                Something went wrong saving your changes. Please try again.
              </Banner>
            )}

            <FormField label="Name" required error={nameError ?? undefined}>
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                invalid={Boolean(nameError)}
              />
            </FormField>

            <FormField
              label="Description"
              help="A short summary of what this agent watches."
            >
              <Textarea
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                rows={2}
              />
            </FormField>

            <FormField label="Template">
              <Select
                value={form.template}
                options={TEMPLATE_OPTIONS}
                onChange={(e) => set("template", e.target.value)}
              />
            </FormField>

            <FormField
              label="System prompt"
              help="Extra instructions layered into every run."
            >
              <Textarea
                value={form.system_prompt}
                onChange={(e) => set("system_prompt", e.target.value)}
                rows={5}
              />
            </FormField>

            <FormField
              label="Schedule"
              help="How often this agent runs on its own."
            >
              <Select
                value={form.cadence}
                options={[...CADENCE_OPTIONS]}
                onChange={(e) => set("cadence", e.target.value as Cadence)}
              />
            </FormField>

            {form.cadence === "custom" && (
              <FormField
                label="Cron expression"
                help="Standard 5-field cron, e.g. “0 9 * * 1-5”."
              >
                <Input
                  value={form.rawCron}
                  onChange={(e) => set("rawCron", e.target.value)}
                  placeholder="0 9 * * *"
                />
              </FormField>
            )}

            <FormField label="Status">
              <Select
                value={form.status}
                options={STATUS_OPTIONS}
                onChange={(e) => set("status", e.target.value)}
              />
            </FormField>

            <div className={styles.actions}>
              <Button type="submit" loading={save === "saving"}>
                Save changes
              </Button>
            </div>
          </Stack>
        </form>
      </Panel>

      {/* Document removal (DOCS-02) lives in the Danger zone per the destructive-
          actions convention: type-the-filename confirm, optional neuron purge. */}
      <DocumentsManager agentId={agent.id} />

      <Panel padding="5" className={styles.panel}>
        <Stack gap="3">
          <Heading level={3}>Danger zone</Heading>
          <Text size="sm" color="text-muted">
            Deleting this agent permanently removes its brain, reports, and
            history. This can't be undone.
          </Text>
          <div className={styles.actions}>
            <Button variant="danger" onClick={openDelete}>
              Delete agent
            </Button>
          </div>
        </Stack>
      </Panel>

      <Modal
        open={deleteOpen}
        onClose={closeDelete}
        title="Delete this agent"
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeDelete}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              loading={deleting}
              disabled={!confirmMatches}
            >
              Delete agent
            </Button>
          </>
        }
      >
        <Stack gap="4">
          {deleteError && (
            <Banner variant="danger" title="Couldn't delete">
              Something went wrong. Please try again.
            </Banner>
          )}
          <Text size="sm">
            This will permanently delete the agent, its brain, reports, and
            history. This can't be undone.
          </Text>
          <FormField
            label={`Type "${agent.name}" to confirm`}
            help="Names must match exactly, including case and spacing."
          >
            <Input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && confirmMatches) handleDelete();
              }}
              placeholder={agent.name}
              autoFocus
            />
          </FormField>
        </Stack>
      </Modal>
    </Stack>
  );
}
