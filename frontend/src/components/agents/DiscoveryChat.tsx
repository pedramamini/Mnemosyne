import { Check, Circle, FileText, Send } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  type DiscoveryRubric,
  type DiscoveryState,
  type DiscoveryTurn,
  finalizeDiscovery,
  sendDiscoveryMessage,
} from "@/api/discovery";
import { DocumentUploader } from "@/components/documents/DocumentUploader";
import { useAgentDocuments } from "@/components/documents/useAgentDocuments";
import {
  Badge,
  Banner,
  Button,
  Heading,
  Icon,
  Inline,
  Panel,
  ProgressBar,
  Spinner,
  Stack,
  Text,
  Textarea,
} from "@/components/ui";
import { cx } from "@/components/ui/utils";
import styles from "./DiscoveryChat.module.css";

export interface DiscoveryChatProps {
  /** The Discovery handle (the new agent's id) from `startDiscovery`. */
  discoveryId: string;
  /** The initial Discovery state returned by `startDiscovery`. */
  initialState: DiscoveryState;
  /**
   * Optional opening description. When provided and the transcript is empty, it
   * is auto-sent once on mount as the user's first turn to draw out Mnemosyne's
   * first follow-up question (the backend speaks only in response to a turn).
   */
  seedDescription?: string;
  /** Fired with the provisioned agent id once Discovery is finalized. */
  onCreated: (agentId: string) => void;
}

/** A transcript turn with a stable React key for append-only reconciliation. */
type KeyedTurn = DiscoveryTurn & { key: string };

/** The five rubric facets, in display order - keys mirror the MNEMO-29 spec. */
const RUBRIC_FACETS: { key: keyof DiscoveryRubric; label: string }[] = [
  { key: "subject", label: "Subject" },
  { key: "entityType", label: "Entity type" },
  { key: "sources", label: "Sources" },
  { key: "cadence", label: "Cadence" },
  { key: "outputFormat", label: "Output format" },
];

/**
 * DiscoveryChat (MNEMO-34) - the clarify-scope conversation. Renders the
 * transcript, a composer that calls `sendDiscoveryMessage` (optimistically
 * appending the user's turn, then merging the assistant reply + refreshed gate),
 * and a rubric/confidence panel that makes the soft "good-enough" gate (§5)
 * legible. When the gate clears (`ready`), a prominent "Create this agent" button
 * calls `finalizeDiscovery` and fires `onCreated`.
 */
export function DiscoveryChat({
  discoveryId,
  initialState,
  seedDescription,
  onCreated,
}: DiscoveryChatProps) {
  // Stable, monotonic keys per turn - the transcript is append-only and turns
  // can repeat verbatim, so a content/index key isn't safe for reconciliation.
  const seqRef = useRef(0);
  const withKey = (turn: DiscoveryTurn): KeyedTurn => {
    seqRef.current += 1;
    return { ...turn, key: `turn-${seqRef.current}` };
  };

  const [messages, setMessages] = useState<KeyedTurn[]>(() =>
    initialState.messages.map(withKey),
  );
  const [rubric, setRubric] = useState<DiscoveryRubric>(initialState.rubric);
  const [confidence, setConfidence] = useState(initialState.confidence);
  const [ready, setReady] = useState(initialState.ready);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const kickedOff = useRef(false);

  // Documents attached during creation (DOCS-02): they seed the brain at Build and
  // their summaries feed the Discovery interview. We track the count here for the
  // gate indicator and refresh it whenever the uploader reports a completed ingest.
  const { documents: attachedDocs, refresh: refreshDocs } =
    useAgentDocuments(discoveryId);
  const attachedCount = attachedDocs.length;

  // Auto-scroll the transcript to the newest turn / typing indicator. The deps
  // are intentional re-run triggers (the body reads only the ref), so the
  // "more deps than necessary" lint is suppressed deliberately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps trigger the scroll
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  /** Send one answer: optimistic user turn → server → merge reply + gate. */
  async function send(content: string) {
    const trimmed = content.trim();
    if (!trimmed || pending) return;
    const userTurn = withKey({ role: "user", content: trimmed });
    setMessages((prev) => [...prev, userTurn]);
    setDraft("");
    setPending(true);
    setError(null);
    try {
      const next = await sendDiscoveryMessage(discoveryId, trimmed);
      const replyTurns = next.messages.map(withKey);
      setMessages((prev) => [...prev, ...replyTurns]);
      setRubric(next.rubric);
      setConfidence(next.confidence);
      setReady(next.ready);
    } catch {
      setError("That answer didn't go through. Please try again.");
    } finally {
      setPending(false);
    }
  }

  // Auto-kick the first turn from the seed description (once, if given). Runs on
  // mount only - re-running on every dep change would re-send the description.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional once-on-mount kickoff
  useEffect(() => {
    if (kickedOff.current) return;
    if (seedDescription && messages.length === 0) {
      kickedOff.current = true;
      void send(seedDescription);
    }
  }, []);

  async function onFinalize() {
    if (finalizing) return;
    setFinalizing(true);
    setError(null);
    try {
      const result = await finalizeDiscovery(discoveryId);
      onCreated(result.agentId);
    } catch {
      setError("Couldn't create the agent. Please try again.");
      setFinalizing(false);
    }
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline (standard chat affordance).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  }

  const satisfiedCount = RUBRIC_FACETS.filter((f) => rubric[f.key]).length;
  const showMeter = ready || confidence > 0;
  const pct = Math.round(confidence * 100);
  // Never render a blank bubble: a finalize turn often carries no prose, and the
  // adapter strips any machine-readable envelope (which can leave empty text).
  const visibleMessages = messages.filter((m) => m.content.trim().length > 0);

  return (
    <Stack gap="5">
      <div className={styles.layout}>
        {/* ── Conversation column ─────────────────────────────────────────── */}
        <Stack gap="4" className={styles.conversation}>
          <div
            ref={transcriptRef}
            className={styles.transcript}
            role="log"
            aria-label="Discovery conversation"
          >
            {visibleMessages.length === 0 && !pending ? (
              <Text color="text-muted" as="p" className={styles.intro}>
                Tell Mnemosyne more about what this agent should track. It'll
                ask a few questions, then you can create the agent once it
                understands enough.
              </Text>
            ) : (
              <Stack gap="3">
                {visibleMessages.map((m) => (
                  <div
                    key={m.key}
                    className={cx(
                      styles.bubble,
                      m.role === "user" ? styles.user : styles.assistant,
                    )}
                  >
                    <Text size="sm" as="p" className={styles.bubbleText}>
                      {m.content}
                    </Text>
                  </div>
                ))}
                {pending && (
                  <div className={cx(styles.bubble, styles.assistant)}>
                    <Inline gap="2">
                      <Spinner size="sm" label="Mnemosyne is thinking" />
                      <Text size="sm" color="text-muted">
                        Thinking…
                      </Text>
                    </Inline>
                  </div>
                )}
              </Stack>
            )}
          </div>

          {error && (
            <Banner variant="danger" title="Something went wrong">
              {error}
            </Banner>
          )}

          <Stack gap="2">
            <Textarea
              aria-label="Your answer"
              rows={3}
              placeholder="Type your answer…"
              value={draft}
              disabled={pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            <Inline justify="end">
              <Button
                onClick={() => void send(draft)}
                loading={pending}
                disabled={draft.trim().length === 0}
                rightIcon={<Icon icon={Send} size="sm" />}
              >
                Send
              </Button>
            </Inline>
          </Stack>
        </Stack>

        {/* ── Rubric / confidence panel ───────────────────────────────────── */}
        <Panel padding="5" className={styles.rubric}>
          <Stack gap="4">
            <Stack gap="1">
              <Heading level={4}>Scope</Heading>
              <Text size="sm" color="text-muted" as="p">
                Mnemosyne lights these up as it gets confident it understands
                each piece of what you want.
              </Text>
            </Stack>

            <Stack gap="2">
              {RUBRIC_FACETS.map((facet) => {
                const done = rubric[facet.key];
                return (
                  <Inline key={facet.key} gap="2" align="center" wrap={false}>
                    <Badge
                      variant={done ? "success" : "neutral"}
                      appearance={done ? "solid" : "subtle"}
                    >
                      <Icon icon={done ? Check : Circle} size="sm" />
                    </Badge>
                    <Text
                      size="sm"
                      color={done ? "text" : "text-muted"}
                      weight={done ? "medium" : "regular"}
                    >
                      {facet.label}
                    </Text>
                  </Inline>
                );
              })}
            </Stack>

            <Stack gap="2">
              <Inline justify="between" align="baseline">
                <Text size="sm" weight="medium">
                  Confidence
                </Text>
                {showMeter && (
                  <Text size="sm" color="text-muted">
                    {pct}%
                  </Text>
                )}
              </Inline>
              <ProgressBar
                label="Discovery confidence"
                variant={ready ? "success" : "primary"}
                value={showMeter ? pct : undefined}
              />
              <Text size="xs" color="text-muted" as="p">
                {satisfiedCount} of {RUBRIC_FACETS.length} facets understood
              </Text>
            </Stack>

            {attachedCount > 0 && (
              <Inline gap="2" align="center">
                <Badge variant="primary" appearance="subtle">
                  <Icon icon={FileText} size="sm" />
                </Badge>
                <Text size="sm" color="text-muted">
                  {attachedCount} document{attachedCount === 1 ? "" : "s"}{" "}
                  attached
                </Text>
              </Inline>
            )}

            {ready && (
              <Button fullWidth onClick={onFinalize} loading={finalizing}>
                Create this agent
              </Button>
            )}
          </Stack>
        </Panel>
      </div>

      {/* ── Attach documents (DOCS-02) ───────────────────────────────────── */}
      <Panel padding="5">
        <DocumentUploader
          agentId={discoveryId}
          variant="discovery"
          onIngested={() => refreshDocs()}
        />
      </Panel>
    </Stack>
  );
}
