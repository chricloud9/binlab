# Refactor notes

Observations made while splitting the monolith. Everything here is
**preserved as-is** unless marked otherwise — the refactor is
behavior-preserving.

## Removed as dead code

- CSS `@media (prefers-reduced-motion:reduce){ :root{--spin:0} }`: the
  `--spin` custom property was never referenced by any rule or by JS (the
  viewer checks `matchMedia('(prefers-reduced-motion: reduce)')` directly).
  Removed; reduced-motion behavior is unchanged.
- The `window.BINGEN` global: it existed only to pass the engine from the
  first inline script to the second. Modules import the functions directly
  now, so the built page no longer defines it.
- The `// ===GEOM-START/END===` markers: the build concatenates whole module
  files, so the markers are no longer needed and were dropped.

## Latent quirks, preserved verbatim

- Drawer dimension inputs: clearing `dw`/`dd` falls back to the previous
  value (`parseFloat(...) || drawer.w`), but clearing `dclr` falls back to
  `0`. Inconsistent, kept.
- `layoutIssues` returns an array with a `bad` index-map property attached
  (array/object hybrid). Kept, since the app uses both parts.
- `deleteTray` keeps the numeric selection index, so deleting a tray that
  comes before the selected one moves the selection to the next tray rather
  than following the originally selected tray.
- `nextSpot` returns `(0, 0)` when no candidate fits, so a `+` add on a full
  drawer drops the new tray at the origin, overlapping whatever is there
  (which then gets flagged red by `layoutIssues`).
- The thin-wall stacking-lip warning triggers at `wall < 1.6` but its text
  recommends "wall ≥ 1.8 mm" — gate and message disagree slightly.
- `parseState` silently caps a shared layout at 24 trays.
- The tray X/Y number inputs clamp to ≥ 0 but not to the envelope, so typed
  positions can push a tray outside (flagged as a layout issue, not
  prevented).
