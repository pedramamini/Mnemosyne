import { type CSSProperties, forwardRef, type HTMLAttributes } from "react";
import styles from "./Container.module.css";
import { cx } from "./utils";

type MaxWidth = "sm" | "md" | "lg" | "xl" | "full";

export interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  /** Max content width. Default `lg`. `full` removes the cap. */
  maxWidth?: MaxWidth;
}

const MAX_WIDTH: Record<MaxWidth, string> = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  full: "100%",
};

/** Container - centered max-width wrapper with token-driven gutters. */
export const Container = forwardRef<HTMLDivElement, ContainerProps>(
  function Container(
    { maxWidth = "lg", className, style, children, ...rest },
    ref,
  ) {
    const mergedStyle: CSSProperties = {
      maxWidth: MAX_WIDTH[maxWidth],
      ...style,
    };
    return (
      <div
        ref={ref}
        className={cx(styles.container, className)}
        style={mergedStyle}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

/** Page - a full-height Container intended as a route-level wrapper. */
export const Page = forwardRef<HTMLDivElement, ContainerProps>(function Page(
  { className, ...rest },
  ref,
) {
  return (
    <Container ref={ref} className={cx(styles.page, className)} {...rest} />
  );
});
