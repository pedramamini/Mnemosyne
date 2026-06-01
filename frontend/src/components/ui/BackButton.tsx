import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button, type ButtonSize } from "./Button";
import { Icon } from "./Icon";
import { Inline } from "./Inline";

export interface BackButtonProps {
  /** Fired when the control is activated (navigate back, close, cancel a flow). */
  onClick: () => void;
  /** Label text. Default `"Back"` - pass `"Cancel"` for a flow-exit affordance. */
  children?: ReactNode;
  /** Button size. Default `"sm"`; use `"md"` for a page-level header action. */
  size?: ButtonSize;
  /**
   * Which edge of its row the control hugs. `"start"` (default) is the
   * conventional back/return position; `"end"` right-aligns it to the content
   * edge - use for a wizard/flow "Cancel" that mirrors the trailing primary action.
   */
  align?: "start" | "end";
  /** Forwarded to the row wrapper (e.g. a spacing utility class). */
  className?: string;
}

/**
 * BackButton - the canonical "back / cancel" header affordance: a ghost
 * {@link Button} with a leading back-arrow, wrapped in an {@link Inline} so it
 * NEVER stretches to its container's width. (A bare Button dropped into an
 * `align="stretch"` Stack spans the full row and centers its own label, which
 * reads as a floating, misplaced control.)
 *
 * Having a single component means placement, sizing, icon, and behavior for
 * every "go back / cancel" header stay identical across the app and can be
 * changed in exactly one place. `align` is the one deliberate per-use choice:
 * leave it `"start"` for a true back/return; use `"end"` for a flow Cancel.
 */
export function BackButton({
  onClick,
  children = "Back",
  size = "sm",
  align = "start",
  className,
}: BackButtonProps) {
  return (
    <Inline justify={align} wrap={false} className={className}>
      <Button
        variant="ghost"
        size={size}
        leftIcon={<Icon icon={ArrowLeft} size="sm" />}
        onClick={onClick}
      >
        {children}
      </Button>
    </Inline>
  );
}
