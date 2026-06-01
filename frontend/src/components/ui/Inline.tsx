import { type CSSProperties, forwardRef, type HTMLAttributes } from "react";
import type { SpaceScale } from "@/styles/tokens";
import styles from "./Inline.module.css";
import { cx, type SpacingProps, space, spacingStyle } from "./utils";

type Align = "start" | "center" | "end" | "stretch" | "baseline";
type Justify = "start" | "center" | "end" | "between" | "around";

export interface InlineProps
  extends HTMLAttributes<HTMLDivElement>,
    SpacingProps {
  /** Gap between children, from the spacing scale. Default `2`. */
  gap?: SpaceScale;
  align?: Align;
  justify?: Justify;
  /** Wrap children onto multiple lines. Default `true`. */
  wrap?: boolean;
}

const ALIGN: Record<Align, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};
const JUSTIFY: Record<Justify, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
};

/** Inline - horizontal flex layout with token-driven `gap`. */
export const Inline = forwardRef<HTMLDivElement, InlineProps>(function Inline(
  {
    gap = "2",
    align = "center",
    justify = "start",
    wrap = true,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const { p, px, py, pt, pr, pb, pl, m, mx, my, mt, mr, mb, ml, ...domProps } =
    rest;
  const mergedStyle: CSSProperties = {
    gap: space(gap),
    alignItems: ALIGN[align],
    justifyContent: JUSTIFY[justify],
    flexWrap: wrap ? "wrap" : "nowrap",
    ...spacingStyle({ p, px, py, pt, pr, pb, pl, m, mx, my, mt, mr, mb, ml }),
    ...style,
  };
  return (
    <div
      ref={ref}
      className={cx(styles.inline, className)}
      style={mergedStyle}
      {...domProps}
    >
      {children}
    </div>
  );
});
