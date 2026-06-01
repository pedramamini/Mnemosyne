import { Search, X } from "lucide-react";
import { forwardRef, type InputHTMLAttributes } from "react";
import { useFormField } from "./FormField";
import { Icon } from "./Icon";
import styles from "./SearchInput.module.css";
import { cx } from "./utils";

export interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  fullWidth?: boolean;
  /** Called when the clear (✕) affordance is pressed. Shown only when set + value present. */
  onClear?: () => void;
}

/** SearchInput - Input with a leading search icon and optional clear button. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    {
      fullWidth = true,
      onClear,
      id,
      value,
      className,
      placeholder = "Search…",
      "aria-label": ariaLabel,
      ...rest
    },
    ref,
  ) {
    const field = useFormField();
    const showClear =
      Boolean(onClear) && value != null && String(value).length > 0;
    return (
      <div
        className={cx(styles.wrapper, fullWidth && styles.fullWidth, className)}
      >
        <span className={styles.leading} aria-hidden="true">
          <Icon icon={Search} size="sm" />
        </span>
        <input
          ref={ref}
          id={id ?? field?.id}
          type="search"
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel ?? (field ? undefined : "Search")}
          aria-describedby={field?.describedBy}
          className={styles.input}
          {...rest}
        />
        {showClear && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear search"
            className={styles.clear}
          >
            <Icon icon={X} size="sm" />
          </button>
        )}
      </div>
    );
  },
);
