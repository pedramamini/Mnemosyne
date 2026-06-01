import type { LucideIcon, LucideProps } from "lucide-react";
import { forwardRef } from "react";

type IconSize = "sm" | "md" | "lg";

export interface IconProps extends Omit<LucideProps, "ref" | "size"> {
  /** The lucide-react icon component to render. */
  icon: LucideIcon;
  /** Size token. Default `md`. Maps to a pixel size; color inherits via `currentColor`. */
  size?: IconSize;
  /**
   * Accessible label. When omitted the icon is `aria-hidden` (decorative);
   * when provided it gets `role="img"` + `aria-label`.
   */
  label?: string;
}

const SIZE_PX: Record<IconSize, number> = { sm: 16, md: 20, lg: 24 };

/**
 * Icon - the single wrapper for all iconography (lucide-react). Centralizing
 * here keeps sizing/coloring consistent and lets us swap the icon set later.
 */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { icon: LucideGlyph, size = "md", label, ...rest },
  ref,
) {
  return (
    <LucideGlyph
      ref={ref}
      size={SIZE_PX[size]}
      color="currentColor"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      {...rest}
    />
  );
});
