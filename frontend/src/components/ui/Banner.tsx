import type { LucideIcon } from "lucide-react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import styles from "./Banner.module.css";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { cx } from "./utils";

export type BannerVariant = "info" | "success" | "warning" | "danger";

export interface BannerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  variant?: BannerVariant;
  /** Optional bold lead-in title. */
  title?: ReactNode;
  /** Called when the dismiss (✕) button is pressed; omit to hide it. */
  onDismiss?: () => void;
}

const ICONS: Record<BannerVariant, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

/** Banner / Alert - an inline status message in one of four semantic variants. */
export const Banner = forwardRef<HTMLDivElement, BannerProps>(function Banner(
  { variant = "info", title, onDismiss, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      role={variant === "danger" ? "alert" : "status"}
      className={cx(styles.banner, styles[variant], className)}
      {...rest}
    >
      <span className={styles.icon}>
        <Icon icon={ICONS[variant]} size="sm" />
      </span>
      <div className={styles.content}>
        {title && <p className={styles.title}>{title}</p>}
        {children && <div className={styles.body}>{children}</div>}
      </div>
      {onDismiss && (
        <IconButton
          label="Dismiss"
          icon={<X size={16} />}
          size="sm"
          onClick={onDismiss}
        />
      )}
    </div>
  );
});

/** Alert - alias of Banner. */
export const Alert = Banner;
export type AlertProps = BannerProps;
