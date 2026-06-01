import {
  Brain,
  FileText,
  Home,
  Info,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Moon,
  Network,
  Plus,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Sun,
  Type,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppearance } from "@/appearance/AppearanceProvider";
import { FONTS, THEMES } from "@/appearance/appearance";
import { useSession } from "@/auth/useSession";
import { useAgents } from "@/components/dashboard/useAgentMetrics";
import {
  Avatar,
  Badge,
  type CommandItem,
  CommandPalette,
  Icon,
} from "@/components/ui";

interface CommandPaletteContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

/**
 * Exported so non-essential triggers (e.g. the sidebar search affordance) can
 * read the controls *optionally* - rendering nothing when no provider is above
 * them - without the throw-on-missing contract of {@link useCommandPalette}.
 */
export const CommandPaletteContext =
  createContext<CommandPaletteContextValue | null>(null);

/** Read the palette controls. Throws outside the provider (a wiring error). */
export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error(
      "useCommandPalette must be used within <CommandPaletteProvider>",
    );
  }
  return ctx;
}

/** Extract the active agent id from the URL, if we're on an agent route. */
function useActiveAgentId(): string | null {
  const { pathname } = useLocation();
  const match = /^\/agents\/([^/]+)/.exec(pathname);
  const id = match?.[1];
  if (!id || id === "new") return null;
  return id;
}

/**
 * Assemble the full command set from the app's navigable surfaces: the current
 * agent's tabs (when on an agent route), top-level navigation, every agent, the
 * theme + typeface catalog, and account actions. Each `onSelect` performs its
 * effect; the palette closes itself afterward.
 */
function useAppCommands(): CommandItem[] {
  const navigate = useNavigate();
  const activeAgentId = useActiveAgentId();
  const { theme, setTheme, font, setFont, previewTheme, previewFont } =
    useAppearance();
  const { agents } = useAgents();
  const { signOut } = useSession();

  return useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];

    // ── Current agent - its detail tabs, when one is open ──────────────────
    if (activeAgentId) {
      const tabs: Array<[string, string, typeof Home]> = [
        ["Chat", "chat", MessageSquare],
        ["Messaging", "messaging", MessagesSquare],
        ["Reports", "reports", FileText],
        ["Brain", "brain", Brain],
        ["Graph", "graph", Network],
        ["Audit", "audit", ScrollText],
        ["Settings", "settings", SlidersHorizontal],
        ["Metadata", "metadata", Info],
      ];
      for (const [label, slug, icon] of tabs) {
        items.push({
          id: `agent-tab-${slug}`,
          group: "Current agent",
          label: `Open ${label}`,
          keywords: `${slug} tab agent`,
          icon: <Icon icon={icon} size="sm" />,
          onSelect: () => navigate(`/agents/${activeAgentId}/${slug}`),
        });
      }
    }

    // ── Top-level navigation ───────────────────────────────────────────────
    items.push(
      {
        id: "nav-agents",
        group: "Navigation",
        label: "Go to Agents",
        keywords: "dashboard home list",
        icon: <Icon icon={Home} size="sm" />,
        onSelect: () => navigate("/agents"),
      },
      {
        id: "nav-new-agent",
        group: "Navigation",
        label: "Create agent",
        keywords: "new add wizard",
        icon: <Icon icon={Plus} size="sm" />,
        onSelect: () => navigate("/agents/new"),
      },
      {
        id: "nav-settings",
        group: "Navigation",
        label: "Account settings",
        keywords: "profile name timezone preferences",
        icon: <Icon icon={Settings} size="sm" />,
        onSelect: () => navigate("/settings"),
      },
    );

    // ── Agents - jump straight to any agent ───────────────────────────────
    for (const agent of agents ?? []) {
      items.push({
        id: `agent-${agent.id}`,
        group: "Agents",
        label: agent.name,
        keywords: `${agent.description ?? ""} ${agent.template ?? ""}`,
        icon: <Avatar name={agent.name} size="sm" />,
        onSelect: () => navigate(`/agents/${agent.id}`),
      });
    }

    // ── Theme ──────────────────────────────────────────────────────────────
    for (const t of THEMES) {
      items.push({
        id: `theme-${t.id}`,
        group: "Theme",
        label: `Theme: ${t.label}`,
        keywords: `color appearance ${t.mode} scheme`,
        icon: <Icon icon={t.mode === "dark" ? Moon : Sun} size="sm" />,
        hint:
          t.id === theme ? (
            <Badge variant="neutral" appearance="subtle" size="sm">
              Active
            </Badge>
          ) : undefined,
        onSelect: () => setTheme(t.id),
        onPreview: () => previewTheme(t.id),
      });
    }

    // ── Typeface ─────────────────────────────────────────────────────────
    for (const f of FONTS) {
      items.push({
        id: `font-${f.id}`,
        group: "Typeface",
        label: `Font: ${f.label}`,
        keywords: `typeface type ${f.note}`,
        icon: <Icon icon={Type} size="sm" />,
        hint:
          f.id === font ? (
            <Badge variant="neutral" appearance="subtle" size="sm">
              Active
            </Badge>
          ) : undefined,
        onSelect: () => setFont(f.id),
        onPreview: () => previewFont(f.id),
      });
    }

    // ── Account ──────────────────────────────────────────────────────────
    items.push({
      id: "account-sign-out",
      group: "Account",
      label: "Sign out",
      keywords: "logout leave",
      icon: <Icon icon={LogOut} size="sm" />,
      onSelect: () => {
        void signOut().then(() => navigate("/login", { replace: true }));
      },
    });

    return items;
  }, [
    activeAgentId,
    agents,
    theme,
    setTheme,
    font,
    setFont,
    previewTheme,
    previewFont,
    navigate,
    signOut,
  ]);
}

/**
 * CommandPaletteProvider - owns the ⌘K / Ctrl+K palette for the authenticated
 * app. Binds the global shortcut (toggle), exposes open/close controls via
 * context, and renders the {@link CommandPalette} fed by {@link useAppCommands}.
 * Mount once around the authed routes so a single palette serves every screen.
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  const items = useAppCommands();
  const { clearPreview } = useAppearance();

  // Global shortcut: Cmd+K (mac) / Ctrl+K (win/linux) toggles the palette.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  const value = useMemo(
    () => ({ isOpen, open, close, toggle }),
    [isOpen, open, close, toggle],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette
        open={isOpen}
        onClose={close}
        items={items}
        onPreviewClear={clearPreview}
      />
    </CommandPaletteContext.Provider>
  );
}
