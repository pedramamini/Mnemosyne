import { describe, expect, it } from "vitest";
import {
  ReportFrontMatter,
  serializeFrontMatter,
} from "../src/reports/front-matter.ts";

// MNEMO-24: the Obsidian front-matter layer. PURE - no sandbox. We pin the two
// properties later phases rely on: (1) STABLE key order + byte-identical output
// for the same input (MNEMO-26 diffs two reports textually), and (2) correct YAML
// quoting/list rendering. We also assert the Zod schema rejects a missing title
// and a bad template value at the boundary.

const FM: ReportFrontMatter = {
  title: "Acme Corp Vendor Review",
  type: "report",
  agentId: "agent-123",
  template: "vendor",
  tags: ["security", "vendor"],
  created: "2026-05-24T12:00:00.000Z",
  source_count: 7,
};

describe("serializeFrontMatter - structure & stable order", () => {
  it("emits a `---`-fenced YAML block", () => {
    const out = serializeFrontMatter(FM);
    expect(out.startsWith("---\n")).toBe(true);
    // A closing fence on its own line, with a trailing newline after it.
    expect(out.endsWith("---\n")).toBe(true);
    expect(out.match(/^---$/gm)?.length).toBe(2);
  });

  it("emits keys in the fixed documented order", () => {
    const out = serializeFrontMatter(FM);
    const keyLines = out
      .split("\n")
      .filter((l) => /^[a-zA-Z_]+:/.test(l))
      .map((l) => l.slice(0, l.indexOf(":")));
    expect(keyLines).toEqual([
      "title",
      "type",
      "agentId",
      "template",
      "tags",
      "created",
      "source_count",
    ]);
  });

  it("is byte-identical across runs for the same input (MNEMO-26 diff property)", () => {
    expect(serializeFrontMatter(FM)).toBe(serializeFrontMatter(FM));
    // Two independently-built equal inputs must serialize identically too.
    const copy: ReportFrontMatter = { ...FM, tags: [...FM.tags] };
    expect(serializeFrontMatter(copy)).toBe(serializeFrontMatter(FM));
  });

  it("omits absent optionals entirely (no empty keys to perturb a diff)", () => {
    const out = serializeFrontMatter({
      title: "Bare",
      agentId: "a",
      created: "2026-05-24",
    });
    expect(out).not.toContain("template:");
    expect(out).not.toContain("period:");
    expect(out).not.toContain("cadence:");
    expect(out).not.toContain("source_count:");
    // Defaults still applied: type + an empty tags list.
    expect(out).toContain("type: report");
    expect(out).toContain("tags: []");
  });
});

describe("serializeFrontMatter - quoting & lists", () => {
  it("quotes strings that would be ambiguous YAML (colons, dates)", () => {
    const out = serializeFrontMatter({
      ...FM,
      title: "Acme: Q2 Review",
    });
    expect(out).toContain('title: "Acme: Q2 Review"');
    // The ISO timestamp contains `:` and must be quoted.
    expect(out).toContain('created: "2026-05-24T12:00:00.000Z"');
  });

  it("escapes embedded quotes and backslashes", () => {
    const out = serializeFrontMatter({
      ...FM,
      title: 'A "quoted" \\ path',
    });
    expect(out).toContain('title: "A \\"quoted\\" \\\\ path"');
  });

  it("leaves simple scalars unquoted and numbers bare", () => {
    const out = serializeFrontMatter(FM);
    expect(out).toContain("type: report");
    expect(out).toContain("agentId: agent-123");
    expect(out).toContain("source_count: 7");
  });

  it("renders tags as a YAML block list", () => {
    const out = serializeFrontMatter(FM);
    expect(out).toContain("tags:\n  - security\n  - vendor");
  });
});

describe("ReportFrontMatter schema", () => {
  it("rejects a missing title", () => {
    const result = ReportFrontMatter.safeParse({
      agentId: "a",
      created: "2026-05-24",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bad template value", () => {
    const result = ReportFrontMatter.safeParse({
      title: "x",
      agentId: "a",
      created: "2026-05-24",
      template: "frenemy",
    });
    expect(result.success).toBe(false);
  });

  it("applies the type + tags defaults", () => {
    const parsed = ReportFrontMatter.parse({
      title: "x",
      agentId: "a",
      created: "2026-05-24",
    });
    expect(parsed.type).toBe("report");
    expect(parsed.tags).toEqual([]);
  });
});
