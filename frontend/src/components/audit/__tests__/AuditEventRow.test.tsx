import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@/api/audit";
import { AuditEventRow } from "../AuditEventRow";

const event: AuditEvent = {
  seq: 5,
  ts: new Date().toISOString(),
  type: "tool.ran",
  level: "info",
  sessionId: "session-1",
  summary: "Ran the funding scraper",
  detail: {
    command: "python scrape.py --since 7d",
    code: "print('hello')",
    reasoning: "Needed fresh funding rounds since the last run.",
    output: "Found 3 new rounds",
  },
};

/** Render a row inside a router (the row may emit a react-router <Link>). */
function renderRow(props: {
  event: AuditEvent;
  showDetail: boolean;
  agentId?: string;
}) {
  return render(
    <MemoryRouter>
      <AuditEventRow
        event={props.event}
        agentId={props.agentId ?? "a1"}
        showDetail={props.showDetail}
      />
    </MemoryRouter>,
  );
}

describe("AuditEventRow", () => {
  it("milestone (calm) mode shows only the summary, never the raw detail", () => {
    renderRow({ event, showDetail: false });

    expect(screen.getByText("Ran the funding scraper")).toBeInTheDocument();
    // No disclosure control and no raw command in the calm view.
    expect(screen.queryByRole("button", { name: /show work/i })).toBeNull();
    expect(screen.queryByText("python scrape.py --since 7d")).toBeNull();
  });

  it("'show the work' mode reveals the expandable command/code/reasoning", async () => {
    renderRow({ event, showDetail: true });

    // Collapsed by default - the raw detail appears only after expanding.
    expect(screen.queryByText("python scrape.py --since 7d")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /show work/i }));

    expect(screen.getByText("python scrape.py --since 7d")).toBeInTheDocument();
    expect(screen.getByText("print('hello')")).toBeInTheDocument();
    expect(
      screen.getByText(/needed fresh funding rounds/i),
    ).toBeInTheDocument();
  });

  it("offers no disclosure in 'show the work' when an event carries no detail", () => {
    const bare: AuditEvent = {
      seq: 6,
      ts: new Date().toISOString(),
      type: "memory.wrote",
      level: "milestone",
      sessionId: "session-1",
      summary: "Wrote a memory",
    };
    renderRow({ event: bare, showDetail: true });

    expect(screen.getByText("Wrote a memory")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show work/i })).toBeNull();
  });

  it("exposes metadata-only payloads (e.g. a scheduled run's kind) in the disclosure", async () => {
    const scheduled: AuditEvent = {
      seq: 7,
      ts: new Date().toISOString(),
      type: "session.completed",
      level: "milestone",
      sessionId: "scheduled:report:1",
      summary: "Scheduled report run complete",
      detail: { kind: "report" },
    };
    renderRow({ event: scheduled, showDetail: true });

    await userEvent.click(screen.getByRole("button", { name: /show work/i }));

    // The generic key/value list humanizes the key and shows the value.
    expect(screen.getByText("Kind")).toBeInTheDocument();
    expect(screen.getByText("report")).toBeInTheDocument();
  });

  it("links to the report and renders the delta for a report.generated event", async () => {
    const reportEvent: AuditEvent = {
      seq: 8,
      ts: new Date().toISOString(),
      type: "report.generated",
      level: "milestone",
      sessionId: "scheduled:report:1",
      summary: "Generated report: Q2 Funding - 3 new facts, 1 changed",
      detail: {
        title: "Q2 Funding",
        reportId: "rep-123",
        brainPath: "/brain/reports/q2.md",
        r2Key: null,
        delta: {
          headline: "3 new facts, 1 changed",
          added: 3,
          changed: 1,
          removed: 0,
        },
      },
    };
    // The "View report" deep-link shows at the calm altitude too.
    renderRow({ event: reportEvent, showDetail: false });

    const link = screen.getByRole("link", { name: /view report/i });
    expect(link).toHaveAttribute("href", "/agents/a1/reports?report=rep-123");
  });

  it("shows the delta and structured details when a report event is expanded", async () => {
    const reportEvent: AuditEvent = {
      seq: 9,
      ts: new Date().toISOString(),
      type: "report.generated",
      level: "milestone",
      sessionId: "scheduled:report:1",
      summary: "Generated report: Q2 Funding",
      detail: {
        title: "Q2 Funding",
        reportId: "rep-123",
        brainPath: "/brain/reports/q2.md",
        r2Key: null,
        delta: {
          headline: "3 new facts, 1 changed",
          added: 3,
          changed: 1,
          removed: 0,
        },
      },
    };
    renderRow({ event: reportEvent, showDetail: true });

    await userEvent.click(screen.getByRole("button", { name: /show work/i }));

    // Delta block: headline + counts.
    expect(screen.getByText("3 new facts, 1 changed")).toBeInTheDocument();
    expect(screen.getByText("+3 added")).toBeInTheDocument();
    expect(screen.getByText("~1 changed")).toBeInTheDocument();
    // Generic details: title + brain path surfaced; the null r2Key is omitted.
    expect(screen.getByText("Brain path")).toBeInTheDocument();
    expect(screen.getByText("/brain/reports/q2.md")).toBeInTheDocument();
    expect(screen.queryByText("R2 key")).toBeNull();
    // reportId is not duplicated as a detail row (it drives the link).
    expect(screen.queryByText("Report id")).toBeNull();
  });
});
