import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type BrainStats, getBrainStats } from "@/api/agents";
import {
  Badge,
  Code,
  Icon,
  IconButton,
  Inline,
  Panel,
  Stack,
  Text,
} from "@/components/ui";
import { useAgentDetail } from "@/pages/agents/AgentDetailPage";
import styles from "./MetadataTab.module.css";
import { cronToHuman } from "./schedule";

/** Format an ISO timestamp for display; falls back to the raw value if unparseable. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** One label/value row in the facts panel. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <Text
        size="sm"
        color="text-muted"
        weight="medium"
        className={styles.label}
      >
        {label}
      </Text>
      <div className={styles.value}>{children}</div>
    </div>
  );
}

/** A copy-to-clipboard affordance with brief "copied" feedback. */
function CopyId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) - leave the value visible.
    }
  }

  return (
    <Inline gap="2" align="center">
      <Code>{value}</Code>
      <IconButton
        size="sm"
        label={copied ? "Copied" : "Copy agent ID"}
        icon={<Icon icon={copied ? Check : Copy} size="sm" />}
        onClick={copy}
      />
    </Inline>
  );
}

/**
 * MetadataTab (MNEMO-36) - a read-only facts panel: agent id (copyable),
 * creation date, template, status, the resolved schedule (human-readable), and
 * the "Brain size" metric (neurons + synapses, §6.6) from `getBrainStats`.
 * The brain metric degrades to "-" when the endpoint isn't available yet.
 */
export function MetadataTab() {
  const { agent } = useAgentDetail();
  const [brain, setBrain] = useState<BrainStats | null>(null);
  const [brainFailed, setBrainFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBrain(null);
    setBrainFailed(false);
    getBrainStats(agent.id)
      .then((stats) => {
        if (!cancelled) setBrain(stats);
      })
      .catch(() => {
        if (!cancelled) setBrainFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const brainValue =
    brain !== null ? (
      <Inline gap="3" align="center">
        <Text>
          <strong>{brain.neurons.toLocaleString()}</strong> neurons
        </Text>
        <Text color="text-muted">·</Text>
        <Text>
          <strong>{brain.synapses.toLocaleString()}</strong> synapses
        </Text>
      </Inline>
    ) : brainFailed ? (
      <Text color="text-muted">-</Text>
    ) : (
      <Text color="text-muted">Loading…</Text>
    );

  return (
    <Panel padding="5" className={styles.panel}>
      <Stack gap="4">
        <Fact label="Agent ID">
          <CopyId value={agent.id} />
        </Fact>
        <Fact label="Created">{formatDate(agent.created_at)}</Fact>
        <Fact label="Template">
          {agent.template ? (
            <Badge variant="primary" appearance="subtle">
              {agent.template}
            </Badge>
          ) : (
            <Text color="text-muted">-</Text>
          )}
        </Fact>
        <Fact label="Status">
          <Badge>{agent.status}</Badge>
        </Fact>
        <Fact label="Schedule">{cronToHuman(agent.schedule_cron)}</Fact>
        <Fact label="Brain size">{brainValue}</Fact>
      </Stack>
    </Panel>
  );
}
