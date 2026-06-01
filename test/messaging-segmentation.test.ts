import { describe, expect, it } from "vitest";
import {
  countSegments,
  GSM7_SINGLE,
  isGsm7,
  UCS2_SINGLE,
} from "../src/messaging/segmentation.ts";

// MNEMO-44: SMS length math. PURE functions - no sandbox, no provider. We pin the
// encoding classifier (GSM-7 vs UCS-2) and the segment-count boundaries that drive
// the `segments` field in SendResult (cost/audit, PRD §9.2). Boundary cases are
// covered explicitly: the last char that still fits one segment, and the first that
// tips into two.

describe("isGsm7 - encoding classification", () => {
  it("classifies plain ASCII as GSM-7", () => {
    expect(
      isGsm7("Hello, world! Visit https://x.io for the full report."),
    ).toBe(true);
    // GSM-7 basic set includes digits, punctuation, and a handful of accents.
    expect(isGsm7("Cost: £10 @ 50%")).toBe(true);
  });

  it("classifies emoji / CJK as non-GSM-7", () => {
    expect(isGsm7("nice work 😀")).toBe(false);
    expect(isGsm7("研究レポート")).toBe(false);
  });
});

describe("countSegments - boundaries", () => {
  it("GSM-7: 1 segment at the single-segment limit, 2 just past it", () => {
    expect(GSM7_SINGLE).toBe(160);
    expect(countSegments("a".repeat(160))).toBe(1);
    expect(countSegments("a".repeat(161))).toBe(2);
  });

  it("UCS-2: 1 segment at the single-segment limit, 2 just past it", () => {
    expect(UCS2_SINGLE).toBe(70);
    // A CJK string forces UCS-2; length is counted in UTF-16 code units.
    expect(countSegments("中".repeat(70))).toBe(1);
    expect(countSegments("中".repeat(71))).toBe(2);
  });
});
