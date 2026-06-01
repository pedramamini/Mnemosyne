import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReport,
  listReports,
  type Report,
  type ReportMeta,
  type ReportSearchHit,
  searchReports,
} from "@/api/reports";
import { restoreMatchMedia, stubMatchMedia } from "@/test/matchMedia";
import { ReportsTab } from "../ReportsTab";

// Mock the data layer; the hooks call these directly.
vi.mock("@/api/reports", () => ({
  listReports: vi.fn(),
  getReport: vi.fn(),
  searchReports: vi.fn(),
  reportAssetUrl: vi.fn(),
}));

const mockList = vi.mocked(listReports);
const mockGet = vi.mocked(getReport);
const mockSearch = vi.mocked(searchReports);

const now = new Date().toISOString();

const metas: ReportMeta[] = [
  { id: "r1", title: "Q2 Review", createdAt: now, frontMatter: {} },
  { id: "r2", title: "Q1 Review", createdAt: now, frontMatter: {} },
];

const ASSET_URL = "https://cdn.example/agents/a1/reports/r1/chart.png";

function reportFor(id: string): Report {
  const title = id === "r1" ? "Q2 Review" : "Q1 Review";
  return {
    id,
    title,
    markdown: `Body of ${title}.\n\n![chart](chart.png)`,
    frontMatter: { title, tags: ["funding"] },
    assets: [{ name: "chart.png", url: ASSET_URL }],
    createdAt: now,
  };
}

const hit: ReportSearchHit = {
  id: "r2",
  title: "Q1 Review",
  snippet: "…matched funding text…",
  createdAt: now,
};

describe("ReportsTab", () => {
  beforeEach(() => {
    mockList.mockReset().mockResolvedValue(metas);
    mockGet
      .mockReset()
      .mockImplementation((_a, id) => Promise.resolve(reportFor(id)));
    mockSearch.mockReset().mockResolvedValue([hit]);
  });

  afterEach(() => {
    restoreMatchMedia();
  });

  it("renders the report list", async () => {
    render(<ReportsTab agentId="a1" />);

    expect(await screen.findByText("Q2 Review")).toBeInTheDocument();
    expect(screen.getByText("Q1 Review")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith("a1");
  });

  it("opens a report with its front-matter header, body, and resolved PNG", async () => {
    render(<ReportsTab agentId="a1" />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Q2 Review/ }),
    );

    expect(mockGet).toHaveBeenCalledWith("a1", "r1");
    // Front-matter header (Heading) + the rendered body.
    expect(
      await screen.findByRole("heading", { name: "Q2 Review" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Body of Q2 Review.")).toBeInTheDocument();
    // The relative chart ref resolves to the asset URL.
    expect(screen.getByRole("img", { name: "chart" })).toHaveAttribute(
      "src",
      ASSET_URL,
    );
  });

  it("on a mobile viewport renders the report list first, not the viewer", async () => {
    stubMatchMedia(true);
    render(<ReportsTab agentId="a1" />);

    // The master (list) is shown; the detail (viewer) is not yet mounted, so its
    // "Select a report" empty-state prompt is absent.
    expect(await screen.findByText("Q2 Review")).toBeInTheDocument();
    expect(screen.queryByText("Select a report")).toBeNull();
  });

  it("switches the list to search hits and opens a selected hit", async () => {
    render(<ReportsTab agentId="a1" />);
    await screen.findByText("Q2 Review");

    await userEvent.type(screen.getByRole("searchbox"), "funding");

    // After the debounce settles, the search hit's snippet appears.
    expect(
      await screen.findByText("…matched funding text…"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith("a1", "funding"),
    );

    await userEvent.click(screen.getByRole("button", { name: /Q1 Review/ }));

    expect(mockGet).toHaveBeenCalledWith("a1", "r2");
    expect(
      await screen.findByRole("heading", { name: "Q1 Review" }),
    ).toBeInTheDocument();
  });
});
