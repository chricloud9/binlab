# BinLab — parametric bin & drawer organizer generator

Free, browser-based generator for 3D-printable storage bins and full drawer layouts.
Live 3D preview, watertight binary STL export, no account, no server — one HTML file.

**Live demo:** https://YOUR-USERNAME.github.io/binlab/ *(enable GitHub Pages → deploy from branch → root)*

## Features

- Fully parametric: dimensions, compartment grid, wall/floor/divider thickness, decoupled outer/inner corner radii
- Stacking lip: trapezoid rim with 45° lead-in chamfers and a matching base groove, so identical trays self-center and interlock
- 45° bottom edge chamfer (hides elephant's foot, slides into drawers), optional interior floor fillets, finger scoops, label tabs, weight-saving floor holes
- **Drawer layout mode**: define your drawer, drag trays with magnetic edge snapping, double-click empty space to auto-fill it with a tray, live overlap/out-of-bounds validation, coverage stats
- Per-tray printer bed fit checking (Bambu, Prusa, Ultimaker, Ender presets)
- Layouts serialize into the URL — the Share button copies a link that reopens your exact design
- Binary STL export per tray, sized exactly, z-up, millimeters

## Printing

Flat side down, no supports. 3 perimeters, 10–15% infill, 0.2 mm layers. PLA on textured PEI
is trouble-free; use PETG for very large flat inserts (300 mm+) to avoid warp. The exported
STL contains overlapping closed shells; every mainstream slicer (Bambu Studio, PrusaSlicer,
Orca, Cura) unions them automatically on import. If importing into CAD for further booleans,
run a mesh union first.

## Tech notes

- Single file. Only dependency is three.js r128 from cdnjs.
- No CSG: all solids are closed extrusions and profile sweeps around per-corner-radius
  rounded rects, overlapped by 0.06 mm. Every shell is generated watertight with outward
  winding (validated by signed-volume tests).
- The stacking interface: rim insets 1.15 mm from the outer face, 1.8 mm tall, 0.25 mm
  lateral clearance into the base groove; corner-wall guard auto-raises corner compartment
  radii so large outer radii never breach the corner wall.

## License

MIT. Generated STL files are yours — print, sell, share, no restrictions or attribution required.
