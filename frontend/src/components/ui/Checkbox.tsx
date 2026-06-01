import { Check } from "lucide-react";
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
} from "react";
import styles from "./Checkbox.module.css";
import { useFormField } from "./FormField";
import { Icon } from "./Icon";
import { cx } from "./utils";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Optional inline label rendered beside the box. */
  label?: ReactNode;
}

/** Checkbox - accessible boolean control with a token-styled custom box. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ label, id, className, required, ...rest }, ref) {
    const field = useFormField();
    const generatedId = useId();
    const inputId = id ?? field?.id ?? generatedId;
    return (
      <label htmlFor={inputId} className={cx(styles.root, className)}>
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          required={required ?? field?.required}
          aria-describedby={field?.describedBy}
          className={styles.input}
          {...rest}
        />
        <span className={styles.box} aria-hidden="true">
          <Icon icon={Check} size="sm" className={styles.check} />
        </span>
        {label != null && <span className={styles.label}>{label}</span>}
      </label>
    );
  },
);
