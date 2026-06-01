import { forwardRef, type HTMLAttributes } from "react";
import styles from "./Divider.module.css";
import { cx } from "./utils";

export interface DividerProps extends HTMLAttributes<HTMLHRElement> {
  /** Orientation of the rule. Default `horizontal`. */
  orientation?: "horizontal" | "vertical";
}

/**
 * Divider - a token-colored separator line (horizontal or vertical). Renders a
 * native `<hr>` so it carries the implicit `separator` role without extra ARIA.
 */
export const Divider = forwardRef<HTMLHRElement, DividerProps>(function Divider(
  { orientation = "horizontal", className, ...rest },
  ref,
) {
  return (
    <hr
      ref={ref}
      aria-orientation={orientation}
      className={cx(
        orientation === "vertical" ? styles.vertical : styles.horizontal,
        className,
      )}
      {...rest}
    />
  );
});
