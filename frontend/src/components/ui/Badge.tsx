import { forwardRef, type HTMLAttributes } from "react";
import styles from "./Badge.module.css";
import { cx } from "./utils";

export type BadgeVariant =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Subtle (tinted) vs solid fill. Default `subtle`. */
  appearance?: "subtle" | "solid";
  size?: "sm" | "md";
}

/** Badge / Tag - a compact status pill. Colors from semantic tokens. */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  {
    variant = "neutral",
    appearance = "subtle",
    size = "md",
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cx(
        styles.badge,
        styles[variant],
        styles[appearance],
        styles[size],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
});

/** Tag - alias of Badge. */
export const Tag = Badge;
export type TagProps = BadgeProps;
