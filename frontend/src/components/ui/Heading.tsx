import { type CSSProperties, forwardRef, type HTMLAttributes } from "react";
import type { TextScale } from "@/styles/tokens";
import styles from "./Heading.module.css";
import { cx } from "./utils";

type Level = 1 | 2 | 3 | 4;

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Semantic heading level (h1–h4). Default `2`. */
  level?: Level;
  /** Override the visual size token independent of the semantic level. */
  size?: TextScale;
  /**
   * `"display"` renders the page-title look: all-caps in the fixed-width
   * (`--font-mono`) family, so it tracks the active font theme. Reserve it for
   * section/page titles - not proper nouns (e.g. an agent's name).
   */
  variant?: "default" | "display";
}

/** Default type-scale mapping per heading level. */
const LEVEL_SIZE: Record<Level, TextScale> = {
  1: "3xl",
  2: "2xl",
  3: "xl",
  4: "lg",
};

/** The display variant runs a notch larger so page titles read big + bold. */
const DISPLAY_SIZE: Record<Level, TextScale> = {
  1: "4xl",
  2: "3xl",
  3: "2xl",
  4: "xl",
};

/** Heading - semantic h1–h4 mapped onto the type scale. Sizes from tokens. */
export const Heading = forwardRef<HTMLHeadingElement, HeadingProps>(
  function Heading(
    {
      level = 2,
      size,
      variant = "default",
      className,
      style,
      children,
      ...rest
    },
    ref,
  ) {
    const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
    const sizeKey =
      size ?? (variant === "display" ? DISPLAY_SIZE[level] : LEVEL_SIZE[level]);
    const mergedStyle: CSSProperties = {
      fontSize: `var(--text-${sizeKey})`,
      ...style,
    };
    return (
      <Tag
        ref={ref}
        className={cx(
          styles.heading,
          variant === "display" && styles.display,
          className,
        )}
        style={mergedStyle}
        {...rest}
      >
        {children}
      </Tag>
    );
  },
);
