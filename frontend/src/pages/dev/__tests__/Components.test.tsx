import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { Components } from "../Components";

describe("Component catalog", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders every component group without crashing", () => {
    render(
      <ToastProvider>
        <Components />
      </ToastProvider>,
    );
    // Mounting the whole catalog exercises every primitive at once.
    expect(
      screen.getByRole("heading", { name: "Component Catalog" }),
    ).toBeInTheDocument();
    for (const group of [
      "Typography",
      "Buttons & Icons",
      "Form controls",
      "Overlays & feedback",
      "Status & data display",
      "Application shell",
    ]) {
      expect(screen.getByRole("heading", { name: group })).toBeInTheDocument();
    }
  });

  it("toggles the theme purely by flipping [data-theme] (token reskin)", () => {
    render(
      <ToastProvider>
        <Components />
      </ToastProvider>,
    );
    // The catalog sets the light theme on mount; the toggle only swaps the
    // data-theme attribute - components reskin via tokens, no remount needed.
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: /Theme:/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
