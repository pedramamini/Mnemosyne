import { useCallback, useEffect, useRef, useState } from "react";

/**
 * usePersistentState - a `useState` whose value is mirrored into `localStorage`
 * under `key`, so client-only UI preferences (sidebar collapse, agent grouping,
 * agent avatars) survive a reload. JSON-parse failures and disabled/quota-full
 * storage degrade silently to the in-memory value rather than throwing.
 *
 * Instances that share a `key` stay in sync: a write notifies sibling instances
 * in the same tab (so e.g. changing an avatar on a card updates the sidebar
 * live) and `storage` events keep other tabs in step. The key is read once on
 * mount - pass a key that's settled at first render (e.g. one embedding the
 * account id, which resolves before the authed chrome renders).
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, initial));

  // Mirror the latest value so `set`'s functional form reads fresh state
  // without re-creating the callback on every change.
  const valueRef = useRef(value);
  valueRef.current = value;

  // Keep this instance in step with sibling instances (same tab) and other
  // tabs (the native `storage` event).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `initial` is the mount-time default; re-subscribing on its identity would thrash.
  useEffect(() => {
    const onLocal = (next: unknown) => setValue(next as T);
    subscribe(key, onLocal);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setValue(read(key, initial));
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe(key, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function"
          ? (next as (p: T) => T)(valueRef.current)
          : next;
      valueRef.current = resolved;
      setValue(resolved);
      write(key, resolved);
      // Notify sibling instances. This instance's own subscriber re-sets the
      // same reference, which React skips (Object.is bail-out) - no extra render.
      broadcast(key, resolved);
    },
    [key],
  );

  return [value, set] as const;
}

// ─── Same-tab pub/sub keyed by storage key ──────────────────────────────────

const listeners = new Map<string, Set<(value: unknown) => void>>();

function subscribe(key: string, fn: (value: unknown) => void): void {
  const set = listeners.get(key) ?? new Set();
  set.add(fn);
  listeners.set(key, set);
}

function unsubscribe(key: string, fn: (value: unknown) => void): void {
  listeners.get(key)?.delete(fn);
}

function broadcast(key: string, value: unknown): void {
  for (const fn of listeners.get(key) ?? []) fn(value);
}

// ─── localStorage access (guarded) ──────────────────────────────────────────

/** Read + JSON-parse `key`, falling back to `fallback` on any failure. */
function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Persist `value` as JSON under `key`; swallow quota/disabled-storage errors. */
function write<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage disabled or full - the preference just won't persist this session.
  }
}
