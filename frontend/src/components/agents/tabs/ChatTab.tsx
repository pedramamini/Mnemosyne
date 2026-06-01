import { useCallback } from "react";
import { Outlet, useMatch, useParams } from "react-router-dom";
import { ConversationList } from "@/components/chat/ConversationList";
import { EmptyState } from "@/components/ui";
import { useAgentDetail } from "@/pages/agents/AgentDetailPage";
import type { ChatOutletContext } from "@/pages/conversations/ConversationPage";
import styles from "./ChatTab.module.css";

/**
 * ChatTab (MNEMO-36) - the agent detail Chat tab. A two-pane layout: the
 * `ConversationList` rail (MNEMO-35) on the left and the selected conversation
 * (the routed `ConversationView`, rendered via the nested `<Outlet/>`) on the
 * right. Conversations are URL-addressable under `/agents/:agentId/chat/:conversationId`
 * (plus the `new` case); selecting/creating one updates the URL. On narrow
 * viewports the rail collapses once a conversation is open so the thread takes
 * the full width (the `AppShell` responsive pattern, scoped to the pane).
 */
export function ChatTab() {
  const { agentId = "" } = useParams();
  const { agent } = useAgentDetail();
  // The active conversation id lives in the descendant route, so read it with a
  // route match rather than `useParams` (which only sees this route's params).
  const match = useMatch("/agents/:agentId/chat/:conversationId");
  const activeConversationId = match?.params.conversationId;

  const hrefFor = useCallback(
    (id: string) => `/agents/${agentId}/chat/${id}`,
    [agentId],
  );

  const outletContext: ChatOutletContext = { hrefFor, agentName: agent.name };

  return (
    <div
      className={styles.pane}
      data-conversation-open={activeConversationId ? "true" : undefined}
    >
      <aside className={styles.rail}>
        <ConversationList
          agentId={agentId}
          activeConversationId={activeConversationId}
          conversationHref={hrefFor}
        />
      </aside>
      <section className={styles.content}>
        {activeConversationId ? (
          <Outlet context={outletContext} />
        ) : (
          <EmptyState
            title="No conversation selected"
            description="Pick a conversation from the list, or start a new one."
          />
        )}
      </section>
    </div>
  );
}
