// Graph renderer library: react-force-graph-2d (a canvas-based force-graph with a
// d3-force layout), pinned in frontend/package.json. Canvas (not SVG) is chosen so
// large brains stay performant. This file is a deliberately THIN wrapper over the
// lib so the renderer stays swappable; all graph/canvas rendering here is exempt
// from the @/components/ui raw-element rule (the lib draws its own <canvas>).
import { useEffect, useRef, useState } from "react";
import ForceGraph2D, { type NodeObject } from "react-force-graph-2d";
import type { GraphNode, NeuronType } from "@/api/graph";
import type { GraphLink } from "./useBrainGraph";

export interface BrainGraphCanvasProps {
  /** Already-transformed nodes (carry `degree`/`neuronType`). */
  nodes: GraphNode[];
  /** Already-transformed links (`source`/`target` node ids). */
  links: GraphLink[];
  /** Fired with the clicked node (the tab deep-links into the brain explorer). */
  onNodeClick: (node: GraphNode) => void;
  /** Optional node id to emphasize (e.g. the focused neuron). */
  highlightNodeId?: string;
}

/** neuronType → design-token CSS variable used for the node fill. */
const TYPE_TOKENS: Record<NeuronType, string> = {
  note: "--color-primary",
  tool: "--color-warning",
  report: "--color-success",
  dangling: "--color-text-muted",
  other: "--color-border-strong",
};

/** Concrete fallbacks if a token can't be read (canvas needs a resolved color). */
const FALLBACK: Record<NeuronType | "highlight", string> = {
  note: "#4f46e5",
  tool: "#b25c00",
  report: "#157f3b",
  dangling: "#5c6470",
  other: "#b9c0c9",
  highlight: "#c02b2b",
};

/** The resolved color palette (token values, light/dark-aware). */
type Palette = Record<NeuronType | "highlight", string>;

/** Read the design-token palette from the document root (canvas can't use `var()`). */
function readPalette(): Palette {
  if (typeof window === "undefined") return { ...FALLBACK };
  const cs = getComputedStyle(document.documentElement);
  const read = (token: string, fb: string): string =>
    cs.getPropertyValue(token).trim() || fb;
  return {
    note: read(TYPE_TOKENS.note, FALLBACK.note),
    tool: read(TYPE_TOKENS.tool, FALLBACK.tool),
    report: read(TYPE_TOKENS.report, FALLBACK.report),
    dangling: read(TYPE_TOKENS.dangling, FALLBACK.dangling),
    other: read(TYPE_TOKENS.other, FALLBACK.other),
    highlight: read("--color-danger", FALLBACK.highlight),
  };
}

/**
 * BrainGraphCanvas (MNEMO-40, PRD §6.2) - the force-directed brain map renderer.
 * Presentational only: it receives already-transformed `nodes`/`links` and draws
 * neurons sized by `degree` (more-connected = larger), colored by `neuronType`,
 * labeled by `title` on hover, with zoom / pan / drag enabled by the lib. Sizing
 * comes from the parent container (measured via `ResizeObserver`).
 */
export function BrainGraphCanvas({
  nodes,
  links,
  onNodeClick,
  highlightNodeId,
}: BrainGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [palette, setPalette] = useState<Palette>(() => ({ ...FALLBACK }));

  // Track the container's box so the canvas fills it (and reflows on resize).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Resolve token colors once mounted (so light/dark themes are honored).
  useEffect(() => {
    setPalette(readPalette());
  }, []);

  const colorFor = (node: NodeObject<GraphNode>): string => {
    if (highlightNodeId && node.id === highlightNodeId)
      return palette.highlight;
    return palette[(node.neuronType as NeuronType) ?? "other"] ?? palette.other;
  };

  return (
    <div
      ref={containerRef}
      // `touch-action: none` hands touch gestures to the graph's d3-zoom (pinch-
      // zoom / pan) instead of the browser, so the map is fully usable on mobile.
      style={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        touchAction: "none",
      }}
    >
      {size.width > 0 && size.height > 0 && (
        <ForceGraph2D<GraphNode, GraphLink>
          width={size.width}
          height={size.height}
          graphData={{ nodes, links }}
          nodeId="id"
          // More-connected neurons render larger (area scales with value).
          nodeVal={(node) => 1 + (node.degree ?? 0)}
          nodeRelSize={5}
          nodeLabel={(node) => node.title ?? node.id}
          nodeColor={colorFor}
          linkColor={() => palette.other}
          // Touch parity: pinch-zoom, drag-to-pan, and tap-to-select. These are
          // on by default in react-force-graph-2d; set explicitly so the intent
          // survives future edits.
          enablePointerInteraction={true}
          enableZoomInteraction={true}
          enablePanInteraction={true}
          onNodeClick={(node) => onNodeClick(node as GraphNode)}
        />
      )}
    </div>
  );
}
