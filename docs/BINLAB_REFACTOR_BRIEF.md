# BinLab refactor brief

## Context

BinLab is a browser-based parametric generator for 3D-printable storage bins and multi-tray drawer layouts. Live three.js (r128, cdnjs) preview, binary STL export, no server, no account. It currently ships as one 56 KB `index.html` that grew by successive patching. It works and is verified, but reads as a monolith. The job is to restructure it into a clean, tested repo **without changing behavior or geometry output**.

Starting point: `index.html`, `README.md`, `LICENSE` in this directory. The geometry engine is delimited inside `index.html` by the comment markers `// ===GEOM-START===` and `// ===GEOM-END===`. The UI script is the second inline `<script>` block.

## Non-goals

- No new features. No UX changes. No geometry changes.
- No framework, no TypeScript, no bundler beyond a ~60-line build script.
- No runtime dependencies beyond the existing three.js r128 cdnjs script tag.
- `dist/index.html` must still open directly from `file://` (so: classic script, not ES modules, in the built output).

## Step 0: freeze behavior before touching anything

1. `npm init -y`, `npm i -D three@0.128.0`.
2. Extract the geometry block from the current `index.html` into a scratch file, load it in node with `globalThis.THREE = require('three')`, and generate binary STL fixtures for every preset in the "Fixture presets" section below. Save them to `test/fixtures/<name>.stl`.
3. Commit these fixtures first. They are the oracle: the refactored engine must reproduce them **byte-for-byte**. If a deliberate change ever makes that impossible, stop and explain before regenerating fixtures.

## Target layout

```
binlab/
  src/
    geometry.js      # pure engine: buildParts, computeStats, partVolume, exportSTL. No DOM.
    layout.js        # pure: overlapsAny, nextSpot, snapAxis, emptyRectAt, layoutIssues, serialize/parse state. No DOM, no three.
    viewer.js        # three.js scene, lights, grid, orbit, pick/drag plane math, hover highlight, drawer wireframe
    app.js           # DOM controls, tray bar, presets, title block, fit checker, download, share, keyboard, wiring
    styles.css
    index.template.html   # markup with <!-- STYLES --> and <!-- SCRIPTS --> markers
  test/
    geometry.test.js
    layout.test.js
    fixtures/*.stl
  scripts/
    build.js         # -> dist/index.html
  .github/workflows/ci.yml      # npm test + npm run build on push/PR
  .github/workflows/pages.yml   # deploy dist/ to GitHub Pages on main
  dist/index.html    # committed build output (so the file is downloadable from the repo)
  package.json       # devDependencies: three@0.128.0 only. scripts: test, build, check (test+build)
  README.md
  LICENSE
```

## Modernization rules

- ES2020 in `src/`: `const`/`let`, arrow functions, template literals, `export`/`import` between modules.
- `scripts/build.js` strips `import`/`export` lines, concatenates modules in dependency order (geometry → layout → viewer → app), wraps the result in a single IIFE, inlines `styles.css`, and writes `dist/index.html`. Output must be a classic `<script>`, not `type="module"`.
- Keep every geometry function name, part name (`walls`, `floor`, `collar`, `skirt`, `groove`, `center`, `rim`, `scoop`, `tab`, `fillet`), part emission order, and every constant exactly as is. The fixture test enforces this.
- Add JSDoc on exported functions. Brief comments where the math is non-obvious (the corner-wall guard, the sweep winding auto-flip, the lip/groove insets). Do not comment the obvious.
- Remove dead code and patch residue. Keep the `===GEOM-START/END===` markers only if the build needs them; otherwise drop.

## Geometry constants that must not change

`OV=0.06`, `PEN=0.3`, `SEG=10`, lip: `SKIRT=0.9`, `CLR=0.25`, `RIM_H=1.8`, `rimOuterInset=SKIRT+CLR`, `rimW=clamp(wall-rimOuterInset-0.15, 1.1, 1.8)`, `grooveDepth=min(RIM_H-0.3, floor-0.8)`, rim tip chamfer `ch2=clamp((rimW-0.4)/2, 0, 0.6)`, bottom chamfer `chB = lip ? min(0.45, floor-0.3) : min(0.8, floor-0.4)` (zeroed under 0.2), floor fillet `fr=min(2, cavW/6, cavD/6)` (skip under 0.8), scoop `R=min(12, cavD*0.55, H-floor-2)` (skip under 3), floor hole margins (4.5 mm, front margin `max(4.5, scoopR+2)` with scoops), corner guard `gMin=max(0.8, 0.7*wall)` and the offset relation `gap = sqrt2*wall - (sqrt2-1)*(r_out - r_in)`, error when `gap < 0.15`.

## Tests (plain `node:test` + `node:assert`, no other framework)

`test/geometry.test.js`:
- For every fixture preset: `exportSTL(buildParts(p).parts)` is byte-identical to `test/fixtures/<name>.stl`.
- Every part has positive signed volume (outward winding, closed shell).
- Exported bbox: width and depth within 0.1 mm of requested, min z within 0.01 of 0, max z within 0.05 of `meta.totalH`.
- STL byte length `= 84 + 50 * n`, header count `n` equals `computeStats().triangles`.
- Lip mating probe on `trayA`: max-x inset at `z = H - 0.06` is 1.15 ±0.05, at `z = H + 1.8` is 1.50 ±0.05 (trapezoid rim); bottom chamfer inset at `z = 0` is 0.45 ±0.05 with lip, 0.8 ±0.05 without; full width restored at `z = floor`.
- Corner-wall probe: `{width:160, depth:100, height:40, cols:3, rows:2, wall:1.2, floor:2, divider:1.2, radius:12, radiusIn:0}` builds without error, emits the "Corner compartments rounded" warning, and the wall measured along the TR diagonal at mid-height is ≥ 0.84 − 0.12 mm.
- Error paths: sub-3 mm compartments error; `floor >= height - 1` errors; `{... cols:8, rows:2, wall:0.8, radius:12, radiusIn:0}` on 160×100 errors with the corner-breach message.
- Fillet adds material: partsBin with `floorFillet:true` has volume > without by > 100 mm³.

`test/layout.test.js` (pure functions, synthetic tray lists):
- `overlapsAny`: touching edges are not overlaps; 0.02 mm intrusion is.
- `nextSpot`: with a 196-wide tray at (0,0) in a 338-wide envelope, a second 196-wide tray lands at (0, depth of first), not to the right; a 142-wide tray lands at (196, 0).
- `snapAxis`: snaps within 4 mm to butt, align, and envelope edges; does not snap at 4.5 mm.
- `emptyRectAt`: point inside a tray → null; point in an L-shaped void returns the larger of x-first / y-first expansions; result never overlaps any tray; sub-5 mm slivers → null.
- `layoutIssues`: reports overlap pairs and envelope violations with correct tray indices.
- State round-trip: `parse(serialize(state))` deep-equals `state`; malformed hash → `false`, no throw.

## Fixture presets

```js
smallTray:   { width:120, depth:90,  height:30, cols:3, rows:2, wall:1.6, floor:2,   divider:1.2, radius:3, radiusIn:1.5 }
partsBin:    { width:160, depth:100, height:60, cols:1, rows:1, wall:2.4, floor:2.4, divider:1.2, radius:4, radiusIn:2.5, scoops:true, lip:true, floorFillet:true }
drawerIns:   { width:400, depth:280, height:55, cols:5, rows:4, wall:2,   floor:2,   divider:1.4, radius:3, radiusIn:1.5 }
trayA:       { width:196, depth:106, height:72, cols:1, rows:1, wall:2,   floor:2.4, divider:1.2, radius:3, radiusIn:1.5, lip:true }
trayB:       { width:196, depth:225, height:72, cols:2, rows:3, wall:2,   floor:2.4, divider:1.2, radius:3, radiusIn:1.5, lip:true }
screwSorter: { width:180, depth:120, height:25, cols:6, rows:4, wall:1.6, floor:1.6, divider:1,   radius:2, radiusIn:1,   scoops:true, lip:true }
```
Plus each of the above with `{ lip:true, tab:true, scoops:true, floorHoles:true, floorFillet:true }` merged in, suffixed `_all`. Twelve fixtures total.

## Build and CI

- `npm run build` → `dist/index.html`. `npm test` → both test files. `npm run check` → both.
- `ci.yml`: Node 20, `npm ci`, `npm run check`, on push and PR.
- `pages.yml`: on push to `main`, upload `dist/` with `actions/upload-pages-artifact` and deploy with `actions/deploy-pages`. Pages source must be set to "GitHub Actions" in repo settings (note this in README).

## Manual QA checklist (run in a browser on `dist/index.html`, both `file://` and via a local static server)

- All six presets render; title block values update.
- Outer/inner radius sliders are independent; corner-guard warning appears for radius 12 / wall 1.2 / inner 0.
- Drawer mode: wireframe + dashed envelope appear; `+` adds a tray beside/below existing ones; `⧉` duplicates; `✕` deletes.
- Drag a tray; it snaps to neighbors and envelope edges; X/Y fields follow; overlap shows red cage and warning on release.
- Hover empty space shows white highlight; double-click fills it with a tray inheriting the selected tray's settings.
- Backspace/Delete removes the selected tray except when focus is in an input or only one tray remains.
- Share copies a URL; opening it in a new tab restores the exact layout.
- Download STL produces a file that opens in Bambu Studio / PrusaSlicer without repair warnings beyond "overlapping shells merged."
- Orbit below the model works; grid hides below the horizon.
- Printer dropdown fit check: single-tray and all-trays modes.

## README additions

- Screenshot at the top (placeholder path `docs/screenshot.png`; leave a TODO if no image is available).
- Live demo link, build/test instructions, architecture section (one paragraph per module), the no-CSG design note, and a "Built with Claude" line stating that the geometry was validated by the test suite described above.

## Process

- One commit per step: fixtures → split geometry → split layout → split viewer/app → build script → tests green → CI → README. Conventional commit messages.
- Run `npm run check` before every commit. Never regenerate fixtures to make a test pass.
- If anything in the current code is ambiguous or looks like a latent bug, note it in a `NOTES.md` rather than fixing it silently; this refactor is behavior-preserving.

## Publish

After all steps pass:
```
gh repo create <github-username>/binlab --public --source . --push
```
Then enable Pages (source: GitHub Actions) and confirm the deployed URL renders. Replace the README demo link with the real URL and push.
