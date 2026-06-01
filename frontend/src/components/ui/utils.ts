/**
 * Internal helpers shared across the `components/ui` primitives.
 * Not part of the public surface - feature code imports components, not these.
 */

import type { CSSProperties } from "react";
import type { SpaceScale } from "@/styles/tokens";

/** Join truthy class names into a single `className` string. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Resolve a spacing-scale key to its `var(--space-N)` reference. */
export function space(step: SpaceScale): string {
  return `var(--space-${step})`;
}

/**
 * Build a style object that maps a set of optional spacing props onto the
 * matching CSS properties via tokens. Returns `undefined` keys are dropped so
 * the result can be spread into a `style` prop without clobbering.
 */
export function spacingStyle(props: {
  p?: SpaceScale;
  px?: SpaceScale;
  py?: SpaceScale;
  pt?: SpaceScale;
  pr?: SpaceScale;
  pb?: SpaceScale;
  pl?: SpaceScale;
  m?: SpaceScale;
  mx?: SpaceScale;
  my?: SpaceScale;
  mt?: SpaceScale;
  mr?: SpaceScale;
  mb?: SpaceScale;
  ml?: SpaceScale;
}): CSSProperties {
  const s: CSSProperties = {};
  if (props.p !== undefined) s.padding = space(props.p);
  if (props.px !== undefined) {
    s.paddingLeft = space(props.px);
    s.paddingRight = space(props.px);
  }
  if (props.py !== undefined) {
    s.paddingTop = space(props.py);
    s.paddingBottom = space(props.py);
  }
  if (props.pt !== undefined) s.paddingTop = space(props.pt);
  if (props.pr !== undefined) s.paddingRight = space(props.pr);
  if (props.pb !== undefined) s.paddingBottom = space(props.pb);
  if (props.pl !== undefined) s.paddingLeft = space(props.pl);
  if (props.m !== undefined) s.margin = space(props.m);
  if (props.mx !== undefined) {
    s.marginLeft = space(props.mx);
    s.marginRight = space(props.mx);
  }
  if (props.my !== undefined) {
    s.marginTop = space(props.my);
    s.marginBottom = space(props.my);
  }
  if (props.mt !== undefined) s.marginTop = space(props.mt);
  if (props.mr !== undefined) s.marginRight = space(props.mr);
  if (props.mb !== undefined) s.marginBottom = space(props.mb);
  if (props.ml !== undefined) s.marginLeft = space(props.ml);
  return s;
}

/** Spacing props mixin reused by layout primitives. */
export interface SpacingProps {
  p?: SpaceScale;
  px?: SpaceScale;
  py?: SpaceScale;
  pt?: SpaceScale;
  pr?: SpaceScale;
  pb?: SpaceScale;
  pl?: SpaceScale;
  m?: SpaceScale;
  mx?: SpaceScale;
  my?: SpaceScale;
  mt?: SpaceScale;
  mr?: SpaceScale;
  mb?: SpaceScale;
  ml?: SpaceScale;
}
