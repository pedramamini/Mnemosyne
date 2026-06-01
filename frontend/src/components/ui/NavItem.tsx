import {
  type ComponentPropsWithoutRef,
  createElement,
  type ElementType,
  type ReactNode,
} from "react";
import styles from "./NavItem.module.css";
import { cx } from "./utils";

interface NavItemOwnProps {
  /** Element/component to render. Default `a` (pass react-router's Link via `as`). */
  as?: ElementType;
  /** Leading icon node. */
  icon?: ReactNode;
  /** Highlight as the current location. */
  active?: boolean;
  /** Trailing slot (e.g. a count Badge). */
  trailing?: ReactNode;
  /** Collapsed rail rendering: stacks a larger icon over a small caption label, hides the trailing slot. */
  collapsed?: boolean;
  children: ReactNode;
  className?: string;
}

export type NavItemProps<C extends ElementType = "a"> = NavItemOwnProps &
  Omit<ComponentPropsWithoutRef<C>, keyof NavItemOwnProps>;

/**
 * NavItem - a sidebar navigation link. Polymorphic so feature code can render
 * a react-router `<Link>`/`<NavLink>` via `as` while keeping consistent styling
 * (the lint rule bans raw <a> outside components/ui, so routes go through here).
 */
export function NavItem({
  as,
  icon,
  active = false,
  trailing,
  collapsed = false,
  children,
  className,
  ...rest
}: NavItemProps) {
  const Component = (as ?? "a") as ElementType;
  return createElement(
    Component,
    {
      className: cx(
        styles.item,
        active && styles.active,
        collapsed && styles.collapsed,
        className,
      ),
      "aria-current": active ? "page" : undefined,
      ...rest,
    },
    <>
      {icon && <span className={styles.icon}>{icon}</span>}
      {children != null && <span className={styles.label}>{children}</span>}
      {!collapsed && trailing && (
        <span className={styles.trailing}>{trailing}</span>
      )}
    </>,
  );
}
