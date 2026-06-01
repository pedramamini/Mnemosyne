import { X } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import styles from "./Drawer.module.css";
import { Heading } from "./Heading";
import { IconButton } from "./IconButton";
import { Portal } from "./Portal";
import { useFocusTrap } from "./useFocusTrap";
import { cx } from "./utils";

type DrawerSide = "left" | "right";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Side the panel slides in from. Default `right`. */
  side?: DrawerSide;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  disableBackdropClose?: boolean;
  className?: string;
}

/** Drawer - an edge-anchored, focus-trapped, ESC-closable panel. */
export function Drawer({
  open,
  onClose,
  side = "right",
  title,
  children,
  footer,
  disableBackdropClose = false,
  className,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panelRef, open, onClose);

  if (!open) return null;

  return (
    <Portal>
      <div
        className={cx(
          styles.backdrop,
          side === "left" ? styles.alignLeft : styles.alignRight,
        )}
      >
        <div
          className={styles.backdropClick}
          onClick={disableBackdropClose ? undefined : onClose}
          aria-hidden="true"
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          className={cx(
            styles.panel,
            side === "left" ? styles.fromLeft : styles.fromRight,
            className,
          )}
        >
          <div className={styles.header}>
            {title ? (
              <Heading level={3} id={titleId} className={styles.title}>
                {title}
              </Heading>
            ) : (
              <span />
            )}
            <IconButton
              label="Close drawer"
              icon={<X size={20} />}
              onClick={onClose}
              size="sm"
            />
          </div>
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}
