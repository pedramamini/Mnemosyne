import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../fuzzy";

describe("fuzzyMatch", () => {
  it("matches an empty query against anything with neutral score", () => {
    const r = fuzzyMatch("", "Account settings");
    expect(r).not.toBeNull();
    expect(r?.score).toBe(0);
    expect(r?.ranges).toEqual([]);
  });

  it("matches a contiguous case-insensitive substring", () => {
    const r = fuzzyMatch("set", "Account settings");
    expect(r).not.toBeNull();
    // "set" begins the word "settings" (index 8).
    expect(r?.ranges).toEqual([[8, 11]]);
  });

  it("matches a non-contiguous subsequence", () => {
    const r = fuzzyMatch("acs", "Account settings");
    expect(r).not.toBeNull();
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "Account settings")).toBeNull();
    // Out-of-order chars never match.
    expect(fuzzyMatch("tes", "set")).toBeNull();
  });

  it("scores a word-boundary match above a mid-word one", () => {
    const boundary = fuzzyMatch("set", "Open settings");
    const midWord = fuzzyMatch("set", "tasset xyz");
    expect(boundary).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect((boundary?.score ?? 0) > (midWord?.score ?? 0)).toBe(true);
  });

  it("scores a tight match over a scattered one for ranking", () => {
    const tight = fuzzyMatch("brain", "Brain");
    const scattered = fuzzyMatch("brain", "Open Reports about a rainy brunch");
    expect(tight).not.toBeNull();
    if (scattered) {
      expect((tight?.score ?? 0) > scattered.score).toBe(true);
    }
  });

  it("merges adjacent matched characters into one highlight range", () => {
    const r = fuzzyMatch("brai", "Brain");
    expect(r?.ranges).toEqual([[0, 4]]);
  });
});
