import {
  Home,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Power,
  Search,
  Settings,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useContext } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "@/auth/useSession";
import { CommandPaletteContext } from "@/components/command/CommandPaletteProvider";
import {
  AppShell,
  Button,
  Icon,
  IconButton,
  Inline,
  Kbd,
  NavItem,
  Sidebar,
  Stack,
  Text,
  useAppShell,
} from "@/components/ui";
import styles from "./AppLayout.module.css";
import { SidebarAgentNav } from "./SidebarAgentNav";
import { type FlyoutTriggerProps, SidebarFlyout } from "./SidebarFlyout";
import { useSidebarRail } from "./useSidebarRail";

/** Brand + collapse/expand toggle, rendered as the sidebar header. */
function SidebarBrand() {
  const shell = useAppShell();
  const rail = useSidebarRail();
  const navigate = useNavigate();

  if (rail) {
    // Rail mode: just the glyph here, still a home link. The expand toggle moves
    // below the brand divider (rendered as the first nav item via
    // <RailExpandButton>).
    return (
      <Button
        variant="link"
        onClick={() => navigate("/agents")}
        aria-label="Mnemosyne — home"
      >
        <span className={styles.glyph} aria-hidden="true">
          🧠
        </span>
      </Button>
    );
  }

  return (
    <Inline
      justify="between"
      align="center"
      wrap={false}
      style={{ width: "100%" }}
    >
      <Button
        variant="link"
        onClick={() => navigate("/agents")}
        aria-label="Mnemosyne — home"
      >
        <span className={styles.brand}>🧠 Mnemosyne</span>
      </Button>
      {shell && (
        <span className={styles.collapseToggle}>
          <IconButton
            label="Collapse sidebar"
            icon={<Icon icon={PanelLeftClose} size="sm" />}
            size="sm"
            onClick={() => shell.toggleCollapsed()}
          />
        </span>
      )}
    </Inline>
  );
}

/** Bottom-of-sidebar account slot: the signed-in email + a sign-out action. */
function AccountSlot() {
  const { account, signOut } = useSession();
  const navigate = useNavigate();
  const rail = useSidebarRail();

  async function onSignOut() {
    await signOut();
    navigate("/login", { replace: true });
  }

  if (rail) {
    return (
      <Stack gap="1">
        <RailAction
          icon={<Icon icon={Settings} size="md" />}
          label="Settings"
          onClick={() => navigate("/settings")}
        />
        <RailAction
          icon={<Icon icon={Power} size="md" />}
          label="Sign out"
          onClick={onSignOut}
        />
      </Stack>
    );
  }

  return (
    <Stack gap="2">
      {account && (
        <Text size="sm" color="text-muted" truncate title={account.email}>
          {account.email}
        </Text>
      )}
      <Button
        variant="secondary"
        size="sm"
        fullWidth
        leftIcon={<Icon icon={Settings} size="sm" />}
        onClick={() => navigate("/settings")}
      >
        Account settings
      </Button>
      <Button variant="secondary" size="sm" fullWidth onClick={onSignOut}>
        Sign out
      </Button>
    </Stack>
  );
}

export interface AppLayoutProps {
  children: ReactNode;
}

/**
 * Mobile-only menu toggle. With no top bar, narrow viewports still need a way to
 * open the off-canvas sidebar drawer - this renders a hamburger that's hidden on
 * desktop (where the sidebar is a persistent column) via CSS.
 */
function MobileMenuTrigger() {
  const shell = useAppShell();
  if (!shell) return null;
  return (
    <div className={styles.mobileMenu}>
      <IconButton
        label="Open menu"
        icon={<Icon icon={MenuIcon} size="sm" />}
        size="sm"
        onClick={() => shell.toggleMobile()}
      />
    </div>
  );
}

/**
 * A collapsed-rail item: a larger icon with a caption beneath, styled like the
 * rail's nav links. Used for the rail's *action* buttons (Search, Settings,
 * Sign out) so they match the labeled icon+caption treatment of the nav links.
 */
function RailAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <NavItem
      as="button"
      type="button"
      collapsed
      icon={icon}
      aria-label={label}
      onClick={onClick}
    >
      {label}
    </NavItem>
  );
}

/**
 * Rail-only "expand sidebar" button. Sits at the top of the nav - below the
 * brand divider, above the search icon - when the sidebar is collapsed to the
 * icon rail. Renders nothing when expanded (the collapse toggle lives in the
 * brand header then) or when no shell is mounted.
 */
function RailExpandButton() {
  const shell = useAppShell();
  const rail = useSidebarRail();
  if (!rail || !shell) return null;

  return (
    <IconButton
      label="Expand sidebar"
      icon={<Icon icon={PanelLeftOpen} size="sm" />}
      size="sm"
      onClick={() => shell.toggleCollapsed()}
    />
  );
}

/**
 * Sidebar trigger for the ⌘K command palette. Reads the palette controls
 * *optionally* - if no `CommandPaletteProvider` is mounted above (e.g. an
 * isolated render), it renders nothing rather than throwing. Shrinks to an icon
 * button in the collapsed rail.
 */
function CommandSearchTrigger() {
  const palette = useContext(CommandPaletteContext);
  const rail = useSidebarRail();
  if (!palette) return null;

  if (rail) {
    return (
      <RailAction
        icon={<Icon icon={Search} size="md" />}
        label="Search"
        onClick={palette.open}
      />
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      fullWidth
      leftIcon={<Icon icon={Search} size="sm" />}
      rightIcon={<Kbd>⌘K</Kbd>}
      onClick={palette.open}
    >
      Search
    </Button>
  );
}

/**
 * The Agents nav section. Expanded: the "Agents" link followed by the full
 * grouped agent list. Collapsed rail: the "Agents" icon becomes a hover
 * trigger that flies the agent list out to the right (there's no room for it in
 * the rail itself).
 */
function AgentsNavSection() {
  const rail = useSidebarRail();
  if (rail) {
    return (
      <SidebarFlyout
        label="Agents"
        trigger={(handlers) => <AgentsNavItem {...handlers} />}
      >
        <SidebarAgentNav variant="flyout" />
      </SidebarFlyout>
    );
  }
  return (
    <>
      <AgentsNavItem />
      <SidebarAgentNav />
    </>
  );
}

/**
 * The top-level "Agents" nav link - rail-aware (icon-only when collapsed).
 * Forwards any hover/focus handlers (from `SidebarFlyout` when collapsed) onto
 * the underlying link so the rail trigger can open the agent flyout.
 */
function AgentsNavItem(handlers: Partial<FlyoutTriggerProps> = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const rail = useSidebarRail();
  const onAgents = location.pathname.startsWith("/agents");

  return (
    <NavItem
      href="/agents"
      title="Agents"
      aria-label="Agents"
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        navigate("/agents");
      }}
      icon={<Icon icon={Home} size={rail ? "md" : "sm"} />}
      active={onAgents}
      collapsed={rail}
      {...handlers}
    >
      Agents
    </NavItem>
  );
}

/**
 * AppLayout - the shared authenticated chrome (sidebar + account slot + top bar)
 * that every signed-in screen renders inside. Centralizing it here keeps the
 * navigation/account affordances identical across the agent list, create wizard,
 * and detail pages instead of each route rebuilding the shell. The sidebar is
 * drag-resizable (width persisted) and collapses to a narrow icon RAIL - the
 * brand glyph and agent avatars stay visible - via AppShell. It lists the
 * account's agents in named, groupable sections (`SidebarAgentNav`). Links route
 * through `NavItem` (raw <a> is banned outside the UI library). There is no top
 * bar - the layout is just the sidebar (left) and the page content (right);
 * each page owns its own in-content header (title + actions).
 */
export function AppLayout({ children }: AppLayoutProps) {
  return (
    <AppShell
      sidebar={
        <SidebarBody>
          <RailExpandButton />
          <CommandSearchTrigger />
          <AgentsNavSection />
        </SidebarBody>
      }
    >
      <MobileMenuTrigger />
      {children}
    </AppShell>
  );
}

/** Wraps the Sidebar so it can read the rail state (inside the AppShell tree). */
function SidebarBody({ children }: { children: ReactNode }) {
  const rail = useSidebarRail();
  return (
    <Sidebar
      collapsed={rail}
      header={<SidebarBrand />}
      account={<AccountSlot />}
    >
      {children}
    </Sidebar>
  );
}
