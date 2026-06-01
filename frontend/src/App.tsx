import { Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { RequireAuth } from "@/auth/RequireAuth";
import { AuditTab } from "@/components/agents/tabs/AuditTab";
import { BrainTab } from "@/components/agents/tabs/BrainTab";
import { ChatTab } from "@/components/agents/tabs/ChatTab";
import { GraphTab } from "@/components/agents/tabs/GraphTab";
import { MessagingTab } from "@/components/agents/tabs/MessagingTab";
import { MetadataTab } from "@/components/agents/tabs/MetadataTab";
import { ReportsTab } from "@/components/agents/tabs/ReportsTab";
import { SettingsTab } from "@/components/agents/tabs/SettingsTab";
import { CommandPaletteProvider } from "@/components/command/CommandPaletteProvider";
import { Button, Heading, Page, Stack, Text } from "@/components/ui";
import { AccountSettingsPage } from "@/pages/account/AccountSettingsPage";
import { AgentDetailPage } from "@/pages/agents/AgentDetailPage";
import { CreateAgentPage } from "@/pages/agents/CreateAgentPage";
import { CallbackPage } from "@/pages/auth/CallbackPage";
import { LoginPage } from "@/pages/auth/LoginPage";
import {
  ConversationPage,
  ConversationView,
} from "@/pages/conversations/ConversationPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { Components } from "@/pages/dev/Components";
import { MarketingPage } from "@/pages/marketing/MarketingPage";

/*
 * Route tree (auth wired in MNEMO-33; feature screens land in 34+):
 *
 *   /                                                  public marketing landing
 *   /login                                             magic-link request    (MNEMO-33)
 *   /auth/callback                                     magic-link callback   (MNEMO-33)
 *   (the three public routes above are font-locked to the Space Grotesk brand)
 *   /agents                                            agent dashboard       (MNEMO-42, supersedes MNEMO-34 list)
 *   /agents/new                                        create wizard         (MNEMO-34)
 *   /agents/:agentId                                   → redirect to /chat   (MNEMO-36)
 *   /agents/:agentId/chat[/:conversationId]            detail: Chat tab      (MNEMO-36/35)
 *   /agents/:agentId/messaging                         detail: Messaging tab (MNEMO-46/47)
 *   /agents/:agentId/brain                             detail: Brain explorer (MNEMO-38)
 *   /agents/:agentId/graph                             detail: Brain graph map (MNEMO-40)
 *   /agents/:agentId/{reports,audit,settings,metadata} detail: other tabs    (MNEMO-36)
 *   /agents/:agentId/conversations/:conversationId     standalone conversation (MNEMO-35)
 *   /dev/components                                    component catalog (dev-only)
 */

/**
 * Authenticated chrome wrapper: mounts the ⌘K command palette once around every
 * signed-in route so a single palette (and its global shortcut) serves the whole
 * app, then renders the matched route via <Outlet>.
 */
function AuthedArea() {
  return (
    <CommandPaletteProvider>
      <Outlet />
    </CommandPaletteProvider>
  );
}

/**
 * PublicChrome - wraps the unauthenticated website (landing + auth screens) in a
 * subtree pinned to the Space Grotesk brand typeface, so the site always renders
 * in the brand face even when a signed-in visitor has chosen a different font for
 * the app. `data-font="grotesk"` redefines `--font-sans`/`--font-mono` for the
 * subtree (the `[data-font]` block in tokens.css), and the explicit
 * `font-family` re-resolves it here so descendants that inherit the already-
 * computed body font-family still pick up the brand face. `display: contents`
 * keeps the wrapper out of layout - it only carries the cascade.
 */
function PublicChrome() {
  return (
    <div
      data-font="grotesk"
      style={{ display: "contents", fontFamily: "var(--font-sans)" }}
    >
      <Outlet />
    </div>
  );
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <Page>
      <Stack gap="3" align="center" style={{ paddingBlock: "var(--space-10)" }}>
        <Heading level={1}>404</Heading>
        <Text color="text-muted">This page does not exist.</Text>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Back home
        </Button>
      </Stack>
    </Page>
  );
}

/** Top-level route table. */
export function App() {
  return (
    <Routes>
      {/* Public website (landing + auth) - font-locked to the Space Grotesk
          brand face via PublicChrome, regardless of any saved app font. */}
      <Route element={<PublicChrome />}>
        <Route path="/" element={<MarketingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<CallbackPage />} />
      </Route>

      {/* Authenticated app - gated by the session probe, wrapped in the
          shared chrome (⌘K command palette). */}
      <Route element={<RequireAuth />}>
        <Route element={<AuthedArea />}>
          <Route path="/agents" element={<DashboardPage />} />
          <Route path="/agents/new" element={<CreateAgentPage />} />
          {/* Account settings: a single panel of profile + appearance rows. */}
          <Route path="/settings" element={<AccountSettingsPage />} />

          {/* Per-agent detail shell: tabbed, URL-addressable panels (MNEMO-36). */}
          <Route path="/agents/:agentId" element={<AgentDetailPage />}>
            <Route index element={<Navigate to="chat" replace />} />
            <Route path="chat" element={<ChatTab />}>
              <Route path=":conversationId" element={<ConversationView />} />
            </Route>
            <Route path="messaging" element={<MessagingTab />} />
            <Route path="reports" element={<ReportsTab />} />
            <Route path="brain" element={<BrainTab />} />
            <Route path="graph" element={<GraphTab />} />
            <Route path="audit" element={<AuditTab />} />
            <Route path="settings" element={<SettingsTab />} />
            <Route path="metadata" element={<MetadataTab />} />
          </Route>

          {/* Standalone conversation view (MNEMO-35) - kept for deep links. */}
          <Route
            path="/agents/:agentId/conversations/:conversationId"
            element={<ConversationPage />}
          />
        </Route>
      </Route>

      {import.meta.env.DEV && (
        <Route path="/dev/components" element={<Components />} />
      )}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
