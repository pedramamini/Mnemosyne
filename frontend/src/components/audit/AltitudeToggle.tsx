import { Eye, Sparkles } from "lucide-react";
import type { AuditAltitude } from "@/api/audit";
import { Button, Icon, Stack, Text } from "@/components/ui";
import styles from "./AltitudeToggle.module.css";

/**
 * AltitudeToggle (MNEMO-37) - the §6.7 progressive-disclosure anchor of the glass
 * cockpit. A prominent segmented control between the calm "Milestones" stream
 * (`milestone`, the default) and "Show the work" (`all` - milestone + info + error,
 * unlocking each event's raw command/code/reasoning/output). A one-line helper
 * explains what the active mode shows.
 *
 * Controlled via `value`/`onChange`. Built from shared `Button`s (a `radiogroup`
 * of toggle buttons) - never a raw control - so it inherits the design tokens and
 * stays lint-compliant outside `components/ui`.
 */
export interface AltitudeToggleProps {
  value: AuditAltitude;
  onChange: (value: AuditAltitude) => void;
}

const HELP: Record<AuditAltitude, string> = {
  milestone:
    "A calm, plain-English summary of what the agent accomplishes - the headlines only.",
  all: "Everything the agent does, with the raw commands, code, reasoning, and output revealed.",
};

export function AltitudeToggle({ value, onChange }: AltitudeToggleProps) {
  return (
    <Stack gap="2">
      <div className={styles.segment} role="radiogroup" aria-label="Altitude">
        <Button
          type="button"
          role="radio"
          aria-checked={value === "milestone"}
          variant={value === "milestone" ? "primary" : "ghost"}
          size="sm"
          className={styles.option}
          leftIcon={<Icon icon={Sparkles} size="sm" />}
          onClick={() => onChange("milestone")}
        >
          Milestones
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={value === "all"}
          variant={value === "all" ? "primary" : "ghost"}
          size="sm"
          className={styles.option}
          leftIcon={<Icon icon={Eye} size="sm" />}
          onClick={() => onChange("all")}
        >
          Show the work
        </Button>
      </div>
      <Text size="sm" color="text-muted">
        {HELP[value]}
      </Text>
    </Stack>
  );
}
