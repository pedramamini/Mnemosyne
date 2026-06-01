import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import styles from "./Menu.module.css";
import { cx } from "./utils";

export interface MenuItemSpec {
  /** Stable identity for the item. */
  id: string;
  label: ReactNode;
  /** Optional leading icon node. */
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  /** Render in the danger color (destructive action). */
  danger?: boolean;
}

export interface MenuProps {
  /** Trigger element; cloned with toggle handlers + aria-haspopup/expanded. */
  trigger: ReactElement;
  items: MenuItemSpec[];
  /** Horizontal alignment of the panel relative to the trigger. Default `start`. */
  align?: "start" | "end";
  /** Accessible label for the menu list. */
  label?: string;
}

/** Menu / Dropdown - keyboard-navigable popup menu anchored to a trigger. */
export function Menu({ trigger, items, align = "start", label }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const enabledIndexes = items
    .map((item, i) => (item.disabled ? -1 : i))
    .filter((i) => i >= 0);

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click / focus leaving the menu.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  // Focus the active item whenever it changes while open.
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  function openMenu(toIndex: number) {
    setActiveIndex(toIndex);
    setOpen(true);
  }

  function moveActive(delta: 1 | -1) {
    if (enabledIndexes.length === 0) return;
    const pos = enabledIndexes.indexOf(activeIndex);
    const nextPos =
      (pos + delta + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[nextPos]);
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu(enabledIndexes[0] ?? 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openMenu(enabledIndexes[enabledIndexes.length - 1] ?? 0);
    }
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(enabledIndexes[0] ?? 0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(enabledIndexes[enabledIndexes.length - 1] ?? 0);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        close();
        break;
    }
  }

  function selectItem(item: MenuItemSpec) {
    if (item.disabled) return;
    item.onSelect?.();
    close();
  }

  const triggerProps = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => (open ? close() : openMenu(enabledIndexes[0] ?? 0)),
    onKeyDown: onTriggerKeyDown,
  };

  const clonedTrigger = isValidElement(trigger)
    ? cloneElement(trigger, triggerProps as Record<string, unknown>)
    : trigger;

  return (
    <div ref={rootRef} className={styles.root}>
      {clonedTrigger}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={cx(
            styles.menu,
            align === "end" ? styles.alignEnd : styles.alignStart,
          )}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              disabled={item.disabled}
              data-danger={item.danger || undefined}
              className={cx(styles.item, item.danger && styles.danger)}
              onClick={() => selectItem(item)}
              onMouseEnter={() => !item.disabled && setActiveIndex(index)}
            >
              {item.icon && <span className={styles.icon}>{item.icon}</span>}
              <span className={styles.label}>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Dropdown - alias of Menu. */
export const Dropdown = Menu;
