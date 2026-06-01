import { forwardRef, type HTMLAttributes } from "react";
import styles from "./Spinner.module.css";
import { cx } from "./utils";

type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Size token. Default `md`. */
  size?: SpinnerSize;
  /** Accessible label announced to assistive tech. Default `"Loading"`. */
  label?: string;
}

/** Spinner - an indeterminate loading indicator. Color/size from tokens. */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(
  function Spinner(
    { size = "md", label = "Loading", className, ...rest },
    ref,
  ) {
    return (
      <span
        ref={ref}
        role="status"
        aria-live="polite"
        aria-label={label}
        className={cx(styles.spinner, styles[size], className)}
        {...rest}
      />
    );
  },
);
