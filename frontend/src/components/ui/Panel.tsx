import { type CSSProperties, forwardRef, type HTMLAttributes } from "react";
import type { Radius, Shadow, SpaceScale } from "@/styles/tokens";
import styles from "./Panel.module.css";
import { cx, space } from "./utils";

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Inner padding from the spacing scale. Default `4`. */
  padding?: SpaceScale;
  /** Corner radius token. Default `md`. */
  radius?: Radius;
  /** Elevation token, or `none` for a flat bordered surface. Default `1`. */
  shadow?: Shadow | "none";
  /** Render the bordering outline. Default `true`. */
  bordered?: boolean;
}

/** Panel - a surface with border, radius and elevation. All values from tokens. */
export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  {
    padding = "4",
    radius = "md",
    shadow = "1",
    bordered = true,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const mergedStyle: CSSProperties = {
    padding: space(padding),
    borderRadius: `var(--radius-${radius})`,
    boxShadow: shadow === "none" ? "none" : `var(--shadow-${shadow})`,
    borderWidth: bordered ? "1px" : 0,
    ...style,
  };
  return (
    <div
      ref={ref}
      className={cx(styles.panel, className)}
      style={mergedStyle}
      {...rest}
    >
      {children}
    </div>
  );
});

/** Card - alias of Panel (semantic name used by content-card call sites). */
export const Card = Panel;
export type CardProps = PanelProps;
