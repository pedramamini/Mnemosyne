import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReportAsset } from "@/api/reports";
import { MarkdownRenderer } from "../MarkdownRenderer";

const assets: ReportAsset[] = [
  { name: "foo.png", url: "https://cdn.example/agents/a1/reports/r1/foo.png" },
];

describe("MarkdownRenderer", () => {
  it("renders GFM markdown - heading, list, and table", () => {
    const md = [
      "# Quarterly Review",
      "",
      "- first point",
      "- second point",
      "",
      "| Metric | Value |",
      "| --- | --- |",
      "| ARR | $10M |",
    ].join("\n");

    render(<MarkdownRenderer markdown={md} />);

    expect(
      screen.getByRole("heading", { name: "Quarterly Review" }),
    ).toBeInTheDocument();
    expect(screen.getByText("first point")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    // Header cell + body cell from the GFM table.
    expect(
      screen.getByRole("columnheader", { name: "Metric" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "$10M" })).toBeInTheDocument();
  });

  it("resolves a relative image source to the matching asset URL", () => {
    render(
      <MarkdownRenderer markdown="![chart](charts/foo.png)" assets={assets} />,
    );

    const img = screen.getByRole("img", { name: "chart" });
    expect(img).toHaveAttribute("src", assets[0].url);
  });

  it("resolves an Obsidian-style ![[embed]] against the asset list", () => {
    render(<MarkdownRenderer markdown="![[foo.png]]" assets={assets} />);

    const img = screen.getByRole("img", { name: "foo.png" });
    expect(img).toHaveAttribute("src", assets[0].url);
  });

  it("leaves an external https image source as-is", () => {
    const ext = "https://other.example/remote.png";
    render(<MarkdownRenderer markdown={`![remote](${ext})`} assets={assets} />);

    expect(screen.getByRole("img", { name: "remote" })).toHaveAttribute(
      "src",
      ext,
    );
  });

  it("sanitizes raw <script> in the markdown away", () => {
    const { container } = render(
      <MarkdownRenderer markdown={"Hi\n\n<script>window.x = 1</script>"} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("Hi")).toBeInTheDocument();
  });
});
