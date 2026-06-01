import { ChevronLeft, ChevronRight } from "lucide-react";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import styles from "./Pagination.module.css";
import { cx } from "./utils";

export interface PaginationProps {
  /** 1-based current page. */
  page: number;
  /** Total number of pages. */
  pageCount: number;
  onPageChange: (page: number) => void;
  /** How many numbered siblings to show around the current page. Default `1`. */
  siblingCount?: number;
  className?: string;
}

const ELLIPSIS = "…";

/** Build the page-token list, inserting ellipses for large ranges. */
function buildRange(
  page: number,
  pageCount: number,
  siblings: number,
): Array<number | string> {
  const total = pageCount;
  const range: Array<number | string> = [];
  const left = Math.max(2, page - siblings);
  const right = Math.min(total - 1, page + siblings);

  range.push(1);
  if (left > 2) range.push(`${ELLIPSIS}-left`);
  for (let i = left; i <= right; i++) range.push(i);
  if (right < total - 1) range.push(`${ELLIPSIS}-right`);
  if (total > 1) range.push(total);
  return range;
}

/** Pagination - accessible page navigation with prev/next + numbered pages. */
export function Pagination({
  page,
  pageCount,
  onPageChange,
  siblingCount = 1,
  className,
}: PaginationProps) {
  if (pageCount <= 1) return null;
  const tokens = buildRange(page, pageCount, siblingCount);

  return (
    <nav aria-label="Pagination" className={cx(styles.root, className)}>
      <IconButton
        label="Previous page"
        icon={<Icon icon={ChevronLeft} size="sm" />}
        size="sm"
        variant="secondary"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      />
      <ul className={styles.list}>
        {tokens.map((token) =>
          typeof token === "string" ? (
            <li key={token} className={styles.ellipsis} aria-hidden="true">
              {ELLIPSIS}
            </li>
          ) : (
            <li key={token}>
              <button
                type="button"
                aria-current={token === page ? "page" : undefined}
                className={cx(styles.page, token === page && styles.active)}
                onClick={() => onPageChange(token)}
              >
                {token}
              </button>
            </li>
          ),
        )}
      </ul>
      <IconButton
        label="Next page"
        icon={<Icon icon={ChevronRight} size="sm" />}
        size="sm"
        variant="secondary"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      />
    </nav>
  );
}
