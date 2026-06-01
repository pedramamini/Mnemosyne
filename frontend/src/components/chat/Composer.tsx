import { ArrowUp, Hand, Mic, Square } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon, IconButton, Textarea, useToast } from "@/components/ui";
import { cx } from "@/components/ui/utils";
import { isSpeechAvailable, SpeechSession } from "@/lib/speech";
import styles from "./Composer.module.css";
import type { ChatStatus } from "./useAgentChat";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Send a message. Pass `overrideText` to submit an exact string regardless of
   * the controlled `value` - used by push-to-talk, whose transcript arrives in a
   * callback and can't wait for `onChange` state to flush before sending.
   */
  onSend: (overrideText?: string) => void;
  /** Streaming status; while busy the send button becomes a stop button. */
  status: ChatStatus;
  /** Abort the in-flight turn. */
  onStop: () => void;
  placeholder?: string;
}

type ActiveMode = "handsfree" | "ptt" | null;

/**
 * Composer (MNEMO-35) - the message input. A multi-line, auto-growing textarea
 * (capped, then scrolls) plus a send action. Enter sends; Shift+Enter inserts a
 * newline. While a turn is streaming the send button is replaced by a stop
 * button that aborts. Sticks to the bottom and is safe-area aware for mobile.
 *
 * Voice (donor: Crema): when the Web Speech API is available two controls flank
 * the textarea - push-to-talk (hold the button or ⌃Control; release to send in
 * one shot) and hands-free (tap to toggle; auto-sends after a beat of silence).
 * The {@link SpeechSession} engine lives in `@/lib/speech`; this component only
 * wires it to the controlled input.
 */
export function Composer({
  value,
  onChange,
  onSend,
  status,
  onStop,
  placeholder = "Message your agent…",
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = status === "streaming" || status === "submitted";
  const { toast } = useToast();

  const speechSupported = useMemo(() => isSpeechAvailable(), []);
  const [activeMode, setActiveMode] = useState<ActiveMode>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");

  const speechRef = useRef<SpeechSession | null>(null);
  const activeModeRef = useRef<ActiveMode>(null);
  // Set on PTT start so the session's onComplete (fired on release) submits the
  // transcript rather than merely surfacing it.
  const pttShouldSubmitRef = useRef(false);

  // Keep live refs of the controlled props + toast so the speech callbacks
  // (created once with the session) always see fresh values without tearing
  // down and rebuilding the recognition session on every render.
  const liveRef = useRef({ value, onChange, onSend, toast });
  liveRef.current = { value, onChange, onSend, toast };

  useEffect(() => {
    activeModeRef.current = activeMode;
  }, [activeMode]);

  // Auto-grow: reset to measure, then match content height (CSS caps + scrolls).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on each value change.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // Build the recognition session once. Mode is patched in place per control.
  useEffect(() => {
    if (!speechSupported) return;
    const session = new SpeechSession({
      mode: "ptt",
      silenceMs: 2200,
      callbacks: {
        onInterim: (t) => setInterim(t),
        onFinal: (chunk, mode) => {
          setInterim("");
          // PTT keeps the box clean and submits the whole transcript on release
          // (onComplete). Hands-free streams finals into the box so the user
          // sees what was heard; the box is then the source of truth on submit.
          if (mode === "handsfree") {
            const cur = liveRef.current.value;
            liveRef.current.onChange(cur ? `${cur} ${chunk}` : chunk);
          }
        },
        onSilence: () => {
          // Hands-free auto-send. Finals already landed in the box via onChange,
          // and the silence beat (2.2s) guarantees that state has flushed, so a
          // plain send picks up the typed text + transcript together.
          setInterim("");
          liveRef.current.onSend();
        },
        onComplete: (full, mode) => {
          if (mode !== "ptt" || !pttShouldSubmitRef.current) return;
          pttShouldSubmitRef.current = false;
          setInterim("");
          const transcript = full.trim();
          const typed = liveRef.current.value.trim();
          const composed =
            typed && transcript
              ? `${typed} ${transcript}`
              : typed || transcript;
          if (composed) liveRef.current.onSend(composed);
        },
        onError: (code, message) => {
          if (code === "permission-denied") {
            liveRef.current.toast({
              title: "Mic permission denied",
              description: message,
              variant: "danger",
            });
          } else if (code !== "aborted" && code !== "no-speech") {
            liveRef.current.toast({
              title: "Mic error",
              description: message,
              variant: "danger",
            });
          }
          pttShouldSubmitRef.current = false;
          setListening(false);
          setActiveMode(null);
        },
        onStateChange: (s) => {
          const isListening = s === "listening";
          setListening(isListening);
          if (!isListening) setActiveMode(null);
        },
      },
    });
    speechRef.current = session;
    return () => {
      session.destroy();
      speechRef.current = null;
    };
  }, [speechSupported]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!busy && value.trim()) onSend();
    }
  }

  // Hands-free: tap-toggle; auto-sends after a silence beat.
  function onHandsFreeClick() {
    const session = speechRef.current;
    if (!session) return;
    if (activeMode === "handsfree" && listening) {
      session.stop();
      return;
    }
    session.setMode("handsfree");
    setActiveMode("handsfree");
    session.start();
  }

  // PTT: press-and-hold, release to send.
  const startPtt = useCallback(() => {
    const session = speechRef.current;
    if (!session || activeModeRef.current !== null) return;
    pttShouldSubmitRef.current = true;
    session.setMode("ptt");
    setActiveMode("ptt");
    session.start();
  }, []);

  const stopPtt = useCallback(() => {
    // pttShouldSubmitRef stays true so the session's onComplete fires the send.
    speechRef.current?.stop();
  }, []);

  function onPttDown(e: PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    // Pointer capture keeps pointerup firing even if the cursor drifts off-button.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    startPtt();
  }

  function onPttUp(e: PointerEvent<HTMLButtonElement>) {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    stopPtt();
  }

  // Global ⌃Control-hold → PTT. Armed after a short grace so chord shortcuts
  // (Ctrl+C, Ctrl+S, …) don't briefly flap the mic. While armed, any other key
  // cancels; once started, only Control-up (or window blur) stops it.
  useEffect(() => {
    if (!speechSupported) return;
    const ARM_MS = 180;
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    let ctrlPttActive = false;

    const cancelArm = () => {
      if (armTimer) {
        clearTimeout(armTimer);
        armTimer = null;
      }
    };

    const onKeyDown = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Control") {
        cancelArm();
        return;
      }
      if (ev.repeat || ctrlPttActive || armTimer) return;
      if (ev.shiftKey || ev.altKey || ev.metaKey) return;
      if (activeModeRef.current !== null) return;
      armTimer = setTimeout(() => {
        armTimer = null;
        ctrlPttActive = true;
        startPtt();
      }, ARM_MS);
    };

    const onKeyUp = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Control") return;
      cancelArm();
      if (ctrlPttActive) {
        ctrlPttActive = false;
        stopPtt();
      }
    };

    const onBlur = () => {
      // If the window loses focus mid-hold, browsers may drop the keyup; bail
      // out so the mic doesn't stay stuck on.
      cancelArm();
      if (ctrlPttActive) {
        ctrlPttActive = false;
        pttShouldSubmitRef.current = false;
        speechRef.current?.stop();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelArm();
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [speechSupported, startPtt, stopPtt]);

  return (
    <div className={styles.composer}>
      <div className={styles.inputRow}>
        {speechSupported && (
          <div className={styles.micGroup}>
            <IconButton
              className={cx(
                activeMode === "ptt" && listening && styles.listening,
              )}
              label="Push and hold to talk, release to send (or hold ⌃ Control)"
              variant={activeMode === "ptt" ? "primary" : "ghost"}
              icon={<Icon icon={Hand} size="sm" />}
              disabled={busy}
              onPointerDown={onPttDown}
              onPointerUp={onPttUp}
              onPointerCancel={onPttUp}
            />
            <IconButton
              className={cx(
                activeMode === "handsfree" && listening && styles.listening,
              )}
              label={
                activeMode === "handsfree"
                  ? "Stop hands-free listening"
                  : "Hands-free: tap to listen, auto-sends after a pause"
              }
              variant={activeMode === "handsfree" ? "primary" : "ghost"}
              icon={<Icon icon={Mic} size="sm" />}
              aria-pressed={activeMode === "handsfree"}
              disabled={busy}
              onClick={onHandsFreeClick}
            />
          </div>
        )}
        <div className={styles.field}>
          <Textarea
            ref={ref}
            className={styles.textarea}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={listening ? "Listening…" : placeholder}
            aria-label="Message"
          />
        </div>
        {busy ? (
          <IconButton
            className={styles.action}
            label="Stop"
            variant="secondary"
            icon={<Icon icon={Square} size="sm" />}
            onClick={onStop}
          />
        ) : (
          <IconButton
            className={styles.action}
            label="Send"
            variant="primary"
            icon={<Icon icon={ArrowUp} size="sm" />}
            disabled={!value.trim()}
            onClick={() => onSend()}
          />
        )}
      </div>
      {speechSupported && (
        <div className={styles.interim}>
          {interim && (
            <>
              <span className={styles.interimLabel}>interim</span>
              {interim}
            </>
          )}
        </div>
      )}
    </div>
  );
}
