import { X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconButton } from "./IconButton";
import { Portal } from "./Portal";
import styles from "./Toast.module.css";
import { cx } from "./utils";

export type ToastVariant = "info" | "success" | "warning" | "danger";

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms. `0` keeps it until dismissed. Default `5000`. */
  duration?: number;
}

interface ToastRecord extends Required<Omit<ToastOptions, "description">> {
  id: string;
  description?: ReactNode;
}

interface ToastContextValue {
  /** Enqueue a toast; returns its id. */
  toast: (opts: ToastOptions) => string;
  /** Dismiss a toast by id. */
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Access the toast API. Throws if used outside <ToastProvider>. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a <ToastProvider>");
  return ctx;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `toast-${counter}`;
}

export interface ToastProviderProps {
  children: ReactNode;
}

/** Provider that owns the toast queue and renders the Toaster region. */
export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (opts: ToastOptions) => {
      const id = nextId();
      const record: ToastRecord = {
        id,
        title: opts.title,
        description: opts.description,
        variant: opts.variant ?? "info",
        duration: opts.duration ?? 5000,
      };
      setToasts((prev) => [...prev, record]);
      if (record.duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), record.duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  // Clear pending timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) clearTimeout(handle);
      map.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toast, dismiss }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

interface ToasterProps {
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
}

/** Toaster - the live region that stacks active toasts (portaled, top-right). */
function Toaster({ toasts, onDismiss }: ToasterProps) {
  if (toasts.length === 0) return null;
  return (
    <Portal>
      <div className={styles.region} role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.variant === "danger" ? "alert" : "status"}
            aria-live={t.variant === "danger" ? "assertive" : "polite"}
            className={cx(styles.toast, styles[t.variant])}
          >
            <div className={styles.content}>
              <p className={styles.title}>{t.title}</p>
              {t.description && (
                <p className={styles.description}>{t.description}</p>
              )}
            </div>
            <IconButton
              label="Dismiss notification"
              icon={<X size={16} />}
              size="sm"
              onClick={() => onDismiss(t.id)}
            />
          </div>
        ))}
      </div>
    </Portal>
  );
}
