import { forwardRef, type HTMLAttributes } from "react";
import styles from "./ProgressBar.module.css";
import { cx } from "./utils";

export interface ProgressBarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  /** Current value. Omit for an indeterminate bar. */
  value?: number;
  /** Maximum value. Default `100`. */
  max?: number;
  variant?: "primary" | "success" | "warning" | "danger";
  size?: "sm" | "md";
  /** Accessible label for the progress region. */
  label?: string;
}

/** ProgressBar - determinate or indeterminate progress. Colors from tokens. */
export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  function ProgressBar(
    {
      value,
      max = 100,
      variant = "primary",
      size = "md",
      label,
      className,
      ...rest
    },
    ref,
  ) {
    const indeterminate = value === undefined;
    const pct = indeterminate
      ? 0
      : Math.min(100, Math.max(0, (value / max) * 100));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-label={label}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : max}
        aria-valuenow={indeterminate ? undefined : value}
        className={cx(styles.track, styles[size], className)}
        {...rest}
      >
        <div
          className={cx(
            styles.fill,
            styles[variant],
            indeterminate && styles.indeterminate,
          )}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    );
  },
);
