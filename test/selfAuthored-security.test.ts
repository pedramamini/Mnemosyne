import { describe, expect, it } from "vitest";
import { ToolManifest } from "../src/tools/selfAuthored/manifest.ts";
import {
  assertWithinToolDir,
  ToolSecurityError,
  validateInput,
  validateToolName,
} from "../src/tools/selfAuthored/security.ts";

// MNEMO-19: the containment rules for self-authored tools (the product's largest
// security surface - PRD §6.2). The real boundary is per-agent sandbox isolation
// (§7.3/§8.4); these guards are defense-in-depth and must reject every escape.

describe("validateToolName - slug-only containment", () => {
  it("rejects traversal / path / dotfile / empty / uppercase names", () => {
    for (const bad of [
      "../escape",
      "a/b",
      ".hidden",
      "",
      "Caps",
      "a b",
      "a.b",
    ]) {
      expect(() => validateToolName(bad)).toThrow(ToolSecurityError);
    }
  });

  it("accepts valid slugs and returns the name", () => {
    for (const good of ["counter", "fetch-prices", "tool1", "a-b-c-2"]) {
      expect(validateToolName(good)).toBe(good);
    }
  });
});

describe("assertWithinToolDir - every write stays under the tool dir", () => {
  it("blocks a path that resolves outside /brain/tools/<name>/", () => {
    // An entrypoint of `../../etc/x` resolves to /brain/etc/x - inside /brain but
    // OUTSIDE the tool's own dir, so it must be refused.
    expect(() => assertWithinToolDir("../../etc/x", "counter")).toThrow(
      ToolSecurityError,
    );
    // A deeper climb is likewise contained.
    expect(() =>
      assertWithinToolDir("../../../../tmp/evil", "counter"),
    ).toThrow(ToolSecurityError);
  });

  it("allows a legitimate nested path under the tool dir", () => {
    expect(assertWithinToolDir("main.py", "counter")).toBe(
      "/brain/tools/counter/main.py",
    );
    expect(assertWithinToolDir("lib/util.py", "counter")).toBe(
      "/brain/tools/counter/lib/util.py",
    );
    // The manifest path inside the dir is fine too.
    expect(
      assertWithinToolDir("/brain/tools/counter/tool.json", "counter"),
    ).toBe("/brain/tools/counter/tool.json");
  });
});

describe("ToolManifest - malformed manifests are skipped by validation, not thrown", () => {
  it("safeParse returns success:false on an invalid manifest (no throw)", () => {
    // Bad name (not a slug) + missing fields - validation reports failure rather
    // than throwing, which is exactly how discovery skips a broken tool.
    const result = ToolManifest.safeParse({
      name: "BAD NAME",
      runtime: "ruby",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed manifest", () => {
    const ok = ToolManifest.safeParse({
      name: "counter",
      description: "counts things",
      runtime: "python",
      entrypoint: "main.py",
      inputSchema: { type: "object" },
      createdAt: "2026-05-24T00:00:00.000Z",
      version: 1,
    });
    expect(ok.success).toBe(true);
  });
});

describe("validateInput - input is checked against the manifest schema", () => {
  const schema = {
    type: "object",
    properties: { n: { type: "integer" }, label: { type: "string" } },
    required: ["n"],
  };

  it("accepts conforming input", () => {
    expect(validateInput(schema, { n: 3, label: "x" }).ok).toBe(true);
  });

  it("rejects a missing required field and a wrong type", () => {
    expect(validateInput(schema, { label: "x" }).ok).toBe(false); // missing n
    expect(validateInput(schema, { n: "three" }).ok).toBe(false); // wrong type
    expect(validateInput(schema, { n: 1.5 }).ok).toBe(false); // not an integer
  });
});
