import { createContext, type ReactNode, useContext, useId } from "react";
import styles from "./FormField.module.css";
import { Text } from "./Text";
import { cx } from "./utils";

interface FormFieldContextValue {
  /** id wired to the control and the label's `htmlFor`. */
  id: string;
  /** Space-joined ids of help/error text, for `aria-describedby`. */
  describedBy?: string;
  /** Whether the field is in an error state (`aria-invalid`). */
  invalid: boolean;
  /** Whether the field is required. */
  required: boolean;
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null);

/**
 * Read the surrounding FormField's accessibility wiring. Controls call this to
 * auto-adopt `id`, `aria-describedby`, `aria-invalid` and `required` so callers
 * don't repeat them. Returns `null` when used outside a FormField.
 */
export function useFormField(): FormFieldContextValue | null {
  return useContext(FormFieldContext);
}

export interface FormFieldProps {
  /** Visible field label. */
  label: ReactNode;
  /** Optional helper/description text below the control. */
  help?: ReactNode;
  /** Error message; presence flips the field into the invalid state. */
  error?: ReactNode;
  /** Marks the field required (adds a marker + sets `required` on the control). */
  required?: boolean;
  /** Visually hide the label (still read by assistive tech). */
  hideLabel?: boolean;
  /** Override the generated id. */
  id?: string;
  className?: string;
  /** A single form control (Input, Select, …). */
  children: ReactNode;
}

/**
 * FormField - label + help + error + required marker around one control.
 * Generates ids and exposes them via context so the control wires up
 * `aria-describedby`/`aria-invalid`/`required` automatically.
 */
export function FormField({
  label,
  help,
  error,
  required = false,
  hideLabel = false,
  id: idProp,
  className,
  children,
}: FormFieldProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  const invalid = Boolean(error);

  return (
    <FormFieldContext.Provider value={{ id, describedBy, invalid, required }}>
      <div className={cx(styles.field, className)}>
        <label
          htmlFor={id}
          className={cx(styles.label, hideLabel && styles.srOnly)}
        >
          <Text size="sm" weight="medium" as="span">
            {label}
          </Text>
          {required && (
            <span className={styles.required} aria-hidden="true">
              *
            </span>
          )}
        </label>
        {children}
        {help && !error && (
          <Text id={helpId} size="sm" color="text-muted" as="p">
            {help}
          </Text>
        )}
        {error && (
          <Text id={errorId} size="sm" color="danger" as="p" role="alert">
            {error}
          </Text>
        )}
      </div>
    </FormFieldContext.Provider>
  );
}
