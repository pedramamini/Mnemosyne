import {
  type CSSProperties,
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePersistentState } from "@/lib/usePersistentState";
import styles from "./AppShell.module.css";
import { cx } from "./utils";

/** localStorage keys for the desktop sidebar preferences. */
const COLLAPSED_KEY = "mnemosyne:sidebar:collapsed";
const WIDTH_KEY = "mnemosyne:sidebar:width";

/** Collapsed rail width (icon + caption label); expanded width is user-resizable. */
const RAIL_WIDTH = "5.5rem";
const MIN_WIDTH = 192;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 256;
const WIDTH_STEP = 16;

const clampWidth = (px: number) =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));

interface AppShellContextValue {
  /** Whether the off-canvas sidebar is open on narrow viewports. */
  mobileOpen: boolean;
  toggleMobile: () => void;
  closeMobile: () => void;
  /** Whether the persistent sidebar is collapsed to an icon rail (wide viewports). */
  collapsed: boolean;
  toggleCollapsed: () => void;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

/** Access shell controls (used by TopBar's mobile menu button + the sidebar). */
export function useAppShell(): AppShellContextValue | null {
  return useContext(AppShellContext);
}

export interface AppShellProps {
  /** Sidebar content (typically a <Sidebar>). */
  sidebar: ReactNode;
  /** Optional top bar (typically a <TopBar>). */
  topBar?: ReactNode;
  /** Main content region. */
  children: ReactNode;
  className?: string;
}

/**
 * AppShell - responsive two-pane layout: a persistent left sidebar + main content
 * on wide viewports, an off-canvas drawer (behind the TopBar hamburger) on narrow
 * ones. On wide viewports the sidebar is drag-resizable (a separator handle on its
 * right edge; width is persisted + clamped) and collapses to a narrow icon RAIL
 * - not hidden - so the brand glyph and agent avatars stay visible. Both the
 * collapse state and the width survive reloads (`usePersistentState`).
 */
export function AppShell({
  sidebar,
  topBar,
  children,
  className,
}: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleMobile = useCallback(() => setMobileOpen((o) => !o), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const [collapsed, setCollapsed] = usePersistentState(COLLAPSED_KEY, false);
  const toggleCollapsed = useCallback(
    () => setCollapsed((c) => !c),
    [setCollapsed],
  );

  const [width, setWidth] = usePersistentState(WIDTH_KEY, DEFAULT_WIDTH);
  const shellRef = useRef<HTMLDivElement>(null);

  // Drag the separator: track the pointer against the shell's left edge until
  // release, clamping the width as we go.
  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const shell = shellRef.current;
      if (!shell) return;
      const left = shell.getBoundingClientRect().left;
      const onMove = (ev: PointerEvent) =>
        setWidth(clampWidth(ev.clientX - left));
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [setWidth],
  );

  // Keyboard resize for the separator (a11y).
  const onHandleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setWidth((w) => clampWidth(w - WIDTH_STEP));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setWidth((w) => clampWidth(w + WIDTH_STEP));
      } else if (e.key === "Home") {
        e.preventDefault();
        setWidth(MIN_WIDTH);
      } else if (e.key === "End") {
        e.preventDefault();
        setWidth(MAX_WIDTH);
      }
    },
    [setWidth],
  );

  const value = useMemo<AppShellContextValue>(
    () => ({
      mobileOpen,
      toggleMobile,
      closeMobile,
      collapsed,
      toggleCollapsed,
    }),
    [mobileOpen, toggleMobile, closeMobile, collapsed, toggleCollapsed],
  );

  const shellStyle = {
    "--app-sidebar-width": collapsed ? RAIL_WIDTH : `${width}px`,
  } as CSSProperties;

  return (
    <AppShellContext.Provider value={value}>
      <div
        ref={shellRef}
        className={cx(
          styles.shell,
          collapsed && styles.shellCollapsed,
          className,
        )}
        style={shellStyle}
      >
        {mobileOpen && (
          <div
            className={styles.backdrop}
            onClick={closeMobile}
            aria-hidden="true"
          />
        )}
        <aside
          className={cx(styles.sidebar, mobileOpen && styles.sidebarOpen)}
          data-collapsed={collapsed || undefined}
        >
          {sidebar}
        </aside>
        {/* Resize separator - desktop + expanded only (hidden via CSS otherwise). */}
        <div
          className={styles.resizeHandle}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={onHandleKeyDown}
        />
        <div className={styles.mainColumn}>
          {topBar && <header className={styles.header}>{topBar}</header>}
          <main className={styles.main}>{children}</main>
        </div>
      </div>
    </AppShellContext.Provider>
  );
}
