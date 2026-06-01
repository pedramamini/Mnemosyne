import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export interface PortalProps {
  children: ReactNode;
}

/**
 * Portal - renders children into `document.body` so overlays escape ancestor
 * stacking/overflow contexts. Renders synchronously when a document exists (the
 * browser/jsdom) so overlay refs are committed before consumers' effects run
 * (e.g. Modal's focus trap); returns null when there is no document (SSR).
 */
export function Portal({ children }: PortalProps) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
