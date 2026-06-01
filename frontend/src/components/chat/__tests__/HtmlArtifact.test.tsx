import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HtmlArtifact } from "../HtmlArtifact";

// HtmlArtifact renders an agent-produced HTML view in a SANDBOXED iframe loaded
// from the (auth-guarded) raw URL, with an expand-to-modal affordance. We assert
// the iframe src + the sandbox hardening, and that expanding opens a dialog.

describe("HtmlArtifact", () => {
  it("renders a sandboxed iframe pointing at the artifact raw URL", () => {
    render(
      <HtmlArtifact agentId="agent-1" artifactId="art-9" title="Acme Board" />,
    );
    const frame = screen.getByTitle("Acme Board") as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toContain(
      "/agents/agent-1/artifacts/art-9/raw",
    );
    // The load-bearing control: scripts may run, but NOT same-origin (opaque origin
    // → no cookies / no parent-DOM access). The backend CSP enforces the rest.
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("shows the artifact title in its header", () => {
    render(
      <HtmlArtifact agentId="a" artifactId="b" title="Quarterly Summary" />,
    );
    expect(screen.getByText("Quarterly Summary")).toBeInTheDocument();
  });

  it("opens an expanded dialog when the expand button is clicked", () => {
    render(<HtmlArtifact agentId="a" artifactId="b" title="Expandable" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand preview" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The dialog frames a second iframe of the same artifact.
    expect(screen.getAllByTitle("Expandable").length).toBe(2);
  });
});
