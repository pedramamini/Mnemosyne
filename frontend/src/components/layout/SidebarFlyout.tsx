import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Portal } from "@/components/ui";
import styles from "./SidebarFlyout.module.css";

/** Hover/focus handlers handed to the trigger so it can open/close the column. */
export interface FlyoutTriggerProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

export interface SidebarFlyoutProps {
  /** Section label shown as the column header + the nav landmark name. */
  label: string;
  /**
   * Renders the rail trigger, wired with the supplied hover/focus handlers.
   * Spread them onto an interactive element (e.g. a NavItem, which forwards them
   * to its <a>) so the open/close affordance stays keyboard-reachable.
   */
  trigger: (props: FlyoutTriggerProps) => ReactNode;
  /** Column body — the items revealed on hover (e.g. the agent list). */
  children: ReactNode;
}

/** How long the column lingers after the pointer leaves, so it can be crossed. */
const CLOSE_DELAY_MS = 140;

/**
 * SidebarFlyout — the collapsed-rail hover affordance. Hovering (or focusing) a
 * rail trigger slides out a FULL-HEIGHT column flush against the rail's right
 * edge — a continuation of the sidebar (same gradient surface), not a floating
 * popover — listing that section's items. The column is portaled to <body> so it
 * overlays the main content at full height and escapes the rail's `overflow`
 * clipping; the CSS re-applies the sidebar's on-gradient palette so children read
 * light-on-color. A short close delay lets the pointer travel from rail to column.
 */
export function SidebarFlyout({
  label,
  trigger,
  children,
}: SidebarFlyoutProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
  }, []);
  const show = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(
      () => setOpen(false),
      CLOSE_DELAY_MS,
    );
  }, [cancelClose]);

  // Clean up a pending close on unmount; close on Escape while open.
  useEffect(() => cancelClose, [cancelClose]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {trigger({
        onMouseEnter: show,
        onMouseLeave: scheduleClose,
        onFocus: show,
        onBlur: scheduleClose,
      })}
      {open && (
        <Portal>
          <nav
            className={styles.column}
            aria-label={label}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <div className={styles.header}>{label}</div>
            <div className={styles.body}>{children}</div>
          </nav>
        </Portal>
      )}
    </>
  );
}
