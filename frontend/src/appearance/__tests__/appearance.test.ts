import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT,
  DEFAULT_THEME,
  isFont,
  isTheme,
} from "../appearance";

describe("appearance defaults", () => {
  it("defaults the app font to the Space Grotesk brand face", () => {
    // The public website is locked to this face (App.tsx PublicChrome); the app
    // ships it as the default but lets each user override it.
    expect(DEFAULT_FONT).toBe("grotesk");
    expect(isFont(DEFAULT_FONT)).toBe(true);
  });

  it("defaults to a valid theme", () => {
    expect(isTheme(DEFAULT_THEME)).toBe(true);
  });
});
