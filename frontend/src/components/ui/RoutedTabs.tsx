import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useRef,
} from "react";
import {
  Link,
  matchPath,
  Outlet,
  useLocation,
  useNavigate,
  useResolvedPath,
} from "react-router-dom";
import { Badge } from "./Badge";
import styles from "./RoutedTabs.module.css";
import { cx } from "./utils";

/** One routed tab: a label, the route it links to, and an optional badge count. */
export interface RoutedTabSpec {
  /** Visible tab label. */
  label: ReactNode;
  /** Route target for the tab (relative segment or absolute path). */
  to: string;
  /** Optional trailing badge (e.g. an unread/item count). */
  badge?: ReactNode;
}

export interface RoutedTabsProps {
  tabs: RoutedTabSpec[];
  /** Accessible label for the tablist. */
  label?: string;
  /** Forwarded to the routed `<Outlet/>` as its outlet context. */
  outletContext?: unknown;
  className?: string;
}

/** A registered tab anchor + its resolved absolute path (for roving focus + activation). */
interface TabEntry {
  el: HTMLAnchorElement | null;
  path: string;
}

/**
 * RoutedTabs - a router-aware tab strip. Each tab is a `<Link>` to a sub-route;
 * the active tab is derived from the URL (so deep-linking + the back button work),
 * and the routed `<Outlet/>` renders the panel. Keyboard-navigable with arrow
 * keys / Home / End over a roving tabindex (selection follows focus → navigates),
 * with `role="tablist"`/`tab`/`tabpanel` wiring. The strip scrolls horizontally
 * on narrow viewports. Generic by design: callers pass `{ label, to, badge? }`.
 *
 * This is the routed sibling of the in-place {@link Tabs} primitive (content
 * panels, no router) - pick RoutedTabs when each tab is a URL-addressable view.
 */
export function RoutedTabs({
  tabs,
  label,
  outletContext,
  className,
}: RoutedTabsProps) {
  const baseId = useId();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const entries = useRef<TabEntry[]>([]);

  const register = useCallback(
    (index: number, el: HTMLAnchorElement | null, path: string) => {
      entries.current[index] = { el, path };
    },
    [],
  );

  // The tab whose resolved path the current URL falls under (chat stays active
  // for /chat/:id too, via the prefix match). -1 when none match.
  function activeIndex(): number {
    return entries.current.findIndex(
      (e) => e && matchPath({ path: e.path, end: false }, pathname) != null,
    );
  }

  function focusAndActivate(index: number) {
    const entry = entries.current[index];
    if (!entry) return;
    navigate(entry.path);
    entry.el?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const count = tabs.length;
    if (count === 0) return;
    const current = Math.max(0, activeIndex());
    let next = current;
    if (e.key === "ArrowRight" || e.key === "ArrowDown")
      next = (current + 1) % count;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (current - 1 + count) % count;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else return;
    e.preventDefault();
    focusAndActivate(next);
  }

  return (
    <div className={cx(styles.root, className)}>
      <div
        role="tablist"
        aria-label={label}
        className={styles.tablist}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab, index) => (
          <RoutedTab
            key={tab.to}
            tab={tab}
            index={index}
            baseId={baseId}
            register={register}
          />
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-label={label}
        className={styles.panel}
      >
        <Outlet context={outletContext} />
      </div>
    </div>
  );
}

interface RoutedTabProps {
  tab: RoutedTabSpec;
  index: number;
  baseId: string;
  register: (index: number, el: HTMLAnchorElement | null, path: string) => void;
}

/**
 * One tab link. A child component so the per-tab router hooks
 * (`useResolvedPath`) live at a component top level (never in a parent loop),
 * and so each tab independently re-derives its active state from the URL.
 */
function RoutedTab({ tab, index, baseId, register }: RoutedTabProps) {
  const resolved = useResolvedPath(tab.to);
  const { pathname } = useLocation();
  const active =
    matchPath({ path: resolved.pathname, end: false }, pathname) != null;

  const setRef = useCallback(
    (el: HTMLAnchorElement | null) => register(index, el, resolved.pathname),
    [index, register, resolved.pathname],
  );

  return (
    <Link
      ref={setRef}
      to={tab.to}
      role="tab"
      id={`${baseId}-tab-${index}`}
      aria-selected={active}
      aria-current={active ? "page" : undefined}
      aria-controls={`${baseId}-panel`}
      tabIndex={active ? 0 : -1}
      className={cx(styles.tab, active && styles.selected)}
    >
      <span className={styles.label}>{tab.label}</span>
      {tab.badge != null && (
        <Badge size="sm" variant="neutral" className={styles.badge}>
          {tab.badge}
        </Badge>
      )}
    </Link>
  );
}
