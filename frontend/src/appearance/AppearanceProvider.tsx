import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePersistentState } from "@/lib/usePersistentState";
import {
  applyAppearance,
  DEFAULT_FONT,
  DEFAULT_THEME,
  FONT_KEY,
  isFont,
  isTheme,
  THEME_KEY,
} from "./appearance";

interface AppearanceContextValue {
  /** Committed (persisted) color theme id (a `data-theme` value). */
  theme: string;
  setTheme: (id: string) => void;
  /** Committed (persisted) typography id (a `data-font` value). */
  font: string;
  setFont: (id: string) => void;
  /** Apply a theme to <html> transiently (no persist) for live preview. */
  previewTheme: (id: string) => void;
  /** Apply a font to <html> transiently (no persist) for live preview. */
  previewFont: (id: string) => void;
  /** Drop any transient preview, restoring the committed theme + font. */
  clearPreview: () => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

/**
 * AppearanceProvider - owns the persisted theme + typeface selection and applies
 * them to <html> on every change. Mounted at the app root so every route
 * (including login) is themed; the no-flash script in index.html applies the
 * same attributes before React mounts, and this provider keeps them in step.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [storedTheme, setStoredTheme] = usePersistentState(
    THEME_KEY,
    DEFAULT_THEME,
  );
  const [storedFont, setStoredFont] = usePersistentState(
    FONT_KEY,
    DEFAULT_FONT,
  );
  // Transient overrides driven by the ⌘K palette as the user cycles options.
  const [draftTheme, setDraftTheme] = useState<string | null>(null);
  const [draftFont, setDraftFont] = useState<string | null>(null);

  // Guard against stale/removed ids in storage falling through to a blank skin.
  const theme = isTheme(storedTheme) ? storedTheme : DEFAULT_THEME;
  const font = isFont(storedFont) ? storedFont : DEFAULT_FONT;

  // A live preview overrides the committed value on <html> without persisting,
  // so dismissing the palette (or clearing the preview) restores the saved skin.
  const shownTheme = draftTheme && isTheme(draftTheme) ? draftTheme : theme;
  const shownFont = draftFont && isFont(draftFont) ? draftFont : font;

  useEffect(() => {
    applyAppearance(shownTheme, shownFont);
  }, [shownTheme, shownFont]);

  const setTheme = useCallback(
    (id: string) => {
      setDraftTheme(null);
      setStoredTheme(id);
    },
    [setStoredTheme],
  );
  const setFont = useCallback(
    (id: string) => {
      setDraftFont(null);
      setStoredFont(id);
    },
    [setStoredFont],
  );
  const previewTheme = useCallback((id: string) => setDraftTheme(id), []);
  const previewFont = useCallback((id: string) => setDraftFont(id), []);
  const clearPreview = useCallback(() => {
    setDraftTheme(null);
    setDraftFont(null);
  }, []);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      theme,
      setTheme,
      font,
      setFont,
      previewTheme,
      previewFont,
      clearPreview,
    }),
    [theme, setTheme, font, setFont, previewTheme, previewFont, clearPreview],
  );

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

/** Read + set the active theme/typeface. Throws outside the provider. */
export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) {
    throw new Error("useAppearance must be used within <AppearanceProvider>");
  }
  return ctx;
}
