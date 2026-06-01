import { beforeEach, describe, expect, it } from "vitest";
import { type AuditEmitTarget, AuditEmitter } from "../src/audit/index.ts";
import type { AuditInput } from "../src/audit/types.ts";
import { REPORT_ASSETS_DIR } from "../src/memory/layout.ts";
import {
  buildChartCode,
  buildSvgToPngCode,
  renderChartPng,
} from "../src/reports/charts.ts";
import { __resetPythonEnvForTest } from "../src/reports/python-env.ts";
import {
  type BrainFileWriter,
  ChartSpec,
  type ChartSpecData,
  type CodeRunner,
  type CtxHandle,
  type RunResult,
} from "../src/reports/types.ts";

// MNEMO-23: the chart→PNG pipeline. These are PURE/mocked - no sandbox. We unit
// test the snippet builders (deterministic Python from a spec) + the ChartSpec
// schema, then drive renderChartPng with a fake CodeInterpreter (a runCode that
// returns a known base64 PNG) + a spy writer + a spy AuditEmitter, asserting the
// bytes decode, the PNG lands under /brain/reports/assets, and one chart.rendered
// fires. The Beta Code-Interpreter SDK itself is pinned in reports-interpreter.test.

/** A minimal CodeContext-shaped handle for the fake interpreter. */
function makeCtx(id = "ctx-1"): CtxHandle {
  return {
    id,
    language: "python",
    cwd: "/workspace",
    createdAt: new Date(),
    lastUsed: new Date(),
  };
}

/** A known 8-byte "PNG" payload + its base64 - what the fake runCode returns. */
const KNOWN_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KNOWN_PNG_B64 = btoa(String.fromCharCode(...KNOWN_BYTES));

/** A fake CodeRunner recording the code it ran and returning a fixed PNG result. */
function fakeInterp(): { interp: CodeRunner; codes: string[] } {
  const codes: string[] = [];
  const interp: CodeRunner = {
    runCode: async (_ctx, code): Promise<RunResult> => {
      codes.push(code);
      return {
        stdout: "",
        stderr: "",
        error: null,
        results: [{ png: KNOWN_PNG_B64 }],
      };
    },
  };
  return { interp, codes };
}

/** A spy BrainFileWriter recording binary writes + mkdir calls. */
function spyWriter(): {
  writer: BrainFileWriter;
  writes: Array<{ path: string; bytes: Uint8Array }>;
  mkdirs: string[];
} {
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const mkdirs: string[] = [];
  return {
    writes,
    mkdirs,
    writer: {
      writeFileBytes: async (path, bytes) => {
        writes.push({ path, bytes });
      },
      mkdir: async (path) => {
        mkdirs.push(path);
      },
    },
  };
}

/** A spy AuditEmitter capturing forwarded events. */
function spyEmitter(): { emitter: AuditEmitter; events: AuditInput[] } {
  const events: AuditInput[] = [];
  const target: AuditEmitTarget = {
    emit: (input) => {
      events.push(input);
    },
  };
  return { emitter: AuditEmitter.withSession(target, "run-1"), events };
}

const LINE_SPEC: ChartSpecData = {
  kind: "line",
  title: "Funding by Year",
  series: [{ name: "USD (M)", values: [1, 3, 7] }],
  labels: ["2021", "2022", "2023"],
  xLabel: "Year",
  yLabel: "Funding",
};

beforeEach(() => {
  __resetPythonEnvForTest();
});

describe("buildChartCode", () => {
  it("references the spec's title/series and the Agg save-to-base64 PNG path", () => {
    const code = buildChartCode(LINE_SPEC);
    expect(code).toContain('_spec["series"]');
    expect(code).toContain('_spec["title"]');
    expect(code).toContain("ax.set_title");
    // Agg-compatible save → base64 image/png rich output.
    expect(code).toContain('fig.savefig(_buf, format="png"');
    expect(code).toContain("base64.b64decode");
    expect(code).toContain('format="png"');
  });

  it("selects the plotting call from the chart kind", () => {
    expect(buildChartCode({ ...LINE_SPEC, kind: "line" })).toContain(
      "ax.plot(",
    );
    expect(buildChartCode({ ...LINE_SPEC, kind: "bar" })).toContain("ax.bar(");
    expect(buildChartCode({ ...LINE_SPEC, kind: "scatter" })).toContain(
      "ax.scatter(",
    );
    expect(
      buildChartCode({
        kind: "pie",
        title: "Share",
        series: [{ values: [1, 2, 3] }],
        labels: ["a", "b", "c"],
      }),
    ).toContain("ax.pie(");
  });

  it("embeds the spec as a base64 literal, never interpolated (injection-safe)", () => {
    // A title carrying Python-breakout characters: it must ride in base64, so the
    // raw payload can never appear verbatim in the generated snippet.
    const breakout = '"); danger_call(); #';
    const hostile: ChartSpecData = {
      kind: "bar",
      title: breakout,
      series: [{ values: [1] }],
    };
    const code = buildChartCode(hostile);
    expect(code).not.toContain(breakout);
    expect(code).not.toContain("danger_call");
    expect(code).toContain("base64.b64decode");
  });
});

describe("buildSvgToPngCode", () => {
  it("rasterizes via cairosvg with an svglib fallback, emitting a PNG result", () => {
    const code = buildSvgToPngCode("<svg/>");
    expect(code).toContain("import cairosvg");
    expect(code).toContain("svglib");
    expect(code).toContain('display(Image(data=_png, format="png"))');
    // SVG rides in base64-encoded, never interpolated.
    expect(code).toContain("base64.b64decode");
    expect(code).not.toContain("<svg/>");
  });
});

describe("ChartSpec schema", () => {
  it("accepts a valid spec", () => {
    expect(ChartSpec.safeParse(LINE_SPEC).success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(ChartSpec.safeParse({ ...LINE_SPEC, kind: "donut" }).success).toBe(
      false,
    );
  });

  it("rejects a missing/empty title", () => {
    expect(
      ChartSpec.safeParse({ kind: "bar", series: [{ values: [1] }] }).success,
    ).toBe(false);
    expect(ChartSpec.safeParse({ ...LINE_SPEC, title: "" }).success).toBe(
      false,
    );
  });
});

describe("renderChartPng", () => {
  it("decodes the PNG, writes it under /brain/reports/assets, and returns bytes+path", async () => {
    const { interp } = fakeInterp();
    const { writer, writes, mkdirs } = spyWriter();
    const { emitter, events } = spyEmitter();
    const ctx = makeCtx();

    const { pngBytes, path } = await renderChartPng(interp, ctx, LINE_SPEC, {
      writer,
      emitter,
    });

    // Bytes decoded from the rich image/png output.
    expect(Array.from(pngBytes)).toEqual(Array.from(KNOWN_BYTES));

    // Persisted via the binary writeFile wrapper at a reports/assets PNG path.
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(path);
    expect(path.startsWith(`${REPORT_ASSETS_DIR}/`)).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(Array.from(writes[0].bytes)).toEqual(Array.from(KNOWN_BYTES));

    // Assets dir ensured before the write.
    expect(mkdirs).toContain(REPORT_ASSETS_DIR);

    // Exactly one chart.rendered audit event.
    const chartEvents = events.filter((e) => e.type === "chart.rendered");
    expect(chartEvents).toHaveLength(1);
    expect(chartEvents[0].payload).toMatchObject({ path });
  });

  it("works without an emitter (usable outside a loop)", async () => {
    const { interp } = fakeInterp();
    const { writer, writes } = spyWriter();
    const { path } = await renderChartPng(interp, makeCtx(), LINE_SPEC, {
      writer,
    });
    expect(writes).toHaveLength(1);
    expect(path.endsWith(".png")).toBe(true);
  });

  it("throws a ReportError when the cell yields no PNG output", async () => {
    const interp: CodeRunner = {
      runCode: async () => ({
        stdout: "",
        stderr: "",
        error: null,
        results: [{ text: "no image here" }],
      }),
    };
    const { writer } = spyWriter();
    await expect(
      renderChartPng(interp, makeCtx(), LINE_SPEC, { writer }),
    ).rejects.toThrow(/no PNG/);
  });
});
