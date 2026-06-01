import {
  cloneElement,
  isValidElement,
  type ReactNode,
  useId,
  useState,
} from "react";
import styles from "./Tooltip.module.css";
import { cx } from "./utils";

type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  /** Tooltip text/content. */
  content: ReactNode;
  side?: TooltipSide;
  /** Single trigger element (must forward props/ref). */
  children: ReactNode;
}

/**
 * Tooltip - shows `content` on hover/focus of its child and links it via
 * `aria-describedby`. CSS positions the bubble using z-index + spacing tokens.
 */
export function Tooltip({ content, side = "top", children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  const triggerProps = {
    "aria-describedby": open ? id : undefined,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  };

  const trigger = isValidElement(children) ? (
    cloneElement(children, triggerProps as Record<string, unknown>)
  ) : (
    <span {...triggerProps}>{children}</span>
  );

  return (
    <span className={styles.wrapper}>
      {trigger}
      <span
        role="tooltip"
        id={id}
        className={cx(styles.bubble, styles[side], open && styles.visible)}
        aria-hidden={!open}
      >
        {content}
      </span>
    </span>
  );
}
