import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../Button";
import { Modal } from "../Modal";

describe("Modal", () => {
  it("exposes a dialog with aria-modal and the title as its label", () => {
    render(
      <Modal open onClose={() => {}} title="Confirm">
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Confirm");
  });

  it("moves focus into the dialog when opened", async () => {
    render(
      <Modal open onClose={() => {}} title="Focus">
        <Button>Inside</Button>
      </Modal>,
    );
    // With no text field, focus lands on the first focusable element / container.
    expect(document.activeElement).not.toBe(document.body);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Esc">
        <p>Body</p>
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hidden">
        <p>Body</p>
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // jsdom does no layout, so every element reports `offsetParent === null` and the
  // focus trap can't tell the ✕ button apart from a text field. Stub it to mirror
  // a real browser, where the close button precedes the input in DOM order.
  describe("text-input focus", () => {
    let original: PropertyDescriptor | undefined;

    beforeEach(() => {
      original = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "offsetParent",
      );
      Object.defineProperty(HTMLElement.prototype, "offsetParent", {
        configurable: true,
        get() {
          return this.parentNode;
        },
      });
    });

    afterEach(() => {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, "offsetParent", original);
      }
    });

    it("focuses the first text input on open, not the close button", () => {
      render(
        <Modal open onClose={() => {}} title="New group">
          <input aria-label="Group name" />
        </Modal>,
      );
      expect(document.activeElement).toBe(screen.getByLabelText("Group name"));
    });

    it("honors an explicit data-autofocus target", () => {
      render(
        <Modal open onClose={() => {}} title="New group">
          <input aria-label="First" />
          <input aria-label="Second" data-autofocus />
        </Modal>,
      );
      expect(document.activeElement).toBe(screen.getByLabelText("Second"));
    });

    it("keeps focus in the input while typing as the parent re-renders", async () => {
      function Harness() {
        // Inline `onClose` => a new identity every render: the focus trap must
        // not re-run and steal the caret on each keystroke.
        const [value, setValue] = useState("");
        return (
          <Modal open onClose={() => {}} title="New group">
            <input
              aria-label="Group name"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Modal>
        );
      }
      render(<Harness />);
      const input = screen.getByLabelText<HTMLInputElement>("Group name");
      expect(document.activeElement).toBe(input);
      await userEvent.type(input, "Real estate");
      expect(input).toHaveValue("Real estate");
      expect(document.activeElement).toBe(input);
    });
  });
});
