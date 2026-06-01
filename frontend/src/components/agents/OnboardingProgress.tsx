import { AlertTriangle, CheckCircle2, Circle, Compass } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  completedPhaseCount,
  type DeepDivePhaseRecord,
  type DeepDiveStatus,
  fetchDeepDiveStatus,
} from "@/api/onboarding";
import { GlassCockpit } from "@/components/audit/GlassCockpit";
import {
  Badge,
  Banner,
  Heading,
  Icon,
  Inline,
  Panel,
  ProgressBar,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./OnboardingProgress.module.css";

/** How often to poll deep-dive progress while it's still running (ms). */
const POLL_INTERVAL_MS = 4000;

export interface OnboardingProgressProps {
  agentId: string;
  /** Fired once when the dive transitions out of `running` (complete or failed). */
  onSettled?: () => void;
}

/**
 * OnboardingProgress - the "we're setting up your agent" panel shown while a
 * freshly-built agent runs its multi-phase initial deep dive. It renders a
 * determinate phase progress bar (phase N of M - honest, because the phase spine
 * is fixed) with the active phase pulsing, the phase checklist, and the live
 * activity stream beneath (so the work is visibly happening, not frozen).
 *
 * Self-managing: it polls `GET /deepdive` while the dive is `running` and stops
 * once it settles. Renders nothing when there's no dive to show (an agent that
 * never started one, or one that finished long ago) so it's safe to always mount.
 */
export function OnboardingProgress({
  agentId,
  onSettled,
}: OnboardingProgressProps) {
  const [status, setStatus] = useState<DeepDiveStatus | null>(null);
  const settledFired = useRef(false);

  const load = useCallback(async () => {
    try {
      return await fetchDeepDiveStatus(agentId);
    } catch {
      return null;
    }
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const next = await load();
      if (cancelled) return;
      if (next) setStatus(next);
      // Keep polling only while the dive is actively running.
      if (next?.phase === "running") {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      } else if (
        next &&
        !settledFired.current &&
        next.phase !== "not_started"
      ) {
        settledFired.current = true;
        onSettled?.();
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, onSettled]);

  // Nothing to show: never started, or a finished dive we no longer surface.
  if (
    !status ||
    status.phase === "not_started" ||
    status.phase === "complete"
  ) {
    return null;
  }

  const total = status.phases.length;
  const done = completedPhaseCount(status);
  const active = status.phases.find((p) => p.status === "running") ?? null;
  const failed = status.phase === "failed";

  return (
    <Stack gap="4">
      <Panel padding="5">
        <Stack gap="4">
          <Inline gap="3" align="center">
            <span className={styles.badge} aria-hidden="true">
              <Icon icon={Compass} size="md" />
            </span>
            <Stack gap="1">
              <Heading level={3}>
                {failed
                  ? "Initial deep dive paused"
                  : "Getting your agent up to speed"}
              </Heading>
              <Text size="sm" color="text-muted">
                {failed
                  ? "Your agent hit a snag partway through its first research pass."
                  : `Your agent is doing its initial deep research - phase ${Math.min(done + 1, total)} of ${total}. This takes a while; you can leave and come back.`}
              </Text>
            </Stack>
          </Inline>

          <Stack gap="2">
            <ProgressBar
              value={done}
              max={total}
              variant={failed ? "warning" : "primary"}
              label="Initial deep dive progress"
            />
            <Text size="sm" color="text-muted">
              {done} of {total} phases complete
            </Text>
          </Stack>

          {failed && status.error && (
            <Banner variant="warning" title="Deep dive paused">
              {status.error}
            </Banner>
          )}

          <ol className={styles.phases}>
            {status.phases.map((phase) => (
              <PhaseRow
                key={phase.id}
                phase={phase}
                active={phase === active}
              />
            ))}
          </ol>
        </Stack>
      </Panel>

      {/* The live "it's working" texture - the calm milestone stream by default. */}
      <Panel padding="4">
        <Stack gap="3">
          <Heading level={4}>Live activity</Heading>
          <GlassCockpit agentId={agentId} />
        </Stack>
      </Panel>
    </Stack>
  );
}

/** Status → icon + badge variant for one phase row. */
function PhaseRow({
  phase,
  active,
}: {
  phase: DeepDivePhaseRecord;
  active: boolean;
}) {
  return (
    <li className={styles.phaseRow}>
      <span className={styles.phaseIcon} aria-hidden="true">
        {phase.status === "complete" ? (
          <Icon icon={CheckCircle2} size="sm" />
        ) : phase.status === "failed" ? (
          <Icon icon={AlertTriangle} size="sm" />
        ) : phase.status === "running" || active ? (
          <Spinner size="sm" />
        ) : (
          <Icon icon={Circle} size="sm" />
        )}
      </span>
      <Stack gap="1" className={styles.phaseBody}>
        <Inline gap="2" align="center">
          <Text weight={active ? "semibold" : "medium"}>{phase.label}</Text>
          {phase.status === "complete" && (
            <Badge variant="success" appearance="subtle">
              done
            </Badge>
          )}
          {(phase.status === "running" || active) && (
            <Badge variant="primary" appearance="subtle">
              working
            </Badge>
          )}
          {phase.status === "failed" && (
            <Badge variant="warning" appearance="subtle">
              skipped
            </Badge>
          )}
        </Inline>
        {phase.note && phase.status === "complete" && (
          <Text size="sm" color="text-muted">
            {phase.note}
          </Text>
        )}
      </Stack>
    </li>
  );
}
