import { useState } from "react";
import { ResponsiveMasterDetail } from "@/components/layout";
import { MessagingAccessCard } from "@/components/messaging/MessagingAccessCard";
import { MessagingStatusCard } from "@/components/messaging/MessagingStatusCard";
import { SessionList } from "@/components/messaging/SessionList";
import { SessionThread } from "@/components/messaging/SessionThread";
import {
  useMessagingAccess,
  useMessagingSessions,
  useMessagingStatus,
} from "@/components/messaging/useMessaging";
import { EmptyState, Heading, Stack } from "@/components/ui";
import { useAgentDetail } from "@/pages/agents/AgentDetailPage";
import styles from "./MessagingTab.module.css";

/**
 * MessagingTab (PRD §9) - the agent detail Messaging tab. Composes the on/off
 * status control, the access/whitelist editor, and the conversation browser
 * (session rail + transcript) over the `@/api/messaging` routes. The session
 * list and thread share the responsive master/detail layout so it collapses to
 * one pane on mobile.
 */
export function MessagingTab() {
  const { agent } = useAgentDetail();
  const agentId = agent.id;

  const status = useMessagingStatus(agentId);
  const access = useMessagingAccess(agentId);
  const sessions = useMessagingSessions(agentId);

  const [activeSessionId, setActiveSessionId] = useState<string>();

  return (
    <Stack gap="5">
      <MessagingStatusCard
        agentId={agentId}
        status={status.data}
        loading={status.loading}
        error={status.error}
        onChanged={status.refetch}
      />

      <MessagingAccessCard
        agentId={agentId}
        access={access.data}
        loading={access.loading}
        error={access.error}
        onChanged={access.refetch}
      />

      <Stack gap="2">
        <Heading level={3}>Conversations</Heading>
        <div className={styles.browser}>
          <ResponsiveMasterDetail
            masterWidth="20rem"
            showDetail={activeSessionId !== undefined}
            backLabel="All conversations"
            onBack={() => setActiveSessionId(undefined)}
            master={
              <SessionList
                sessions={sessions.data}
                loading={sessions.loading}
                error={sessions.error}
                activeSessionId={activeSessionId}
                onSelect={setActiveSessionId}
              />
            }
            detail={
              activeSessionId ? (
                <SessionThread agentId={agentId} sessionId={activeSessionId} />
              ) : (
                <EmptyState
                  title="No conversation selected"
                  description="Pick a thread on the left to read its transcript."
                />
              )
            }
          />
        </div>
      </Stack>
    </Stack>
  );
}
