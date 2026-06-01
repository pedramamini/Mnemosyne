import { Menu as MenuIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useAppShell } from "./AppShell";
import { Heading } from "./Heading";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import styles from "./TopBar.module.css";
import { cx } from "./utils";

export interface TopBarProps {
  /** Page/section title. */
  title?: ReactNode;
  /** Trailing action slot (buttons, avatar menu, …). */
  actions?: ReactNode;
  /**
   * Show the mobile hamburger. Defaults to `true` when inside an AppShell.
   * Clicking it toggles the AppShell off-canvas sidebar.
   */
  showMenuButton?: boolean;
  className?: string;
}

/** TopBar - header bar with title, actions, and a mobile menu button. */
export function TopBar({
  title,
  actions,
  showMenuButton,
  className,
}: TopBarProps) {
  const shell = useAppShell();
  const showMenu = showMenuButton ?? Boolean(shell);

  return (
    <div className={cx(styles.topbar, className)}>
      <div className={styles.left}>
        {showMenu && (
          <span className={styles.menuButton}>
            <IconButton
              label="Toggle navigation"
              icon={<Icon icon={MenuIcon} size="md" />}
              size="md"
              onClick={() => shell?.toggleMobile()}
            />
          </span>
        )}
        {title && (
          <Heading level={4} className={styles.title}>
            {title}
          </Heading>
        )}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
