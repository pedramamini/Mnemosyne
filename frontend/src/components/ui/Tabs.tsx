import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import styles from "./Tabs.module.css";
import { cx } from "./utils";

export interface TabSpec {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabSpec[];
  /** Controlled selected tab id. */
  value?: string;
  /** Initial selected id (uncontrolled). Defaults to the first enabled tab. */
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Accessible label for the tablist. */
  label?: string;
  className?: string;
}

/** Tabs - accessible tablist with arrow-key roving focus and panels. */
export function Tabs({
  tabs,
  value,
  defaultValue,
  onChange,
  label,
  className,
}: TabsProps) {
  const baseId = useId();
  const firstEnabled = tabs.find((t) => !t.disabled)?.id ?? tabs[0]?.id;
  const [internal, setInternal] = useState(defaultValue ?? firstEnabled);
  const selected = value ?? internal;
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  function select(id: string) {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  }

  function onKeyDown(e: KeyboardEvent) {
    const enabled = tabs.filter((t) => !t.disabled);
    const currentPos = enabled.findIndex((t) => t.id === selected);
    if (currentPos < 0) return;
    let nextPos = currentPos;
    if (e.key === "ArrowRight" || e.key === "ArrowDown")
      nextPos = (currentPos + 1) % enabled.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      nextPos = (currentPos - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") nextPos = 0;
    else if (e.key === "End") nextPos = enabled.length - 1;
    else return;
    e.preventDefault();
    const next = enabled[nextPos];
    select(next.id);
    tabRefs.current[next.id]?.focus();
  }

  return (
    <div className={cx(styles.root, className)}>
      <div
        role="tablist"
        aria-label={label}
        className={styles.tablist}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              disabled={tab.disabled}
              className={cx(styles.tab, isSelected && styles.selected)}
              onClick={() => select(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={tab.id !== selected}
          className={styles.panel}
        >
          {tab.id === selected && tab.content}
        </div>
      ))}
    </div>
  );
}
