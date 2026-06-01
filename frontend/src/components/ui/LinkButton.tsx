import { type AnchorHTMLAttributes, forwardRef, type ReactNode } from "react";
import type { ButtonSize, ButtonVariant } from "./Button";
import buttonStyles from "./Button.module.css";
import { cx } from "./utils";

export interface LinkButtonProps
  extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the full width of the container. */
  fullWidth?: boolean;
  /** Icon node rendered before the label. */
  leftIcon?: ReactNode;
  /** Icon node rendered after the label. */
  rightIcon?: ReactNode;
}

/**
 * LinkButton - an anchor styled exactly like `Button`. Use for real navigations
 * and file downloads (e.g. `download` + an `href` the browser follows directly),
 * where `<Button onClick>` can't express the semantics. Shares Button's
 * token-driven styling so the two are visually identical; this is the only
 * sanctioned `<a>` for action-like links (raw `<a>` is lint-banned elsewhere).
 */
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(
  function LinkButton(
    {
      variant = "primary",
      size = "md",
      fullWidth = false,
      leftIcon,
      rightIcon,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    return (
      <a
        ref={ref}
        data-variant={variant}
        data-size={size}
        className={cx(
          buttonStyles.button,
          buttonStyles[variant],
          buttonStyles[size],
          fullWidth && buttonStyles.fullWidth,
          className,
        )}
        {...rest}
      >
        {leftIcon && <span className={buttonStyles.icon}>{leftIcon}</span>}
        {children != null && (
          <span className={buttonStyles.label}>{children}</span>
        )}
        {rightIcon && <span className={buttonStyles.icon}>{rightIcon}</span>}
      </a>
    );
  },
);
