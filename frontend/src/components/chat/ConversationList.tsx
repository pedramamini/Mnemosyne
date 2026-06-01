import { Plus } from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type Conversation,
  listConversations,
  searchConversations,
} from "@/api/conversations";
import {
  Button,
  EmptyState,
  Icon,
  NavItem,
  SearchInput,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./ConversationList.module.css";

export interface ConversationListProps {
  agentId: string;
  /** The currently-open conversation (highlighted in the rail). */
  activeConversationId?: string;
  /**
   * Build the href for a conversation id (and the `"new"` sentinel). Defaults to
   * the standalone `/agents/:id/conversations/:id` scheme; the MNEMO-36 Chat tab
   * injects its `/agents/:id/chat/:id` builder so the rail links stay in-shell.
   */
  conversationHref?: (conversationId: string) => string;
}

/** Debounce window for the search box (ms). */
const SEARCH_DEBOUNCE_MS = 250;

/** Compact relative time: "just now", "5m", "3h", "2d", else a short date. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function byNewest(a: Conversation, b: Conversation): number {
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

/**
 * ConversationList (MNEMO-35) - the conversation-centric nav rail for one agent.
 * Lists threads newest-first with title + last-message preview + relative time,
 * highlights the active thread, and offers a "New conversation" action and a
 * debounced keyword search (PRD §6.5). Embedded in the agent detail chat tab
 * (MNEMO-36).
 */
export function ConversationList({
  agentId,
  activeConversationId,
  conversationHref = (id) => `/agents/${agentId}/conversations/${id}`,
}: ConversationListProps) {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[] | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Conversation[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Load the full list on mount / agent change (shows the loading spinner).
  useEffect(() => {
    let cancelled = false;
    setConversations(null);
    listConversations(agentId)
      .then((list) => {
        if (!cancelled) setConversations(list);
      })
      .catch(() => {
        if (!cancelled) setConversations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Refresh in place when the active conversation changes - e.g. right after a
  // "new" thread is created and navigated to, so it appears in the rail without a
  // full page reload. Deliberately does NOT reset to `null` (no spinner flash);
  // the rail keeps showing the current list while the refetch lands.
  useEffect(() => {
    if (!activeConversationId) return;
    let cancelled = false;
    listConversations(agentId)
      .then((list) => {
        if (!cancelled) setConversations(list);
      })
      .catch(() => {
        /* keep the existing list on a transient refresh failure */
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, activeConversationId]);

  // Debounced keyword search; an empty query falls back to the full list.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      searchConversations(agentId, q)
        .then((list) => {
          if (!cancelled) setResults(list);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [agentId, query]);

  const isSearch = query.trim().length > 0;
  const displayed = useMemo(() => {
    const source = isSearch ? (results ?? []) : (conversations ?? []);
    return [...source].sort(byNewest);
  }, [isSearch, results, conversations]);

  const loading = isSearch
    ? searching && results === null
    : conversations === null;

  function newConversation() {
    navigate(conversationHref("new"));
  }

  // Real anchor (valid href, a11y-clean) with client-side navigation on click,
  // matching the AppLayout NavItem pattern (raw <a> is banned outside the UI lib).
  function openConversation(path: string) {
    return (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      navigate(path);
    };
  }

  return (
    <div className={styles.rail}>
      <Button
        fullWidth
        leftIcon={<Icon icon={Plus} size="sm" />}
        onClick={newConversation}
      >
        New conversation
      </Button>

      <SearchInput
        aria-label="Search conversations"
        placeholder="Search conversations…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onClear={() => setQuery("")}
      />

      {loading ? (
        <div className={styles.center}>
          <Spinner label="Loading conversations" />
        </div>
      ) : displayed.length === 0 ? (
        <EmptyState
          title={
            isSearch ? "No matching conversations" : "No conversations yet"
          }
          description={
            isSearch
              ? "Try a different search term."
              : "Start a new conversation to begin."
          }
        />
      ) : (
        <nav className={styles.list} aria-label="Conversations">
          {displayed.map((conversation) => {
            const path = conversationHref(conversation.id);
            return (
              <NavItem
                key={conversation.id}
                href={path}
                onClick={openConversation(path)}
                active={conversation.id === activeConversationId}
                className={styles.item}
                trailing={
                  <Text size="xs" color="text-muted">
                    {relativeTime(conversation.updated_at)}
                  </Text>
                }
              >
                <Stack gap="0" className={styles.itemBody}>
                  <Text size="sm" weight="medium" truncate>
                    {conversation.title}
                  </Text>
                  {conversation.lastMessagePreview && (
                    <Text size="xs" color="text-muted" truncate>
                      {conversation.lastMessagePreview}
                    </Text>
                  )}
                </Stack>
              </NavItem>
            );
          })}
        </nav>
      )}
    </div>
  );
}
