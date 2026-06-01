import { ArrowDown, Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AuditEvent } from "@/api/audit";
import type { AuditStreamStatus } from "@/api/auditStream";
import {
  Badge,
  type BadgeVariant,
  Button,
  EmptyState,
  Icon,
  Spinner,
  Text,
} from "@/components/ui";
import { AuditEventRow } from "./AuditEventRow";
import styles from "./AuditStream.module.css";

/**
 * AuditStream (MNEMO-37) - the scrolling event list at the heart of the cockpit.
 * Renders `AuditEventRow`s newest-at-the-bottom with auto-follow: new events keep
 * the view pinned to the live edge UNLESS the user has scrolled up, in which case
 * a "Jump to live" pill resumes following. A connection-status indicator (live /
 * reconnecting), a "Load older" trigger at the top, and an `EmptyState` for the
 * no-events case round it out. Keyed by `seq` so it stays virtualization-friendly.
 */
export interface AuditStreamProps {
  events: AuditEvent[];
  status: AuditStreamStatus;
  /** The agent the events belong to - passed to rows for the "View report" link. */
  agentId: string;
  /** "Show the work" altitude - passed down so rows reveal their raw detail. */
  showDetail: boolean;
  hasOlder: boolean;
  loadOlder: () => void;
  loadingOlder: boolean;
}

/** Distance (px) from the bottom within which we consider the user "following". */
const FOLLOW_THRESHOLD = 48;

const STATUS_META: Record<
  AuditStreamStatus,
  { label: string; variant: BadgeVariant; busy: boolean }
> = {
  connecting: { label: "Connecting…", variant: "warning", busy: true },
  live: { label: "Live", variant: "success", busy: false },
  reconnecting: { label: "Reconnecting…", variant: "warning", busy: true },
  closed: { label: "Disconnected", variant: "neutral", busy: false },
};

export function AuditStream({
  events,
  status,
  agentId,
  showDetail,
  hasOlder,
  loadOlder,
  loadingOlder,
}: AuditStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  // Keep the view pinned to the live edge while the user is following.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on every new event.
  useEffect(() => {
    if (!following) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, following]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollowing(distance <= FOLLOW_THRESHOLD);
  }

  function jumpToLive() {
    setFollowing(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  const meta = STATUS_META[status];

  return (
    <div className={styles.root}>
      <div className={styles.statusBar}>
        <Badge variant={meta.variant} size="sm">
          {meta.busy ? (
            <span className={styles.statusBusy}>
              <Spinner size="sm" />
            </span>
          ) : (
            <Icon icon={Radio} size="sm" />
          )}
          {meta.label}
        </Badge>
      </div>

      <div
        ref={scrollRef}
        className={styles.scroll}
        onScroll={onScroll}
        role="log"
        aria-label="Audit event stream"
        aria-live="polite"
      >
        {events.length === 0 ? (
          <EmptyState
            title="No activity yet"
            description="As the agent reads sources, writes memory, runs tools, and ships reports, those moments stream in here."
          />
        ) : (
          <>
            {hasOlder && (
              <div className={styles.loadOlder}>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={loadingOlder}
                  onClick={loadOlder}
                >
                  Load older
                </Button>
              </div>
            )}
            {events.map((event) => (
              <AuditEventRow
                key={event.seq}
                event={event}
                agentId={agentId}
                showDetail={showDetail}
              />
            ))}
          </>
        )}
      </div>

      {!following && events.length > 0 && (
        <div className={styles.jump}>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon icon={ArrowDown} size="sm" />}
            onClick={jumpToLive}
          >
            Jump to live
          </Button>
        </div>
      )}

      {status === "closed" && events.length > 0 && (
        <Text size="xs" color="text-muted" className={styles.disconnected}>
          The live stream is disconnected.
        </Text>
      )}
    </div>
  );
}
