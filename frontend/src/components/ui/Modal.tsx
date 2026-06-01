import { X } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { Heading } from "./Heading";
import { IconButton } from "./IconButton";
import styles from "./Modal.module.css";
import { Portal } from "./Portal";
import { useFocusTrap } from "./useFocusTrap";
import { cx } from "./utils";

type ModalSize = "sm" | "md" | "lg";

export interface ModalProps {
  /** Whether the modal is shown. */
  open: boolean;
  /** Requested close (ESC, backdrop click, or the ✕ button). */
  onClose: () => void;
  /** Accessible title. Rendered as a Heading and used for `aria-labelledby`. */
  title?: ReactNode;
  /** Body content. */
  children: ReactNode;
  /** Footer content (e.g. action Buttons). */
  footer?: ReactNode;
  size?: ModalSize;
  /** Disable closing on backdrop click. */
  disableBackdropClose?: boolean;
  /** Hide the ✕ close button. */
  hideCloseButton?: boolean;
  className?: string;
}

/** Modal / Dialog - focus-trapped, ESC-closable, `aria-modal` overlay. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  disableBackdropClose = false,
  hideCloseButton = false,
  className,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(dialogRef, open, onClose);

  if (!open) return null;

  return (
    <Portal>
      <div className={styles.backdrop}>
        {/* Backdrop click target - a div, never an interactive element. */}
        <div
          className={styles.backdropClick}
          onClick={disableBackdropClose ? undefined : onClose}
          aria-hidden="true"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          className={cx(styles.dialog, styles[size], className)}
        >
          {(title || !hideCloseButton) && (
            <div className={styles.header}>
              {title ? (
                <Heading level={3} id={titleId} className={styles.title}>
                  {title}
                </Heading>
              ) : (
                <span />
              )}
              {!hideCloseButton && (
                <IconButton
                  label="Close dialog"
                  icon={<X size={20} />}
                  onClick={onClose}
                  size="sm"
                />
              )}
            </div>
          )}
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

/** Dialog - alias of Modal. */
export const Dialog = Modal;
export type DialogProps = ModalProps;
