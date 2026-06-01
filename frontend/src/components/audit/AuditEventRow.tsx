import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BarChart3,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Compass,
  FileText,
  FlagTriangleRight,
  GraduationCap,
  Layers,
  Link2,
  PenLine,
  PlayCircle,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import type {
  AuditEvent,
  AuditEventDetail,
  AuditEventType,
  AuditLevel,
} from "@/api/audit";
import {
  Badge,
  Button,
  Code,
  Icon,
  Inline,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./AuditEventRow.module.css";

/**
 * AuditEventRow (MNEMO-37) - one event in the cockpit stream: a type icon, the
 * plain-English `summary`, a relative timestamp, and a subtle `level` tint. In
 * "Show the work" (`showDetail`) it grows an expandable disclosure rendering the
 * raw `command`/`code` in a monospace block, `reasoning` as text, `output`
 * truncated-with-expand, the report `delta` ("what changed"), and any remaining
 * structured payload as a labelled key/value list. In the calm milestone view the
 * detail stays hidden - only the human summary shows.
 *
 * When an event references a persisted report (a `reportId` in its payload, e.g.
 * `report.generated`), the row surfaces a "View report" deep-link to the Reports
 * tab - shown at BOTH altitudes, since it's a primary affordance, not raw detail.
 */
export interface AuditEventRowProps {
  event: AuditEvent;
  /** The agent the events belong to - builds the "View report" deep-link. */
  agentId: string;
  /** When true (the "Show the work" altitude), expose the raw `detail` disclosure. */
  showDetail: boolean;
}

const TYPE_ICON: Record<AuditEventType, LucideIcon> = {
  "session.started": PlayCircle,
  "session.completed": FlagTriangleRight,
  "source.read": FileText,
  "memory.wrote": PenLine,
  "memory.linked": Link2,
  "memory.consolidated": Layers,
  "tool.authored": Wrench,
  "tool.ran": Terminal,
  "report.generated": FileText,
  "chart.rendered": BarChart3,
  "onboarding.phase": Compass,
  "assessment.completed": GraduationCap,
  "self.revised": Sparkles,
  narration: Brain,
  error: AlertTriangle,
};

/** Level → Badge variant for the subtle altitude tint. */
const LEVEL_VARIANT: Record<AuditLevel, "neutral" | "primary" | "danger"> = {
  milestone: "primary",
  info: "neutral",
  error: "danger",
};

/** How many characters of `output` to show before the truncate-with-expand. */
const OUTPUT_PREVIEW = 400;

/** Compact relative time ("just now", "5m ago", "3h ago", "2d ago"). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/**
 * Detail keys with a dedicated render (or surfaced as the report link) - excluded
 * from the generic key/value list so they aren't shown twice.
 */
const HANDLED_DETAIL_KEYS = new Set([
  "command",
  "code",
  "reasoning",
  "output",
  "reportId",
  "delta",
]);

/** Acronyms kept upper-cased when humanizing a payload key (`r2Key` → "R2 key"). */
const KEY_ACRONYMS: Record<string, string> = {
  url: "URL",
  r2: "R2",
  id: "ID",
  png: "PNG",
  md: "MD",
};

/** Turn a payload key ("brainPath", "r2Key", "url") into a readable label. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (KEY_ACRONYMS[lower]) return KEY_ACRONYMS[lower];
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** The MNEMO-26 report delta carried on a `report.generated` event. */
interface ReportDelta {
  headline?: string;
  added?: number;
  changed?: number;
  removed?: number;
}

/** Read the delta object off a payload, when present and shaped like a delta. */
function deltaOf(
  detail: AuditEventDetail | undefined,
): ReportDelta | undefined {
  const d = detail?.delta;
  if (!d || typeof d !== "object" || Array.isArray(d)) return undefined;
  const o = d as Record<string, unknown>;
  const keys = ["headline", "added", "changed", "removed"];
  return keys.some((k) => k in o) ? (o as ReportDelta) : undefined;
}

/** The linked report id off a payload, when present (drives the "View report" link). */
function reportIdOf(detail: AuditEventDetail | undefined): string | undefined {
  const id = detail?.reportId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Remaining payload entries (beyond the dedicated blocks) worth showing as key/value. */
function extraDetailEntries(
  detail: AuditEventDetail | undefined,
): [string, unknown][] {
  if (!detail) return [];
  return Object.entries(detail).filter(
    ([k, v]) => !HANDLED_DETAIL_KEYS.has(k) && v != null && v !== "",
  );
}

/** True when the event carries any structured detail worth a "Show the work" disclosure. */
function hasRawDetail(event: AuditEvent): boolean {
  const d = event.detail;
  if (!d) return false;
  if (d.command || d.code || d.reasoning || d.output) return true;
  if (deltaOf(d)) return true;
  return extraDetailEntries(d).length > 0;
}

/** Render one payload value: scalars as text, structured values as a JSON block. */
function DetailValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <Text size="sm" className={styles.metaValue}>
        {value}
      </Text>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <Text size="sm">{String(value)}</Text>;
  }
  return (
    <Code block className={styles.detailCode}>
      {JSON.stringify(value, null, 2)}
    </Code>
  );
}

/** The "What changed" block for a report delta (headline + add/change/remove counts). */
function DeltaBlock({ delta }: { delta: ReportDelta }) {
  return (
    <Stack gap="1">
      <Text size="xs" color="text-muted" weight="medium">
        What changed
      </Text>
      {delta.headline && <Text size="sm">{delta.headline}</Text>}
      <Inline gap="2">
        {typeof delta.added === "number" && (
          <Badge variant="success" size="sm">{`+${delta.added} added`}</Badge>
        )}
        {typeof delta.changed === "number" && (
          <Badge
            variant="warning"
            size="sm"
          >{`~${delta.changed} changed`}</Badge>
        )}
        {typeof delta.removed === "number" && (
          <Badge
            variant="neutral"
            size="sm"
          >{`−${delta.removed} removed`}</Badge>
        )}
      </Inline>
    </Stack>
  );
}

function OutputBlock({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = output.length > OUTPUT_PREVIEW;
  const shown =
    expanded || !long ? output : `${output.slice(0, OUTPUT_PREVIEW)}…`;
  return (
    <Stack gap="1">
      <Text size="xs" color="text-muted" weight="medium">
        Output
      </Text>
      <Code block className={styles.detailCode}>
        {shown}
      </Code>
      {long && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </Stack>
  );
}

export function AuditEventRow({
  event,
  agentId,
  showDetail,
}: AuditEventRowProps) {
  const [open, setOpen] = useState(false);
  const detail = event.detail;
  const expandable = showDetail && hasRawDetail(event);
  const delta = deltaOf(detail);
  const extra = extraDetailEntries(detail);
  const reportId = reportIdOf(detail);
  const reportTo = reportId
    ? `/agents/${encodeURIComponent(agentId)}/reports?report=${encodeURIComponent(reportId)}`
    : null;

  return (
    <div className={styles.row} data-level={event.level}>
      <span className={styles.icon} aria-hidden="true">
        <Icon icon={TYPE_ICON[event.type] ?? CircleDot} size="sm" />
      </span>
      <div className={styles.body}>
        <Inline gap="2" justify="between" align="start" wrap={false}>
          <Text as="p" className={styles.summary}>
            {event.summary}
          </Text>
          <time className={styles.time} dateTime={event.ts}>
            <Text size="xs" color="text-muted">
              {relativeTime(event.ts)}
            </Text>
          </time>
        </Inline>

        <Inline gap="2">
          <Badge variant={LEVEL_VARIANT[event.level]} size="sm">
            {event.level}
          </Badge>
          {reportTo && (
            <Link
              to={reportTo}
              className={styles.reportLink}
              aria-label={`View report: ${event.summary}`}
            >
              <Icon icon={FileText} size="sm" />
              <Text size="xs" weight="medium" color="inherit">
                View report
              </Text>
            </Link>
          )}
          {expandable && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              leftIcon={
                <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
              }
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Hide work" : "Show work"}
            </Button>
          )}
        </Inline>

        {expandable && open && detail && (
          <Stack gap="3" className={styles.detail}>
            {detail.command && (
              <Stack gap="1">
                <Text size="xs" color="text-muted" weight="medium">
                  Command
                </Text>
                <Code block className={styles.detailCode}>
                  {detail.command}
                </Code>
              </Stack>
            )}
            {detail.code && (
              <Stack gap="1">
                <Text size="xs" color="text-muted" weight="medium">
                  Code
                </Text>
                <Code block className={styles.detailCode}>
                  {detail.code}
                </Code>
              </Stack>
            )}
            {detail.reasoning && (
              <Stack gap="1">
                <Text size="xs" color="text-muted" weight="medium">
                  Reasoning
                </Text>
                <Text size="sm" className={styles.reasoning}>
                  {detail.reasoning}
                </Text>
              </Stack>
            )}
            {detail.output && <OutputBlock output={detail.output} />}
            {delta && <DeltaBlock delta={delta} />}
            {extra.length > 0 && (
              <Stack gap="1">
                <Text size="xs" color="text-muted" weight="medium">
                  Details
                </Text>
                <dl className={styles.metaList}>
                  {extra.map(([k, v]) => (
                    <Fragment key={k}>
                      <dt>
                        <Text size="xs" color="text-muted" weight="medium">
                          {humanizeKey(k)}
                        </Text>
                      </dt>
                      <dd>
                        <DetailValue value={v} />
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              </Stack>
            )}
          </Stack>
        )}
      </div>
    </div>
  );
}
