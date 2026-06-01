import type {
  HTMLAttributes,
  ReactNode,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { Skeleton } from "./Skeleton";
import styles from "./Table.module.css";
import { cx } from "./utils";

type Align = "left" | "center" | "right";

/** A typed column definition. `T` is the row shape. */
export interface TableColumn<T> {
  /** Stable column key. */
  key: string;
  /** Header content. */
  header: ReactNode;
  /** Cell renderer for a row. */
  render: (row: T, index: number) => ReactNode;
  align?: Align;
  /** Fixed/min column width (CSS length). */
  width?: string;
}

export interface TableProps<T> {
  columns: Array<TableColumn<T>>;
  data: T[];
  /** Stable key per row. */
  getRowKey: (row: T, index: number) => string | number;
  /** Show shimmering placeholder rows. */
  loading?: boolean;
  /** Placeholder row count while loading. Default `3`. */
  loadingRows?: number;
  /** Rendered (spanning all columns) when there is no data and not loading. */
  empty?: ReactNode;
  /** Visually-hidden-friendly caption for assistive tech. */
  caption?: ReactNode;
  className?: string;
}

/** Table - data-driven table with typed columns + loading/empty states. */
export function Table<T>({
  columns,
  data,
  getRowKey,
  loading = false,
  loadingRows = 3,
  empty,
  caption,
  className,
}: TableProps<T>) {
  return (
    <div className={styles.scroll}>
      <table className={cx(styles.table, className)}>
        {caption && <caption className={styles.caption}>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={styles.th}
                style={{ width: col.width, textAlign: col.align ?? "left" }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: loadingRows }).map((_, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows are static.
              <tr key={`skeleton-${r}`}>
                {columns.map((col) => (
                  <td key={col.key} className={styles.td}>
                    <Skeleton width="80%" />
                  </td>
                ))}
              </tr>
            ))
          ) : data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className={cx(styles.td, styles.empty)}
              >
                {empty ?? "No data"}
              </td>
            </tr>
          ) : (
            data.map((row, index) => (
              <tr key={getRowKey(row, index)} className={styles.row}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={styles.td}
                    style={{ textAlign: col.align ?? "left" }}
                  >
                    {col.render(row, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* --- Low-level subcomponents for bespoke composition -------------------- */

export function TableHead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} />;
}

export function TableRow({
  className,
  ...rest
}: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cx(styles.row, className)} {...rest} />;
}

export function TableHeaderCell({
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cx(styles.th, className)} {...rest} />;
}

export function TableCell({
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx(styles.td, className)} {...rest} />;
}
