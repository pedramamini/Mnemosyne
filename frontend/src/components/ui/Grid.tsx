import { type CSSProperties, forwardRef, type HTMLAttributes } from "react";
import type { SpaceScale } from "@/styles/tokens";
import styles from "./Grid.module.css";
import { cx, type SpacingProps, space, spacingStyle } from "./utils";

export interface GridProps
  extends HTMLAttributes<HTMLDivElement>,
    SpacingProps {
  /** Number of equal columns, or a raw `grid-template-columns` string. Default `1`. */
  columns?: number | string;
  /** Gap between cells, from the spacing scale. Default `4`. */
  gap?: SpaceScale;
  /** Minimum column width for an auto-fit responsive grid (overrides `columns`). */
  minColumnWidth?: string;
}

/** Grid - CSS grid layout with token-driven `gap`. */
export const Grid = forwardRef<HTMLDivElement, GridProps>(function Grid(
  {
    columns = 1,
    gap = "4",
    minColumnWidth,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const { p, px, py, pt, pr, pb, pl, m, mx, my, mt, mr, mb, ml, ...domProps } =
    rest;
  const templateColumns = minColumnWidth
    ? `repeat(auto-fit, minmax(min(${minColumnWidth}, 100%), 1fr))`
    : typeof columns === "number"
      ? `repeat(${columns}, minmax(0, 1fr))`
      : columns;
  const mergedStyle: CSSProperties = {
    gridTemplateColumns: templateColumns,
    gap: space(gap),
    ...spacingStyle({ p, px, py, pt, pr, pb, pl, m, mx, my, mt, mr, mb, ml }),
    ...style,
  };
  return (
    <div
      ref={ref}
      className={cx(styles.grid, className)}
      style={mergedStyle}
      {...domProps}
    >
      {children}
    </div>
  );
});
