import {
  forwardRef,
  type HTMLAttributes,
  type LiHTMLAttributes,
  type ReactNode,
} from "react";
import styles from "./List.module.css";
import { cx } from "./utils";

export interface ListProps extends HTMLAttributes<HTMLUListElement> {
  /** Add divider lines between items. Default `true`. */
  divided?: boolean;
}

/** List - a token-styled vertical list container (`<ul>`). */
export const List = forwardRef<HTMLUListElement, ListProps>(function List(
  { divided = true, className, children, ...rest },
  ref,
) {
  return (
    <ul
      ref={ref}
      className={cx(styles.list, divided && styles.divided, className)}
      {...rest}
    >
      {children}
    </ul>
  );
});

export interface ListItemProps extends LiHTMLAttributes<HTMLLIElement> {
  /** Content rendered at the trailing edge (e.g. a Badge or IconButton). */
  trailing?: ReactNode;
}

/** ListItem - a single row within a List, with an optional trailing slot. */
export const ListItem = forwardRef<HTMLLIElement, ListItemProps>(
  function ListItem({ trailing, className, children, ...rest }, ref) {
    return (
      <li ref={ref} className={cx(styles.item, className)} {...rest}>
        <div className={styles.content}>{children}</div>
        {trailing && <div className={styles.trailing}>{trailing}</div>}
      </li>
    );
  },
);
