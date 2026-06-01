import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
} from "react";
import { useFormField } from "./FormField";
import styles from "./Switch.module.css";
import { cx } from "./utils";

export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Optional inline label rendered beside the track. */
  label?: ReactNode;
}

/**
 * Switch - a token-styled on/off toggle, keyboard-operable. Built on a native
 * checkbox so its checked state stays correct for both controlled and
 * uncontrolled use; the track/thumb are a purely visual affordance.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, id, className, ...rest },
  ref,
) {
  const field = useFormField();
  const generatedId = useId();
  const inputId = id ?? field?.id ?? generatedId;
  return (
    <label htmlFor={inputId} className={cx(styles.root, className)}>
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        aria-describedby={field?.describedBy}
        className={styles.input}
        {...rest}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {label != null && <span className={styles.label}>{label}</span>}
    </label>
  );
});
