import { forwardRef, type ReactNode } from "react";
import styles from "./EmptyState.module.css";
import { Heading } from "./Heading";
import { Text } from "./Text";
import { cx } from "./utils";

export interface EmptyStateProps {
  /** Optional leading icon node (e.g. an <Icon>). */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Optional action node (e.g. a primary Button). */
  action?: ReactNode;
  className?: string;
}

/** EmptyState - centered icon + title + description + optional action. */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  function EmptyState({ icon, title, description, action, className }, ref) {
    return (
      <div ref={ref} className={cx(styles.root, className)}>
        {icon && <div className={styles.icon}>{icon}</div>}
        <Heading level={3} className={styles.title}>
          {title}
        </Heading>
        {description && (
          <Text color="text-muted" className={styles.description} as="p">
            {description}
          </Text>
        )}
        {action && <div className={styles.action}>{action}</div>}
      </div>
    );
  },
);
