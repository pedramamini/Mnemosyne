import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import styles from "./Button.module.css";
import { Spinner } from "./Spinner";
import { cx } from "./utils";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "link";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show a Spinner and disable interaction while a request is in flight. */
  loading?: boolean;
  /** Stretch to the full width of the container. */
  fullWidth?: boolean;
  /** Icon node rendered before the label. */
  leftIcon?: ReactNode;
  /** Icon node rendered after the label. */
  rightIcon?: ReactNode;
}

const SPINNER_SIZE = { sm: "sm", md: "sm", lg: "md" } as const;

/**
 * Button - the canonical action control. Variants/sizes/loading are token-driven.
 * `loading` shows a Spinner and disables the button; never builds a raw <button>.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      loading = false,
      fullWidth = false,
      leftIcon,
      rightIcon,
      disabled,
      type = "button",
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        data-variant={variant}
        data-size={size}
        data-loading={loading || undefined}
        className={cx(
          styles.button,
          styles[variant],
          styles[size],
          fullWidth && styles.fullWidth,
          className,
        )}
        {...rest}
      >
        {loading ? (
          <span className={styles.spinner}>
            <Spinner size={SPINNER_SIZE[size]} label="Loading" />
          </span>
        ) : (
          leftIcon && <span className={styles.icon}>{leftIcon}</span>
        )}
        {children != null && <span className={styles.label}>{children}</span>}
        {!loading && rightIcon && (
          <span className={styles.icon}>{rightIcon}</span>
        )}
      </button>
    );
  },
);
