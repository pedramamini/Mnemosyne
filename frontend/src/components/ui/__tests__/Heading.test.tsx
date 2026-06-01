import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Heading } from "../Heading";

describe("Heading", () => {
  it("renders the semantic level and text", () => {
    render(<Heading level={1}>Organizations</Heading>);
    const h = screen.getByRole("heading", { level: 1, name: "Organizations" });
    expect(h.tagName).toBe("H1");
  });

  it("applies an extra class for the display variant", () => {
    const { rerender } = render(<Heading level={1}>Feed</Heading>);
    const base = screen.getByRole("heading", { name: "Feed" }).className;

    rerender(
      <Heading level={1} variant="display">
        Feed
      </Heading>,
    );
    const display = screen.getByRole("heading", { name: "Feed" }).className;

    // The display variant layers an additional (uppercase + mono) class on top
    // of the base heading class.
    expect(display).not.toBe(base);
    expect(display.split(/\s+/).length).toBeGreaterThan(
      base.split(/\s+/).length,
    );
  });
});
