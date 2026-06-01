---
type: reference
title: Shared Component Library - Reuse Contract
created: 2026-05-25
tags:
  - frontend
  - design-system
  - components
related:
  - '[[MNEMO-32]]'
  - '[[PRD]]'
---

# `components/ui` - the canonical shared component library

This directory is the **single source of UI primitives** for the Mnemosyne
frontend. It was built up front in **MNEMO-32** and every feature phase (33–43)
composes these components. It is **token-driven**: each component references the
design tokens in `src/styles/tokens.css` for every color, space, font, radius,
shadow, z-index, and motion value - so the whole product can be reskinned by
swapping tokens, without touching a single component or feature screen.

## The reuse contract (non-negotiable)

1. **Import UI only from `@/components/ui`.**

   ```tsx
   import { Button, Input, FormField, Modal } from "@/components/ui";
   ```

2. **Never write raw interactive HTML in feature code.** The elements
   `<button>`, `<input>`, `<select>`, `<textarea>`, and action `<a>` are
   **banned** anywhere under `src/` *except* inside `src/components/ui/`. Use the
   primitive instead:

   | Instead of…        | Use…                                                |
   | ------------------ | --------------------------------------------------- |
   | `<button>`         | `Button` / `IconButton`                             |
   | `<input>`          | `Input` / `Checkbox` / `Radio` / `Switch` / `SearchInput` |
   | `<select>`         | `Select`                                            |
   | `<textarea>`       | `Textarea`                                          |
   | action `<a>`       | `NavItem`, or react-router `<Link>` routed through a primitive |

   This is enforced by Biome's `noRestrictedElements` rule (see
   `frontend/biome.json`), scoped so it errors in feature code and is disabled
   only inside `components/ui/`. `npm run lint` fails the build on a violation.

3. **Never build a one-off styled control.** If a primitive is missing, **add it
   here** - create `NewThing.tsx` + `NewThing.module.css`, export it from
   `index.ts`, and register it in the catalog (`src/pages/dev/Components.tsx`).
   Then consume it from `@/components/ui`. Do not style controls locally.

4. **Components reference tokens only.** No hardcoded hex colors, pixel sizes,
   shadows, or durations inside a component - always `var(--token)`. Tests assert
   token-driven classes rather than inline literal styles.

## What's in here

- **Layout:** `Box`, `Stack`, `Inline`, `Grid`, `Container`/`Page`, `Panel`/`Card`, `Divider`
- **Typography:** `Text`, `Heading`, `Code`, `Kbd`
- **Actions + icons:** `Button`, `IconButton`, `BackButton`, `LinkButton`, `Icon`
- **Form controls:** `FormField`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `SearchInput`
- **Overlays + feedback:** `Modal`/`Dialog`, `Drawer`, `Tooltip`, `Menu`/`Dropdown`, `ToastProvider` + `useToast`, `Banner`/`Alert`, `Portal`
- **Status + data display:** `Badge`/`Tag`, `Avatar`, `Spinner`, `Skeleton`, `ProgressBar`, `EmptyState`, `Table`, `Tabs`, `Pagination`, `List`
- **Application shell:** `AppShell`, `Sidebar`, `TopBar`, `NavItem`

> **Responsive layout primitives** live one level up in `@/components/layout`
> (MNEMO-43): the `useBreakpoint`/`useIsMobile`/`useMediaQuery` hooks (the JS mirror
> of the `--bp-*` tokens) and `<ResponsiveMasterDetail>` (two-pane on desktop, a
> push/back detail view on mobile). Import responsive helpers from there; keep
> CSS-only responsiveness in `@media` queries against the breakpoint tokens.

## Catalog (living style guide)

`src/pages/dev/Components.tsx`, mounted at **`/dev/components`** (dev builds only),
renders every component in all variants/sizes/states plus a light/dark theme
toggle. Use it to verify a new or changed primitive - and that theming is purely
token-driven.

## Adding a primitive - checklist

- [ ] `NewThing.tsx` + co-located `NewThing.module.css`, < 500 lines, token-driven, accessible (ARIA + keyboard), strongly typed.
- [ ] Export the component **and its prop type** from `index.ts`.
- [ ] Add it to the catalog in `src/pages/dev/Components.tsx`.
- [ ] Add a test under `__tests__/` for any interactive behavior.
