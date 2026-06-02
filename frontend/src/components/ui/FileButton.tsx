import type { ChangeEvent, ReactNode } from "react";
import styles from "./FileButton.module.css";
import { cx } from "./utils";

export interface FileButtonProps {
  /** Accessible name for the file control (icon-only triggers have no text). */
  label: string;
  /** `accept` attribute, e.g. "image/*". */
  accept?: string;
  /** Allow choosing several files at once (use with {@link onSelectFiles}). */
  multiple?: boolean;
  /** Called with the first chosen File. The input is reset so the same file re-fires. */
  onSelect?: (file: File) => void;
  /**
   * Called with ALL chosen files (for `multiple` pickers). Takes precedence over
   * {@link onSelect} when provided. Pass one of `onSelect` / `onSelectFiles`.
   */
  onSelectFiles?: (files: File[]) => void;
  /** Visible trigger content (clicking anywhere on it opens the file dialog). */
  children: ReactNode;
  className?: string;
}

/**
 * FileButton - a click-to-upload trigger: any `children` become the visible
 * control, backed by a visually-hidden (but focusable) `<input type="file">`.
 * Uses native label→input association, so a click anywhere on the trigger opens
 * the picker. Lives in the UI library because raw file inputs are banned in
 * feature code. Single-file callers pass `onSelect`; multi-file callers set
 * `multiple` and pass `onSelectFiles`.
 */
export function FileButton({
  label,
  accept,
  multiple,
  onSelect,
  onSelectFiles,
  children,
  className,
}: FileButtonProps) {
  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length > 0) {
      if (onSelectFiles) onSelectFiles(files);
      else if (onSelect) onSelect(files[0]);
    }
    // Reset so selecting the same file again still fires `change`.
    e.target.value = "";
  }

  return (
    <label className={cx(styles.fileButton, className)}>
      {children}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        aria-label={label}
        className={styles.input}
        onChange={onChange}
      />
    </label>
  );
}
