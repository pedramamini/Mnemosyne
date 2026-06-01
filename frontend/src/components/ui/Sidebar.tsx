import type { ReactNode } from "react";
import styles from "./Sidebar.module.css";
import { cx } from "./utils";

export interface SidebarProps {
  /** Brand/logo content rendered at the top. */
  header?: ReactNode;
  /** Primary navigation (typically a column of <NavItem>s). */
  children: ReactNode;
  /** Bottom-anchored account/profile slot. */
  account?: ReactNode;
  /** Icon-rail mode: tightens padding + centers the header/account slots. */
  collapsed?: boolean;
  className?: string;
}

/** Sidebar - vertical nav container with a header slot + bottom account slot. */
export function Sidebar({
  header,
  children,
  account,
  collapsed = false,
  className,
}: SidebarProps) {
  return (
    <div
      className={cx(styles.sidebar, collapsed && styles.collapsed, className)}
    >
      {header && <div className={styles.header}>{header}</div>}
      <nav className={styles.nav} aria-label="Primary">
        {children}
      </nav>
      {account && <div className={styles.account}>{account}</div>}
    </div>
  );
}
