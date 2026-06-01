import { forwardRef, type InputHTMLAttributes } from "react";
import { useFormField } from "./FormField";
import styles from "./Input.module.css";
import { cx } from "./utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Force the error styling/`aria-invalid` independent of a FormField. */
  invalid?: boolean;
  /** Stretch to the full width of the container. Default `true`. */
  fullWidth?: boolean;
}

/** Input - a single-line text control. Auto-wires to a surrounding FormField. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    invalid,
    fullWidth = true,
    id,
    className,
    "aria-describedby": describedBy,
    required,
    ...rest
  },
  ref,
) {
  const field = useFormField();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <input
      ref={ref}
      id={id ?? field?.id}
      required={required ?? field?.required}
      aria-invalid={isInvalid || undefined}
      aria-describedby={describedBy ?? field?.describedBy}
      className={cx(
        styles.input,
        isInvalid && styles.invalid,
        fullWidth && styles.fullWidth,
        className,
      )}
      {...rest}
    />
  );
});
