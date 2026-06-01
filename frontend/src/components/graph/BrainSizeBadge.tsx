import { Badge } from "@/components/ui";

export interface BrainSizeBadgeProps {
  /** Neuron count (note files). */
  neurons: number;
  /** Synapse count (parsed `[[wikilink]]` edges). */
  synapses: number;
}

/** `1 neuron` / `N neurons` - pluralize without an i18n dependency. */
function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/**
 * BrainSizeBadge (MNEMO-40, PRD §4 / §6.6) - a compact metric chip rendering the
 * brain-size metric as "N neurons · M synapses". Presentational only; built from
 * the shared `Badge` primitive. Reused by the dashboard later (MNEMO-42 reads the
 * same `brainSize` metric).
 */
export function BrainSizeBadge({ neurons, synapses }: BrainSizeBadgeProps) {
  const label = `${plural(neurons, "neuron")} · ${plural(synapses, "synapse")}`;
  return (
    <Badge
      variant="primary"
      appearance="subtle"
      aria-label={`Brain size: ${label}`}
    >
      {label}
    </Badge>
  );
}
