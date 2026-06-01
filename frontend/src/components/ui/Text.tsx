import {
  type CSSProperties,
  type ElementType,
  forwardRef,
  type HTMLAttributes,
} from "react";
import type { FontWeight, TextScale } from "@/styles/tokens";
import styles from "./Text.module.css";
import { cx } from "./utils";

/** Color roles a Text may adopt (subset of the semantic palette). */
type TextColor =
  | "text"
  | "text-muted"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "inherit";

export interface TextProps extends HTMLAttributes<HTMLElement> {
  /** Element to render. Default `span`. */
  as?: ElementType;
  /** Type-scale size token. Default `md`. */
  size?: TextScale;
  /** Font-weight token. Default `regular`. */
  weight?: FontWeight;
  /** Semantic color role. Default `text`. */
  color?: TextColor;
  /** Truncate to a single line with an ellipsis. */
  truncate?: boolean;
  /** Render in the monospace token family. */
  mono?: boolean;
}

/** Text - body/inline typography. Every size and color comes from a token. */
export const Text = forwardRef<HTMLElement, TextProps>(function Text(
  {
    as: Component = "span",
    size = "md",
    weight = "regular",
    color = "text",
    truncate,
    mono,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const mergedStyle: CSSProperties = {
    fontSize: `var(--text-${size})`,
    fontWeight: `var(--font-weight-${weight})`,
    fontFamily: mono ? "var(--font-mono)" : undefined,
    color: color === "inherit" ? "inherit" : `var(--color-${color})`,
    ...style,
  };
  return (
    <Component
      ref={ref}
      className={cx(styles.text, truncate && styles.truncate, className)}
      style={mergedStyle}
      {...rest}
    >
      {children}
    </Component>
  );
});
