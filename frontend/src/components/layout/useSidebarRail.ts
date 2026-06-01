import { useAppShell } from "@/components/ui";
import { useIsMobile } from "./useBreakpoint";

/**
 * Whether the sidebar should render as a collapsed icon RAIL: the persisted
 * collapse preference is on AND we're on a wide viewport. On narrow viewports
 * the sidebar is an off-canvas drawer that always shows full-width content, so
 * the rail never applies there.
 */
export function useSidebarRail(): boolean {
  const shell = useAppShell();
  const isMobile = useIsMobile();
  return Boolean(shell?.collapsed) && !isMobile;
}
