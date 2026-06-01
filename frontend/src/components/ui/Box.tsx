import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  createElement,
  type ElementType,
  forwardRef,
  type ReactNode,
} from "react";
import { cx, type SpacingProps, spacingStyle } from "./utils";

/** Props owned by Box, independent of the rendered element. */
interface BoxOwnProps extends SpacingProps {
  /** The element/component to render. Defaults to `div`. */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** Polymorphic prop set: Box's own props plus the chosen element's props. */
export type BoxProps<C extends ElementType = "div"> = BoxOwnProps &
  Omit<ComponentPropsWithoutRef<C>, keyof BoxOwnProps>;

/**
 * Box - the lowest-level layout primitive. Polymorphic via `as`, with
 * token-driven padding/margin props (`p`, `px`, `mt`, …). All visual values
 * resolve to `var(--space-*)`; Box never hardcodes a length.
 */
export const Box = forwardRef<HTMLElement, BoxProps>(function Box(
  { as, className, style, children, ...rest },
  ref,
) {
  const Component = (as ?? "div") as ElementType;

  const { p, px, py, pt, pr, pb, pl, m, mx, my, mt, mr, mb, ml, ...domProps } =
    rest as SpacingProps & Record<string, unknown>;

  const mergedStyle: CSSProperties = {
    ...spacingStyle({ p, px, py, pt, pr, pb, pl, m, mx, my, mt, mr, mb, ml }),
    ...style,
  };

  return createElement(
    Component,
    { ref, className: cx(className), style: mergedStyle, ...domProps },
    children,
  );
});
