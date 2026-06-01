import { describe, expect, it } from "vitest";
import {
  type MentionMember,
  parseMentions,
} from "../src/messaging/mentions.ts";

// MNEMO-48: the @-mention override (PRD §9.4 - "a named agent always responds").
// Pure function, no DO - a mentioned agent bypasses the triage gate and is always a
// floor winner. Matching is conservative so a stray `@` never false-triggers.

const MEMBERS: MentionMember[] = [
  { agentId: "atlas-id", name: "Atlas" },
  { agentId: "scout-id", name: "Scout", handle: "scout" },
  { agentId: "beacon-id", name: "Beacon Vendor Watch" },
];

describe("parseMentions (PRD §9.4)", () => {
  it("finds @Atlas and @scout against the member list", () => {
    expect(parseMentions("hey @Atlas and @scout, thoughts?", MEMBERS)).toEqual([
      "atlas-id",
      "scout-id",
    ]);
  });

  it("matches case-insensitively (name and handle)", () => {
    expect(parseMentions("ping @ATLAS", MEMBERS)).toEqual(["atlas-id"]);
    expect(parseMentions("ping @SCOUT", MEMBERS)).toEqual(["scout-id"]);
  });

  it("matches the first word of a multi-word name", () => {
    expect(parseMentions("@beacon what's new?", MEMBERS)).toEqual([
      "beacon-id",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(parseMentions("hello there, any updates?", MEMBERS)).toEqual([]);
    expect(parseMentions("@nobody here", MEMBERS)).toEqual([]);
  });

  it("does not false-match a bare @ or an email address", () => {
    // A lone `@` (no following name char) never matches.
    expect(parseMentions("let's sync @ 5pm", MEMBERS)).toEqual([]);
    expect(parseMentions("@", MEMBERS)).toEqual([]);
    // An email is not a word-boundary mention - `bob@atlas.com` must NOT hit Atlas.
    expect(parseMentions("reach me at bob@atlas.com", MEMBERS)).toEqual([]);
  });

  it("dedupes a member mentioned twice and follows member order", () => {
    expect(parseMentions("@scout @scout @Atlas", MEMBERS)).toEqual([
      "atlas-id",
      "scout-id",
    ]);
  });
});
