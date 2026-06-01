import type { ReactNode } from "react";
import styles from "./SettingRow.module.css";

export interface SettingRowProps {
  /** Left-column label. */
  label: ReactNode;
  /** Optional helper/description shown under the label. */
  description?: ReactNode;
  /**
   * Associate the label with the right-column control by its `id` (renders a
   * `<label htmlFor>`). Omit for action rows whose right side is a button/link.
   */
  htmlFor?: string;
  /** Right-column control or action. */
  children: ReactNode;
}

/**
 * SettingRow - one row of a settings panel: a label (+ optional description) in
 * the left column and a control/action in the right. Consecutive rows are
 * separated by a divider (CSS sibling border) and the layout stacks to a single
 * column on narrow viewports. Compose several inside a <Panel> for the
 * settings-list pattern.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: SettingRowProps) {
  return (
    <div className={styles.row}>
      <div className={styles.labelCol}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={styles.label}>
            {label}
          </label>
        ) : (
          <span className={styles.label}>{label}</span>
        )}
        {description && (
          <span className={styles.description}>{description}</span>
        )}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}
