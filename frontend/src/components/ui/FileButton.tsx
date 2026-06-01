import type { ChangeEvent, ReactNode } from "react";
import styles from "./FileButton.module.css";
import { cx } from "./utils";

export interface FileButtonProps {
  /** Accessible name for the file control (icon-only triggers have no text). */
  label: string;
  /** `accept` attribute, e.g. "image/*". */
  accept?: string;
  /** Called with the chosen File. The input is reset so the same file re-fires. */
  onSelect: (file: File) => void;
  /** Visible trigger content (clicking anywhere on it opens the file dialog). */
  children: ReactNode;
  className?: string;
}

/**
 * FileButton - a click-to-upload trigger: any `children` become the visible
 * control, backed by a visually-hidden (but focusable) `<input type="file">`.
 * Uses native label→input association, so a click anywhere on the trigger opens
 * the picker. Lives in the UI library because raw file inputs are banned in
 * feature code.
 */
export function FileButton({
  label,
  accept,
  onSelect,
  children,
  className,
}: FileButtonProps) {
  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onSelect(file);
    // Reset so selecting the same file again still fires `change`.
    e.target.value = "";
  }

  return (
    <label className={cx(styles.fileButton, className)}>
      {children}
      <input
        type="file"
        accept={accept}
        aria-label={label}
        className={styles.input}
        onChange={onChange}
      />
    </label>
  );
}
