import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BackButton } from "../BackButton";

describe("BackButton", () => {
  it("defaults its label to 'Back' and fires onClick", async () => {
    const onClick = vi.fn();
    render(<BackButton onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "Back" });
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a custom label (e.g. a flow 'Cancel') as the accessible name", () => {
    render(<BackButton onClick={() => {}}>Cancel</BackButton>);
    // The leading back-arrow is decorative (aria-hidden), so the name is the text.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("uses the ghost button variant (no raw inline styling)", () => {
    render(<BackButton onClick={() => {}}>Back</BackButton>);
    const btn = screen.getByRole("button", { name: "Back" });
    expect(btn.dataset.variant).toBe("ghost");
  });

  it("right-aligns its row when align='end' (token-driven, not full-width stretch)", () => {
    const { container } = render(
      <BackButton align="end" onClick={() => {}}>
        Cancel
      </BackButton>,
    );
    // The Inline wrapper hugs the content edge instead of letting the ghost
    // button span (and center within) the full container width.
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.justifyContent).toBe("flex-end");
  });
});
