import { type CSSProperties, forwardRef, type HTMLAttributes } from "react";
import type { SpaceScale } from "@/styles/tokens";
import styles from "./Stack.module.css";
import { cx, type SpacingProps, space, spacingStyle } from "./utils";

type Align = "start" | "center" | "end" | "stretch";
type Justify = "start" | "center" | "end" | "between" | "around";

export interface StackProps
  extends HTMLAttributes<HTMLDivElement>,
    SpacingProps {
  /** Gap between children, from the spacing scale. Default `4`. */
  gap?: SpaceScale;
  align?: Align;
  justify?: Justify;
  /** Wrap children onto multiple lines. */
  wrap?: boolean;
}

const ALIGN: Record<Align, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
};
const JUSTIFY: Record<Justify, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
};

/** Stack - vertical flex layout with token-driven `gap`. */
export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  {
    gap = "4",
    align = "stretch",
    justify = "start",
    wrap,
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
      className={cx(styles.stack, className)}
      style={mergedStyle}
      {...domProps}
    >
      {children}
    </div>
  );
});
