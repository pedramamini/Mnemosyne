import type { CSSProperties, ReactNode } from "react";
import { BackButton } from "@/components/ui";
import { cx } from "@/components/ui/utils";
import styles from "./ResponsiveMasterDetail.module.css";
import { useIsMobile } from "./useBreakpoint";

export interface ResponsiveMasterDetailProps {
  /** The list/index pane (file tree, commit list, report list, …). */
  master: ReactNode;
  /** The detail pane (editor, diff, report viewer, …). */
  detail: ReactNode;
  /**
   * Whether the detail view is active. On desktop both panes always render and
   * this is ignored; on mobile it drives the push: `false` shows the master,
   * `true` pushes the detail (with a back affordance) over it.
   */
  showDetail: boolean;
  /** Invoked by the mobile back affordance to return to the master. */
  onBack: () => void;
  /** Accessible label for the back control. Default `"Back"`. */
  backLabel?: string;
  /** Desktop master-pane width (any CSS length). Default `22rem`. */
  masterWidth?: string;
  className?: string;
}

/**
 * ResponsiveMasterDetail (MNEMO-43) - the shared two-pane "master/detail" layout
 * with mobile parity. At `>= md` it renders both panes side-by-side (a fixed-width
 * master + flexible detail). Below `md` it shows ONE pane at a time: the master
 * list, then - once `showDetail` is set (the caller does this when an item is
 * selected) - it pushes the detail over it with a back control that calls `onBack`.
 *
 * Mounting a single pane on mobile (rather than stacking both) is deliberate: it
 * gives real navigable parity, keeps long detail content (diffs, wide tables) from
 * fighting the list for space, and lets callers prove the responsive branch in
 * tests by stubbing `matchMedia`. The back control is the shared {@link BackButton} -
 * no raw interactive elements here.
 */
export function ResponsiveMasterDetail({
  master,
  detail,
  showDetail,
  onBack,
  backLabel = "Back",
  masterWidth,
  className,
}: ResponsiveMasterDetailProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    if (!showDetail) {
      return <div className={cx(styles.mobilePane, className)}>{master}</div>;
    }
    return (
      <div className={cx(styles.mobilePane, className)}>
        <BackButton className={styles.back} onClick={onBack}>
          {backLabel}
        </BackButton>
        {detail}
      </div>
    );
  }

  const rootStyle = masterWidth
    ? ({ "--rmd-master-width": masterWidth } as CSSProperties)
    : undefined;

  return (
    <div className={cx(styles.root, className)} style={rootStyle}>
      <div className={styles.master}>{master}</div>
      <div className={styles.detail}>{detail}</div>
    </div>
  );
}
