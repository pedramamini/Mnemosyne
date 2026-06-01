import { ChevronDown } from "lucide-react";
import { forwardRef, type SelectHTMLAttributes } from "react";
import { useFormField } from "./FormField";
import { Icon } from "./Icon";
import styles from "./Select.module.css";
import { cx } from "./utils";

export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  /** Options to render. Alternatively pass `children` <option> nodes via `optionNodes`. */
  options?: SelectOption[];
  /** Placeholder shown as a disabled first option. */
  placeholder?: string;
  invalid?: boolean;
  fullWidth?: boolean;
}

/** Select - a native-backed dropdown with token styling + chevron affordance. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select(
    {
      options = [],
      placeholder,
      invalid,
      fullWidth = true,
      id,
      className,
      "aria-describedby": describedBy,
      required,
      value,
      defaultValue,
      ...rest
    },
    ref,
  ) {
    const field = useFormField();
    const isInvalid = invalid ?? field?.invalid ?? false;
    return (
      <div className={cx(styles.wrapper, fullWidth && styles.fullWidth)}>
        <select
          ref={ref}
          id={id ?? field?.id}
          required={required ?? field?.required}
          aria-invalid={isInvalid || undefined}
          aria-describedby={describedBy ?? field?.describedBy}
          value={value}
          defaultValue={
            defaultValue ??
            (placeholder && value === undefined ? "" : undefined)
          }
          className={cx(styles.select, isInvalid && styles.invalid, className)}
          {...rest}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className={styles.chevron} aria-hidden="true">
          <Icon icon={ChevronDown} size="sm" />
        </span>
      </div>
    );
  },
);
