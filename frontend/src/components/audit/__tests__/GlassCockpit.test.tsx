import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "@/api/audit";
import { searchAudit } from "@/api/audit";
import { GlassCockpit } from "../GlassCockpit";
import { useAuditStream } from "../useAuditStream";

// The stream hook is mocked so the cockpit renders from a controlled event set;
// only `searchAudit` is overridden on the otherwise-real audit module.
vi.mock("../useAuditStream", () => ({ useAuditStream: vi.fn() }));
vi.mock("@/api/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/audit")>();
  return { ...actual, searchAudit: vi.fn() };
});

const mockUse = vi.mocked(useAuditStream);
const mockSearch = vi.mocked(searchAudit);

const milestoneEvent: AuditEvent = {
  seq: 1,
  ts: new Date().toISOString(),
  type: "memory.wrote",
  level: "milestone",
  sessionId: "s1",
  summary: "Wrote a memory about Acme",
  detail: { command: "echo hi", reasoning: "because it mattered" },
};

beforeEach(() => {
  mockUse.mockReturnValue({
    events: [milestoneEvent],
    status: "live",
    loadOlder: vi.fn(),
    hasOlder: false,
    loadingOlder: false,
    loading: false,
  });
  mockSearch.mockReset();
});

describe("GlassCockpit", () => {
  it("renders milestone events in the calm view (no raw detail)", () => {
    render(<GlassCockpit agentId="a1" />);

    expect(screen.getByText("Wrote a memory about Acme")).toBeInTheDocument();
    // Calm by default: no "show the work" disclosure.
    expect(screen.queryByRole("button", { name: /show work/i })).toBeNull();
  });

  it("reveals detail after flipping the altitude toggle to Show the work", async () => {
    render(<GlassCockpit agentId="a1" />);

    await userEvent.click(
      screen.getByRole("radio", { name: /show the work/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /show work/i }),
    );

    expect(screen.getByText("echo hi")).toBeInTheDocument();
  });

  it("switches to search results when typing in the search box", async () => {
    mockSearch.mockResolvedValue([
      {
        seq: 9,
        ts: new Date().toISOString(),
        type: "source.read",
        level: "milestone",
        sessionId: "s1",
        summary: "Found a funding article",
      },
    ]);

    render(<GlassCockpit agentId="a1" />);

    await userEvent.type(
      screen.getByRole("searchbox", { name: /search audit log/i }),
      "funding",
    );

    expect(
      await screen.findByText("Found a funding article"),
    ).toBeInTheDocument();
    expect(mockSearch).toHaveBeenCalledWith("a1", "funding");
  });
});
