import { forwardRef, type TextareaHTMLAttributes } from "react";
import { useFormField } from "./FormField";
import styles from "./Textarea.module.css";
import { cx } from "./utils";

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  fullWidth?: boolean;
}

/** Textarea - a multi-line text control. Auto-wires to a surrounding FormField. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    {
      invalid,
      fullWidth = true,
      id,
      className,
      "aria-describedby": describedBy,
      required,
      rows = 4,
      ...rest
    },
    ref,
  ) {
    const field = useFormField();
    const isInvalid = invalid ?? field?.invalid ?? false;
    return (
      <textarea
        ref={ref}
        id={id ?? field?.id}
        rows={rows}
        required={required ?? field?.required}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy ?? field?.describedBy}
        className={cx(
          styles.textarea,
          isInvalid && styles.invalid,
          fullWidth && styles.fullWidth,
          className,
        )}
        {...rest}
      />
    );
  },
);
