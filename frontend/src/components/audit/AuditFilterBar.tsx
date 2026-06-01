import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import type { AuditEventType, AuditFilters } from "@/api/audit";
import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  FormField,
  Icon,
  Inline,
  Input,
  Select,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./AuditFilterBar.module.css";

/**
 * AuditFilterBar (MNEMO-37) - type / session / time controls for the cockpit. It
 * owns NO data: it derives the current selection from `filters` and emits a fresh
 * `AuditFilters` via `onChange` (consumed by `useAuditStream`). The altitude
 * `level` is deliberately NOT here - the `AltitudeToggle` owns it.
 *
 * Event types are grouped sensibly (§6.7: sources / memory / tools / reports /
 * errors / activity) as a multi-select. On narrow viewports the controls collapse
 * into a "Filters" Drawer; the same `FilterControls` render drives both, so there
 * is one source of UI truth.
 */
export interface AuditFilterBarProps {
  filters: AuditFilters;
  onChange: (filters: AuditFilters) => void;
  /** Recent session ids (derived from the loaded events) for the session dropdown. */
  sessions: string[];
}

const TYPE_GROUPS: { label: string; types: AuditEventType[] }[] = [
  {
    label: "Activity",
    types: ["session.started", "session.completed", "narration"],
  },
  { label: "Sources", types: ["source.read"] },
  {
    label: "Memory",
    types: ["memory.wrote", "memory.linked", "memory.consolidated"],
  },
  { label: "Tools", types: ["tool.authored", "tool.ran"] },
  { label: "Reports", types: ["report.generated", "chart.rendered"] },
  {
    label: "Onboarding & self-review",
    types: ["onboarding.phase", "assessment.completed", "self.revised"],
  },
  { label: "Errors", types: ["error"] },
];

/** Friendly labels for the individual types in the multi-select. */
const TYPE_LABEL: Record<AuditEventType, string> = {
  "session.started": "Session started",
  "session.completed": "Session completed",
  "source.read": "Source read",
  "memory.wrote": "Memory written",
  "memory.linked": "Memory linked",
  "memory.consolidated": "Memory consolidated",
  "tool.authored": "Tool authored",
  "tool.ran": "Tool ran",
  "report.generated": "Report generated",
  "chart.rendered": "Chart rendered",
  "onboarding.phase": "Onboarding phase",
  "assessment.completed": "Self-review",
  "self.revised": "Playbook revised",
  narration: "Narration",
  error: "Error",
};

type TimePreset = "all" | "hour" | "today" | "7d" | "custom";

const TIME_OPTIONS: { label: string; value: TimePreset }[] = [
  { label: "All time", value: "all" },
  { label: "Last hour", value: "hour" },
  { label: "Today", value: "today" },
  { label: "Last 7 days", value: "7d" },
  { label: "Custom range", value: "custom" },
];

/** Compute the {from,to} epoch-ms window for a preset (or the custom inputs). */
function rangeFor(
  preset: TimePreset,
  customFrom: string,
  customTo: string,
): Pick<AuditFilters, "from" | "to"> {
  const now = Date.now();
  switch (preset) {
    case "hour":
      return { from: now - 3_600_000 };
    case "today": {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { from: start.getTime() };
    }
    case "7d":
      return { from: now - 7 * 86_400_000 };
    case "custom":
      return {
        from: customFrom ? new Date(customFrom).getTime() : undefined,
        to: customTo ? new Date(customTo).getTime() : undefined,
      };
    default:
      return {};
  }
}

/** Trim a session id for display in the dropdown. */
function shortSession(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id;
}

export function AuditFilterBar({
  filters,
  onChange,
  sessions,
}: AuditFilterBarProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [preset, setPreset] = useState<TimePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const selectedTypes = new Set(filters.type ?? []);
  const activeCount =
    selectedTypes.size +
    (filters.sessionId ? 1 : 0) +
    (filters.from != null || filters.to != null ? 1 : 0);

  /** Merge a patch into the current filters, dropping empty keys, and emit. */
  function update(patch: Partial<AuditFilters>) {
    const next: AuditFilters = { ...filters, ...patch };
    if (!next.type || next.type.length === 0) next.type = undefined;
    if (!next.sessionId) next.sessionId = undefined;
    if (next.from == null) next.from = undefined;
    if (next.to == null) next.to = undefined;
    onChange(next);
  }

  function toggleType(type: AuditEventType, checked: boolean) {
    const set = new Set(selectedTypes);
    if (checked) set.add(type);
    else set.delete(type);
    update({ type: set.size ? [...set] : undefined });
  }

  function changePreset(value: TimePreset) {
    setPreset(value);
    update(rangeFor(value, customFrom, customTo));
  }

  function changeCustom(from: string, to: string) {
    setCustomFrom(from);
    setCustomTo(to);
    if (preset === "custom") update(rangeFor("custom", from, to));
  }

  const controls = (
    <Stack gap="4" className={styles.controls}>
      <Stack gap="2">
        <Text size="sm" weight="medium">
          Event types
        </Text>
        <div className={styles.typeGroups}>
          {TYPE_GROUPS.map((group) => (
            <Stack key={group.label} gap="1" className={styles.typeGroup}>
              <Text size="xs" color="text-muted" weight="medium">
                {group.label}
              </Text>
              {group.types.map((type) => (
                <Checkbox
                  key={type}
                  label={TYPE_LABEL[type]}
                  checked={selectedTypes.has(type)}
                  onChange={(e) => toggleType(type, e.target.checked)}
                />
              ))}
            </Stack>
          ))}
        </div>
      </Stack>

      <Inline gap="4" align="end" wrap>
        <FormField label="Session" className={styles.field}>
          <Select
            value={filters.sessionId ?? ""}
            onChange={(e) => update({ sessionId: e.target.value || undefined })}
            options={[
              { label: "All sessions", value: "" },
              ...sessions.map((s) => ({ label: shortSession(s), value: s })),
            ]}
          />
        </FormField>

        <FormField label="Time" className={styles.field}>
          <Select
            value={preset}
            onChange={(e) => changePreset(e.target.value as TimePreset)}
            options={TIME_OPTIONS}
          />
        </FormField>
      </Inline>

      {preset === "custom" && (
        <Inline gap="4" wrap>
          <FormField label="From" className={styles.field}>
            <Input
              type="datetime-local"
              value={customFrom}
              onChange={(e) => changeCustom(e.target.value, customTo)}
            />
          </FormField>
          <FormField label="To" className={styles.field}>
            <Input
              type="datetime-local"
              value={customTo}
              onChange={(e) => changeCustom(customFrom, e.target.value)}
            />
          </FormField>
        </Inline>
      )}
    </Stack>
  );

  return (
    <>
      {/* Desktop: controls inline. */}
      <div className={styles.inline}>{controls}</div>

      {/* Mobile: a "Filters" trigger opening the same controls in a sheet. */}
      <div className={styles.mobileTrigger}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon icon={SlidersHorizontal} size="sm" />}
          onClick={() => setDrawerOpen(true)}
        >
          Filters
          {activeCount > 0 && (
            <Badge variant="primary" size="sm">
              {activeCount}
            </Badge>
          )}
        </Button>
      </div>
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Filters"
      >
        {controls}
      </Drawer>
    </>
  );
}
