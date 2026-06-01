/**
 * Appearance catalog - the named color themes + typography pairings a user can
 * pick from the sidebar's theme picker. Each entry maps to a `[data-theme]` /
 * `[data-font]` block in `src/styles/tokens.css`; switching is pure attribute
 * flipping on <html>, so the whole token-driven UI reskins with no component or
 * feature changes. Add a look = add a palette/font block in tokens.css and an
 * entry here (and, for a web font, a family in index.html).
 *
 * The no-flash bootstrap in index.html mirrors the storage keys + the
 * dark-theme list below; keep them in sync if either changes.
 */

export interface ThemeOption {
  /** Value written to `data-theme`; matches a block in tokens.css. */
  id: string;
  label: string;
  /** Drives `color-scheme` (native controls/scrollbars) - not the palette. */
  mode: "light" | "dark";
}

export interface FontOption {
  /** Value written to `data-font`; matches a `[data-font]` block in tokens.css. */
  id: string;
  label: string;
  /** One-line character note shown in the picker. */
  note: string;
}

export const THEMES: ThemeOption[] = [
  { id: "light", label: "Light", mode: "light" },
  { id: "dark", label: "Dark", mode: "dark" },
  { id: "nord", label: "Nord", mode: "dark" },
  { id: "dracula", label: "Dracula", mode: "dark" },
  { id: "solarized", label: "Solarized", mode: "light" },
  { id: "gruvbox", label: "Gruvbox", mode: "dark" },
];

export const FONTS: FontOption[] = [
  { id: "system", label: "System", note: "Native UI stack" },
  { id: "inter", label: "Inter", note: "Modern SaaS sans" },
  { id: "dm-sans", label: "DM Sans", note: "Friendly geometric" },
  { id: "grotesk", label: "Space Grotesk", note: "Techy display" },
  { id: "serif", label: "Editorial Serif", note: "Source Serif body" },
  { id: "plex", label: "IBM Plex", note: "Technical sans + mono" },
  { id: "jetbrains", label: "JetBrains Mono", note: "Fixed-width coding" },
  {
    id: "ibm-plex-mono",
    label: "IBM Plex Mono",
    note: "Fixed-width technical",
  },
  { id: "fira-code", label: "Fira Code", note: "Fixed-width, ligatures" },
  { id: "space-mono", label: "Space Mono", note: "Fixed-width, retro" },
];

export const DEFAULT_THEME = "light";
// Space Grotesk is the brand typeface (locked on the public website, default in
// the app where each user can override it). Keep in sync with index.html's
// no-flash bootstrap fallback.
export const DEFAULT_FONT = "grotesk";

export const THEME_KEY = "mnemosyne:appearance:theme";
export const FONT_KEY = "mnemosyne:appearance:font";

export function isTheme(id: string): boolean {
  return THEMES.some((t) => t.id === id);
}

export function isFont(id: string): boolean {
  return FONTS.some((f) => f.id === id);
}

/** Flip the <html> appearance attributes + native color-scheme to match. */
export function applyAppearance(theme: string, font: string): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-font", font);
  const mode = THEMES.find((t) => t.id === theme)?.mode ?? "light";
  root.style.colorScheme = mode;
}
