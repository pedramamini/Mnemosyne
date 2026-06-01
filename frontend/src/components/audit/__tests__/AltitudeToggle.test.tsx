import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AltitudeToggle } from "../AltitudeToggle";

describe("AltitudeToggle", () => {
  it("renders both modes and reflects the controlled value", () => {
    render(<AltitudeToggle value="milestone" onChange={() => {}} />);

    const milestones = screen.getByRole("radio", { name: /milestones/i });
    const showWork = screen.getByRole("radio", { name: /show the work/i });
    expect(milestones).toBeInTheDocument();
    expect(showWork).toBeInTheDocument();
  });

  it("defaults to Milestones (the calm view is the selected value)", () => {
    render(<AltitudeToggle value="milestone" onChange={() => {}} />);

    expect(screen.getByRole("radio", { name: /milestones/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("radio", { name: /show the work/i }),
    ).toHaveAttribute("aria-checked", "false");
    // The milestone helper copy explains the calm mode.
    expect(
      screen.getByText(/calm, plain-english summary/i),
    ).toBeInTheDocument();
  });

  it("calls onChange when switching to Show the work", async () => {
    const onChange = vi.fn();
    render(<AltitudeToggle value="milestone" onChange={onChange} />);

    await userEvent.click(
      screen.getByRole("radio", { name: /show the work/i }),
    );
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it("marks Show the work as selected when that is the value", () => {
    render(<AltitudeToggle value="all" onChange={() => {}} />);

    expect(
      screen.getByRole("radio", { name: /show the work/i }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/everything the agent does/i)).toBeInTheDocument();
  });
});
