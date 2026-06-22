import { Maximize2, Minimize2, Pencil } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import {
  type ChatMessage,
  createConversation,
  getConversation,
  renameConversation,
} from "@/api/conversations";
import { Composer } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { useAgentChat } from "@/components/chat/useAgentChat";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAgentAvatars } from "@/components/layout/useAgentAvatars";
import {
  Banner,
  Button,
  Icon,
  IconButton,
  Input,
  Spinner,
} from "@/components/ui";
import styles from "./ConversationPage.module.css";

const NEW_TITLE = "New conversation";

/**
 * Where the embedding context routes conversations. The standalone page uses the
 * `/conversations/:id` scheme; the MNEMO-36 agent detail Chat tab injects its own
 * `/chat/:id` builder via outlet context so the same view works under both URLs.
 */
export interface ChatOutletContext {
  hrefFor: (conversationId: string) => string;
  /** Agent display name, supplied by the detail Chat tab for the assistant avatar. */
  agentName?: string;
  /**
   * Whether the embedding tab has collapsed its conversation rail so the thread
   * fills the panel. Supplied only by the agent detail Chat tab; absent in the
   * standalone route (there's no rail to expand into), which hides the toggle.
   */
  expanded?: boolean;
  /** Toggle the {@link expanded} layout. Presence is what renders the toggle. */
  onToggleExpand?: () => void;
}

/**
 * ConversationView (MNEMO-35) - the conversation body without app chrome, so it
 * can render standalone (inside `<AppLayout>` via {@link ConversationPage}) or
 * embedded in the agent detail Chat tab's content pane (MNEMO-36).
 *
 * It owns loading the persisted history; the inner `ConversationThread` (re-keyed
 * per conversation so its hook + title state reset on navigation) owns the live
 * chat. The `:conversationId === "new"` case starts empty and creates the
 * conversation on first send, replacing the URL with the real id.
 */
export function ConversationView() {
  const { agentId = "", conversationId = "" } = useParams();
  const ctx = useOutletContext<ChatOutletContext | null>();
  const hrefFor =
    ctx?.hrefFor ?? ((id: string) => `/agents/${agentId}/conversations/${id}`);

  const isNew = conversationId === "new";
  const [detail, setDetail] = useState<{
    title: string;
    messages: ChatMessage[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setError(null);
    getConversation(agentId, conversationId)
      .then((loaded) => {
        if (!cancelled)
          setDetail({ title: loaded.title, messages: loaded.messages });
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this conversation.");
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, conversationId, isNew]);

  if (error) {
    return (
      <div className={styles.center}>
        <Banner variant="danger" title="Something went wrong">
          {error}
        </Banner>
      </div>
    );
  }
  if (!isNew && !detail) {
    return (
      <div className={styles.center}>
        <Spinner size="lg" label="Loading conversation" />
      </div>
    );
  }

  return (
    <ConversationThread
      key={conversationId}
      agentId={agentId}
      conversationId={conversationId}
      isNew={isNew}
      initialTitle={detail?.title ?? NEW_TITLE}
      initialMessages={detail?.messages ?? []}
      hrefFor={hrefFor}
      agentName={ctx?.agentName}
      expanded={ctx?.expanded}
      onToggleExpand={ctx?.onToggleExpand}
    />
  );
}

/**
 * ConversationPage - the standalone route wrapper, mounted at
 * `/agents/:agentId/conversations/:conversationId` under `<RequireAuth>`. It
 * frames {@link ConversationView} in the shared app chrome.
 */
export function ConversationPage() {
  return (
    <AppLayout>
      <ConversationView />
    </AppLayout>
  );
}

interface ConversationThreadProps {
  agentId: string;
  conversationId: string;
  isNew: boolean;
  initialTitle: string;
  initialMessages: ChatMessage[];
  hrefFor: (conversationId: string) => string;
  /** Agent display name for the assistant avatar; defaults to a generic label. */
  agentName?: string;
  /** When the embedding tab has expanded the thread to fill the panel. */
  expanded?: boolean;
  /** Toggle the expanded layout; when omitted the toggle button is hidden. */
  onToggleExpand?: () => void;
}

/** The live chat thread: editable title, transcript, and composer. */
function ConversationThread({
  agentId,
  conversationId,
  isNew,
  initialTitle,
  initialMessages,
  hrefFor,
  agentName,
  expanded,
  onToggleExpand,
}: ConversationThreadProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const chat = useAgentChat({ agentId, conversationId, initialMessages });
  // The operator's custom avatar (same per-agent store as the dashboard/sidebar).
  const { avatarOf } = useAgentAvatars();

  const [title, setTitle] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(initialTitle);
  const [creating, setCreating] = useState(false);

  // After a "new" thread is created we navigate to its real id carrying the first
  // message in router state; this fresh instance streams it once (re-keyed per
  // conversation, so the guard ref resets with it), then clears the state so a
  // refresh doesn't resend.
  const pendingMessage = (location.state as { pendingMessage?: string } | null)
    ?.pendingMessage;
  const sentPendingRef = useRef(false);
  useEffect(() => {
    if (isNew || !pendingMessage || sentPendingRef.current) return;
    sentPendingRef.current = true;
    chat.send(pendingMessage);
    navigate(location.pathname, { replace: true, state: null });
  }, [isNew, pendingMessage, chat, navigate, location.pathname]);

  async function handleSend(overrideText?: string) {
    // `overrideText` carries a push-to-talk transcript that hasn't been written
    // back into `chat.input` yet; fall back to the composed input otherwise.
    const text = (overrideText ?? chat.input).trim();
    if (!text) return;
    if (isNew) {
      // Create the thread on first send (server seeds its title from this text),
      // then replace the URL with the real id, handing the message off in router
      // state so the re-keyed instance streams the opening turn (see the effect).
      setCreating(true);
      try {
        const created = await createConversation(agentId, text);
        navigate(hrefFor(created.id), {
          replace: true,
          state: { pendingMessage: text },
        });
      } catch {
        setCreating(false);
      }
      return;
    }
    chat.send(overrideText);
  }

  function startEditing() {
    if (isNew) return;
    setDraftTitle(title);
    setEditing(true);
  }

  async function commitTitle() {
    const next = draftTitle.trim();
    setEditing(false);
    if (!next || next === title) return;
    setTitle(next); // optimistic
    try {
      await renameConversation(agentId, conversationId, next);
    } catch {
      // Keep the optimistic title; a later load reconciles if the server differs.
    }
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitTitle();
    } else if (event.key === "Escape") {
      setEditing(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        {editing ? (
          <Input
            className={styles.titleField}
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={handleTitleKeyDown}
            aria-label="Conversation title"
          />
        ) : (
          <Button
            variant="ghost"
            leftIcon={<Icon icon={Pencil} size="sm" />}
            onClick={startEditing}
            disabled={isNew}
          >
            {title}
          </Button>
        )}
        {onToggleExpand ? (
          <>
            <span className={styles.headerSpacer} />
            <IconButton
              size="sm"
              label={expanded ? "Collapse chat" : "Expand chat"}
              aria-pressed={expanded}
              icon={<Icon icon={expanded ? Minimize2 : Maximize2} size="sm" />}
              onClick={onToggleExpand}
            />
          </>
        ) : null}
      </div>

      <MessageList
        messages={chat.messages}
        status={chat.status}
        agentId={agentId}
        agentName={agentName ?? "Agent"}
        agentAvatarUrl={avatarOf(agentId)}
      />

      <Composer
        value={chat.input}
        onChange={chat.setInput}
        onSend={handleSend}
        status={creating ? "submitted" : chat.status}
        onStop={chat.stop}
      />
    </div>
  );
}
