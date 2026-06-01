import { type CSSProperties, forwardRef, type HTMLAttributes } from "react";
import type { Radius } from "@/styles/tokens";
import styles from "./Skeleton.module.css";
import { cx } from "./utils";

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** CSS width (e.g. `"100%"`, `"8rem"`). */
  width?: string | number;
  /** CSS height (e.g. `"1rem"`). Default `"1em"`. */
  height?: string | number;
  /** Corner radius token. Default `sm`. */
  radius?: Radius;
  /** Render as a circle (overrides radius). */
  circle?: boolean;
}

/** Skeleton - a token-styled shimmering placeholder for loading content. */
export const Skeleton = forwardRef<HTMLSpanElement, SkeletonProps>(
  function Skeleton(
    { width, height = "1em", radius = "sm", circle, className, style, ...rest },
    ref,
  ) {
    const mergedStyle: CSSProperties = {
      width,
      height,
      borderRadius: circle ? "var(--radius-full)" : `var(--radius-${radius})`,
      ...style,
    };
    return (
      <span
        ref={ref}
        aria-hidden="true"
        className={cx(styles.skeleton, className)}
        style={mergedStyle}
        {...rest}
      />
    );
  },
);
