import { vi } from "vitest";

/**
 * Test seam for the responsive hooks (`useMediaQuery`/`useIsMobile`/`useBreakpoint`).
 * jsdom ships no `matchMedia`, so these helpers install a stub that evaluates the
 * `min-width`/`max-width` in a query against a chosen viewport width - letting a
 * test pin the app to a mobile or desktop viewport and assert the responsive branch.
 *
 * Always pair `stubViewport`/`stubMatchMedia` with `restoreMatchMedia()` in
 * `afterEach`, so other tests run in the default (no-matchMedia → desktop) state.
 */
export function stubViewport(width: number): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      const min = /min-width:\s*(\d+)px/.exec(query);
      let matches = true;
      if (max) matches = matches && width <= Number(max[1]);
      if (min) matches = matches && width >= Number(min[1]);
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    },
  });
}

/** Pin to a representative phone (375px) or desktop (1024px) viewport. */
export function stubMatchMedia(isMobile: boolean): void {
  stubViewport(isMobile ? 375 : 1024);
}

/** Remove the stub so jsdom returns to its default (no `matchMedia`) state. */
export function restoreMatchMedia(): void {
  Reflect.deleteProperty(window, "matchMedia");
}
