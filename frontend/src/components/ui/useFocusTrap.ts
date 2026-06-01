import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/** A field that accepts typed text (so it should win initial focus over buttons). */
function isTextField(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const nonText = new Set([
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "file",
      "range",
      "color",
      "image",
      "hidden",
    ]);
    return !nonText.has(el.type);
  }
  return el.isContentEditable;
}

/**
 * The element to focus when the trap activates. A caller may mark an explicit
 * target with `data-autofocus`; otherwise we prefer the first text field (so
 * opening a dialog with a form lands the caret in it, not on the ✕ button), then
 * fall back to the first focusable element, then the container itself.
 */
function getInitialFocus(container: HTMLElement): HTMLElement {
  const explicit = container.querySelector<HTMLElement>("[data-autofocus]");
  if (explicit) return explicit;
  const focusable = getFocusable(container);
  return focusable.find(isTextField) ?? focusable[0] ?? container;
}

/**
 * Trap keyboard focus inside `containerRef` while `active`, call `onEscape` on
 * Escape, and restore focus to the previously-focused element on deactivation.
 * Shared by Modal and Drawer.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  // Read `onEscape` through a ref so a fresh closure each render (callers almost
  // always pass an inline `onClose`) does NOT re-run the effect. Re-running it
  // would re-focus the initial element on every keystroke, stealing the caret
  // out of whatever input the user is typing in.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    getInitialFocus(container).focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable(container as HTMLElement);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      if (event.shiftKey && activeEl === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active, containerRef]);
}
