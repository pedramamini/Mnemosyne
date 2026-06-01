import styles from "./MarketingPage.module.css";

/**
 * MemoryConstellationV1 — the original soft "memory constellation": a center
 * node plus two radial rings. Preserved verbatim as a revertible save point;
 * render this instead of <MemoryBrain /> in the About section to restore it.
 */
export function MemoryConstellationV1() {
  const C = 180;
  const inner = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    return { x: C + 70 * Math.cos(a), y: C + 70 * Math.sin(a) };
  });
  const outer = Array.from({ length: 11 }, (_, i) => {
    const a = (i / 11) * Math.PI * 2 - Math.PI / 2 + 0.3;
    return { x: C + 140 * Math.cos(a), y: C + 140 * Math.sin(a) };
  });
  const lines: Array<[number, number, number, number]> = [];
  for (const n of inner) lines.push([C, C, n.x, n.y]);
  inner.forEach((n, i) => {
    const base = Math.round((i * outer.length) / inner.length);
    const a = outer[base % outer.length];
    const b = outer[(base + 1) % outer.length];
    lines.push([n.x, n.y, a.x, a.y], [n.x, n.y, b.x, b.y]);
  });
  outer.forEach((o, i) => {
    const nx = outer[(i + 1) % outer.length];
    lines.push([o.x, o.y, nx.x, nx.y]);
  });

  return (
    <svg
      viewBox="0 0 360 360"
      className={styles.constellationSvg}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="mc-glow" cx="50%" cy="50%" r="50%">
          <stop
            offset="0"
            stopColor="var(--color-primary)"
            stopOpacity="0.28"
          />
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mc-fade" cx="50%" cy="50%" r="50%">
          <stop offset="0.5" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <mask id="mc-mask">
          <rect width="360" height="360" fill="url(#mc-fade)" />
        </mask>
      </defs>
      <g mask="url(#mc-mask)">
        <circle cx="180" cy="180" r="172" fill="url(#mc-glow)" />
        <g stroke="currentColor" strokeWidth="1" strokeOpacity="0.55">
          {lines.map((l) => (
            <line
              key={`${l[0]}-${l[1]}-${l[2]}-${l[3]}`}
              x1={l[0]}
              y1={l[1]}
              x2={l[2]}
              y2={l[3]}
            />
          ))}
        </g>
        {inner.map((n, i) => (
          <circle
            key={`in-${n.x}-${n.y}`}
            cx={n.x}
            cy={n.y}
            r={i % 3 === 0 ? 5 : 3.5}
            fill={i % 3 === 0 ? "var(--color-primary)" : "currentColor"}
            fillOpacity={i % 3 === 0 ? 0.9 : 0.6}
          />
        ))}
        {outer.map((n, i) => (
          <circle
            key={`out-${n.x}-${n.y}`}
            cx={n.x}
            cy={n.y}
            r={i % 4 === 0 ? 4.5 : 3}
            fill={i % 4 === 0 ? "var(--color-primary)" : "currentColor"}
            fillOpacity={i % 4 === 0 ? 0.85 : 0.5}
          />
        ))}
        <circle cx="180" cy="180" r="7" fill="var(--color-primary)" />
      </g>
    </svg>
  );
}

interface BrainNode {
  x: number;
  y: number;
  accent: boolean;
}

interface Pt {
  x: number;
  y: number;
}

interface BrainGeometry {
  nodes: BrainNode[];
  lines: Array<[number, number, number, number]>;
  cerebD: string;
  cblumD: string;
}

const Cx = 168;
const Cy = 150;

// Lateral (side-view) cerebrum silhouette, facing left: a bumpy blob bulged at
// the frontal lobe, flattened underneath, with a notch carved at the lower-right
// where the cerebellum nests.
const NOTCH_C = 0.6;
const NOTCH_W = 0.4;
const NOTCH_D = 34;
const rCereb = (th: number) => {
  const rx = 126;
  const ry = 96;
  let base = (rx * ry) / Math.hypot(ry * Math.cos(th), rx * Math.sin(th));
  base *= 1 + 0.07 * Math.cos(th + Math.PI); // bulge the frontal lobe (left)
  base *= 1 - 0.05 * Math.max(0, Math.sin(th)); // flatten the underside
  base += 3.5 * Math.sin(8 * th); // bumpy cortex edge
  const dd = Math.abs(((th - NOTCH_C + Math.PI) % (2 * Math.PI)) - Math.PI);
  return base - NOTCH_D * Math.exp(-((dd / NOTCH_W) ** 2));
};
const inCereb = (x: number, y: number) =>
  Math.hypot(x - Cx, y - Cy) <= rCereb(Math.atan2(y - Cy, x - Cx));

// Cerebellum: a small bumpy disc tucked into the notch at the back.
const cbx = 274;
const cby = 214;
const cbr = 34;
const rCblum = (th: number) => cbr + 2.4 * Math.sin(9 * th);
const inCblum = (x: number, y: number) =>
  Math.hypot(x - cbx, y - cby) <= rCblum(Math.atan2(y - cby, x - cbx));

/**
 * Build the brain geometry once. Deterministic — no inputs, no randomness — so
 * it is computed a single time at module load rather than on every render.
 */
function buildBrain(): BrainGeometry {
  const nodes: BrainNode[] = [];
  const lines: Array<[number, number, number, number]> = [];
  const addSeg = (seg: Pt[], acc: number) => {
    for (let i = 0; i < seg.length; i++) {
      nodes.push({
        x: seg[i].x,
        y: seg[i].y,
        accent: acc > 0 && i % acc === 0,
      });
      if (i > 0) lines.push([seg[i - 1].x, seg[i - 1].y, seg[i].x, seg[i].y]);
    }
  };

  // Meandering gyri: two-frequency wavy scanlines, each tilted and phase-shifted
  // so rows interleave like folds. Strands split wherever they leave the
  // silhouette (or cross the cerebellum) so they hug the concavities.
  const dx = 10;
  let row = 0;
  for (let y = Cy - 102; y <= Cy + 96; y += 13, row++) {
    const ph = row * 1.7;
    const slope = 0.06 * Math.sin(row * 0.8);
    const x0 = Cx - 150 + (row % 2 ? dx * 0.5 : 0) + 3 * Math.sin(row);
    const xs: number[] = [];
    for (let x = x0; x <= Cx + 150; x += dx) xs.push(x);
    if (row % 2) xs.reverse();
    let seg: Pt[] = [];
    for (const x of xs) {
      const yy =
        y +
        8 * Math.sin(0.07 * x + ph) +
        3.4 * Math.sin(0.135 * x + ph * 1.3) +
        slope * (x - Cx);
      if (inCereb(x, yy) && !inCblum(x, yy)) {
        seg.push({ x, y: yy });
      } else if (seg.length) {
        if (seg.length > 1) addSeg(seg, 5);
        seg = [];
      }
    }
    if (seg.length > 1) addSeg(seg, 5);
  }

  // Cerebellum: tight nested arcs opening toward the cerebrum.
  const cbCenter = Math.atan2(Cy - cby, Cx - cbx) + Math.PI;
  for (let g = 1; g <= 5; g++) {
    const rad = 6 + g * 6;
    const np = 4 + g;
    const arc = Array.from({ length: np }, (_, p) => {
      const t = p / (np - 1);
      const th = cbCenter - 2.3 + t * 4.6;
      return {
        x: cbx + rad * Math.cos(th),
        y: cby + rad * Math.sin(th) * 0.92,
      };
    });
    addSeg(arc, 4);
  }

  // Brain stem.
  addSeg(
    [
      { x: 236, y: 246 },
      { x: 238, y: 258 },
      { x: 235, y: 270 },
      { x: 239, y: 282 },
    ],
    0,
  );

  // Faint cortical outlines for the cerebrum and cerebellum.
  const sample = (
    rFn: (th: number) => number,
    ox: number,
    oy: number,
    n: number,
  ) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const th = (i / n) * Math.PI * 2;
      const x = (ox + rFn(th) * Math.cos(th)).toFixed(1);
      const y = (oy + rFn(th) * Math.sin(th)).toFixed(1);
      return `${x},${y}`;
    });
  const cerebD = `M${sample(rCereb, Cx, Cy, 120).join(" L")} Z`;
  const cblumD = `M${sample(rCblum, cbx, cby, 60).join(" L")} Z`;

  return { nodes, lines, cerebD, cblumD };
}

const BRAIN = buildBrain();

/**
 * MemoryBrain — the same soft neural aesthetic as v1 (a currentColor node mesh
 * with accent nodes, a primary radial glow, and an edge-fade mask) but drawn as
 * a side-profile brain in the spirit of the 🧠 emoji: a bumpy cerebrum bulged at
 * the frontal lobe (left) and filled with meandering gyri strands, a coiled
 * cerebellum nested in a notch at the back, and a short brain stem below.
 * Reskins via the theme tokens.
 */
export function MemoryBrain() {
  const { nodes, lines, cerebD, cblumD } = BRAIN;
  return (
    <svg
      viewBox="0 0 360 360"
      className={styles.constellationSvg}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="mb-glow" cx="50%" cy="50%" r="50%">
          <stop
            offset="0"
            stopColor="var(--color-primary)"
            stopOpacity="0.26"
          />
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mb-fade" cx="50%" cy="50%" r="50%">
          <stop offset="0.58" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <mask id="mb-mask">
          <rect width="360" height="360" fill="url(#mb-fade)" />
        </mask>
      </defs>
      <g mask="url(#mb-mask)">
        <circle cx="180" cy="180" r="172" fill="url(#mb-glow)" />
        <path
          d={cerebD}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeOpacity="0.3"
        />
        <path
          d={cblumD}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeOpacity="0.3"
        />
        <g stroke="currentColor" strokeWidth="1" strokeOpacity="0.4">
          {lines.map((l) => (
            <line
              key={`${l[0]}-${l[1]}-${l[2]}-${l[3]}`}
              x1={l[0]}
              y1={l[1]}
              x2={l[2]}
              y2={l[3]}
            />
          ))}
        </g>
        {nodes.map((n) => (
          <circle
            key={`${n.x.toFixed(1)}-${n.y.toFixed(1)}`}
            cx={n.x}
            cy={n.y}
            r={n.accent ? 4 : 2.7}
            fill={n.accent ? "var(--color-primary)" : "currentColor"}
            fillOpacity={n.accent ? 0.9 : 0.5}
          />
        ))}
      </g>
    </svg>
  );
}
