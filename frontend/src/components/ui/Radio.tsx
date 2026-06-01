import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
} from "react";
import styles from "./Radio.module.css";
import { cx } from "./utils";

export interface RadioProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Optional inline label rendered beside the dot. */
  label?: ReactNode;
}

/**
 * Radio - a single accessible radio option with a token-styled dot.
 * Group radios by giving them a shared `name`.
 */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, id, className, ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <label htmlFor={inputId} className={cx(styles.root, className)}>
      <input
        ref={ref}
        id={inputId}
        type="radio"
        className={styles.input}
        {...rest}
      />
      <span className={styles.dot} aria-hidden="true" />
      {label != null && <span className={styles.label}>{label}</span>}
    </label>
  );
});
