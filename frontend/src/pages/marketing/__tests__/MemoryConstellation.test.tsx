import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryBrain, MemoryConstellationV1 } from "../MemoryConstellation";

/** Every numeric geometry attribute on every element must be finite - a NaN
 *  here (bad math, divide-by-zero) silently drops the shape from the render. */
function expectNoNaNGeometry(root: HTMLElement) {
  const attrs = ["cx", "cy", "r", "x1", "y1", "x2", "y2"];
  for (const el of Array.from(root.querySelectorAll("circle, line"))) {
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v !== null) expect(Number.isFinite(Number(v))).toBe(true);
    }
  }
  const path = root.querySelector("path");
  if (path) expect(path.getAttribute("d") ?? "").not.toContain("NaN");
}

describe("MemoryBrain", () => {
  it("renders a decorative brain mesh with nodes, edges and an outline", () => {
    const { container } = render(<MemoryBrain />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");

    // The brain is the detailed iteration - a dense mesh, not a sparse ring.
    expect(container.querySelectorAll("circle").length).toBeGreaterThan(80);
    expect(container.querySelectorAll("line").length).toBeGreaterThan(60);
    expect(container.querySelector("path")).not.toBeNull();
    expectNoNaNGeometry(container);
  });

  it("keeps node keys unique (no duplicate coordinates)", () => {
    const { container } = render(<MemoryBrain />);
    const keys = Array.from(container.querySelectorAll("circle"))
      .filter((c) => c.getAttribute("r") !== "172") // skip the glow disc
      .map((c) => `${c.getAttribute("cx")}-${c.getAttribute("cy")}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("MemoryConstellationV1", () => {
  it("still renders the original radial save point", () => {
    const { container } = render(<MemoryConstellationV1 />);
    expect(container.querySelector("svg")).not.toBeNull();
    // Center node + 6 inner + 11 outer + glow disc = 19 circles.
    expect(container.querySelectorAll("circle").length).toBe(19);
    expectNoNaNGeometry(container);
  });
});
