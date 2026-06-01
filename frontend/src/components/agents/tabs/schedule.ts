/**
 * Schedule cadence ↔ cron mapping, shared by the Settings (edit) and Metadata
 * (display) tabs so the friendly presets and their human-readable forms stay in
 * one place. The backend stores a raw cron string (`schedule_cron`, MNEMO-05);
 * the UI offers a small set of presets plus a raw-cron escape hatch.
 */

/** Friendly cadence presets, mapped to canonical cron strings (server timezone). */
export const CRON_DAILY = "0 9 * * *";
export const CRON_WEEKLY = "0 9 * * 1";

/** A cadence choice surfaced in the Settings select. */
export type Cadence = "off" | "daily" | "weekly" | "custom";

/** Ordered cadence options for a select control. */
export const CADENCE_OPTIONS: ReadonlyArray<{ label: string; value: Cadence }> =
  [
    { label: "Off (manual only)", value: "off" },
    { label: "Daily", value: "daily" },
    { label: "Weekly", value: "weekly" },
    { label: "Custom (cron)", value: "custom" },
  ];

/** Classify a stored cron string into the cadence preset it corresponds to. */
export function cronToCadence(cron: string | null | undefined): Cadence {
  if (!cron) return "off";
  if (cron === CRON_DAILY) return "daily";
  if (cron === CRON_WEEKLY) return "weekly";
  return "custom";
}

/** Resolve a cadence (+ raw cron for the custom case) to the cron string to persist. */
export function cadenceToCron(cadence: Cadence, raw: string): string | null {
  switch (cadence) {
    case "off":
      return null;
    case "daily":
      return CRON_DAILY;
    case "weekly":
      return CRON_WEEKLY;
    case "custom": {
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
}

/** Human-readable description of a stored cron string (for the Metadata tab). */
export function cronToHuman(cron: string | null | undefined): string {
  switch (cronToCadence(cron)) {
    case "off":
      return "Off - runs manually only";
    case "daily":
      return "Daily at 09:00";
    case "weekly":
      return "Weekly on Monday at 09:00";
    case "custom":
      return `Custom (${cron})`;
  }
}
