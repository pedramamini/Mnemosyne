import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import styles from "./IconButton.module.css";
import { Spinner } from "./Spinner";
import { cx } from "./utils";

type IconButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Required accessible label (icon-only buttons have no visible text). */
  label: string;
  /** The icon node to render (e.g. an <Icon> element). */
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
}

const SPINNER_SIZE = { sm: "sm", md: "sm", lg: "md" } as const;

/** IconButton - a square, icon-only action. Requires `label` for accessibility. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon,
      variant = "ghost",
      size = "md",
      loading = false,
      disabled,
      type = "button",
      className,
      ...rest
    },
    ref,
  ) {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={cx(
          styles.iconButton,
          styles[variant],
          styles[size],
          className,
        )}
        {...rest}
      >
        {loading ? <Spinner size={SPINNER_SIZE[size]} label={label} /> : icon}
      </button>
    );
  },
);
