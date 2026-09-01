import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The engine expects a global THREE (the r128 classic build provides one in
// the browser); install it before the module loads.
globalThis.THREE = createRequire(import.meta.url)('three');
const { buildParts, computeStats, partVolume, exportSTL } = await import('../src/geometry.js');

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const BASE = {
  smallTray:   { width: 120, depth: 90,  height: 30, cols: 3, rows: 2, wall: 1.6, floor: 2,   divider: 1.2, radius: 3, radiusIn: 1.5 },
  partsBin:    { width: 160, depth: 100, height: 60, cols: 1, rows: 1, wall: 2.4, floor: 2.4, divider: 1.2, radius: 4, radiusIn: 2.5, scoops: true, lip: true, floorFillet: true },
  drawerIns:   { width: 400, depth: 280, height: 55, cols: 5, rows: 4, wall: 2,   floor: 2,   divider: 1.4, radius: 3, radiusIn: 1.5 },
  trayA:       { width: 196, depth: 106, height: 72, cols: 1, rows: 1, wall: 2,   floor: 2.4, divider: 1.2, radius: 3, radiusIn: 1.5, lip: true },
  trayB:       { width: 196, depth: 225, height: 72, cols: 2, rows: 3, wall: 2,   floor: 2.4, divider: 1.2, radius: 3, radiusIn: 1.5, lip: true },
  screwSorter: { width: 180, depth: 120, height: 25, cols: 6, rows: 4, wall: 1.6, floor: 1.6, divider: 1,   radius: 2, radiusIn: 1,   scoops: true, lip: true }
};
const ALL_FLAGS = { lip: true, tab: true, scoops: true, floorHoles: true, floorFillet: true };
const PRESETS = {};
for (const [name, p] of Object.entries(BASE)) {
  PRESETS[name] = p;
  PRESETS[name + '_all'] = { ...p, ...ALL_FLAGS };
}

// Walk the 50-byte triangle records of a binary STL buffer.
function eachSTLVertex(buf, fn) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  for (let t = 0; t < n; t++) {
    const off = 84 + 50 * t;
    for (let v = 0; v < 3; v++) {
      const vo = off + 12 + 12 * v;
      fn(dv.getFloat32(vo, true), dv.getFloat32(vo + 4, true), dv.getFloat32(vo + 8, true));
    }
  }
}

function stlBBox(buf) {
  const bb = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  eachSTLVertex(buf, (x, y, z) => {
    bb.minX = Math.min(bb.minX, x); bb.maxX = Math.max(bb.maxX, x);
    bb.minY = Math.min(bb.minY, y); bb.maxY = Math.max(bb.maxY, y);
    bb.minZ = Math.min(bb.minZ, z); bb.maxZ = Math.max(bb.maxZ, z);
  });
  return bb;
}

// Largest vertex x on the z ≈ plane (for measuring insets from the +x face).
function maxXAtZ(buf, z, eps = 1e-3) {
  let max = -Infinity;
  eachSTLVertex(buf, (x, _y, vz) => { if (Math.abs(vz - z) < eps && x > max) max = x; });
  assert.notEqual(max, -Infinity, `no vertices found at z=${z}`);
  return max;
}

for (const [name, p] of Object.entries(PRESETS)) {
  test(`fixture ${name}`, () => {
    const out = buildParts(p);
    assert.equal(out.error, undefined);
    const buf = exportSTL(out.parts);
    const got = Buffer.from(buf);

    // the oracle: byte-for-byte identical to the frozen baseline
    const want = fs.readFileSync(path.join(fixturesDir, `${name}.stl`));
    assert.ok(got.equals(want), `${name}.stl differs from fixture (${got.length} vs ${want.length} bytes)`);

    // every part is a closed, outward-wound shell
    for (const part of out.parts) {
      assert.ok(partVolume(part) > 0, `part ${part.name} has non-positive volume`);
    }

    // sane exported bounding box
    const bb = stlBBox(buf);
    assert.ok(Math.abs((bb.maxX - bb.minX) - p.width) <= 0.1, `width ${bb.maxX - bb.minX}`);
    assert.ok(Math.abs((bb.maxY - bb.minY) - p.depth) <= 0.1, `depth ${bb.maxY - bb.minY}`);
    assert.ok(Math.abs(bb.minZ) <= 0.01, `min z ${bb.minZ}`);
    assert.ok(Math.abs(bb.maxZ - out.meta.totalH) <= 0.05, `max z ${bb.maxZ} vs totalH ${out.meta.totalH}`);

    // binary STL structure: 84-byte header + 50 bytes per triangle
    const n = new DataView(buf).getUint32(80, true);
    assert.equal(buf.byteLength, 84 + 50 * n);
    assert.equal(n, computeStats(out.parts).triangles);
  });
}

test('lip mating profile (trayA probe)', () => {
  const p = PRESETS.trayA;
  const H = p.height, W = p.width, floor = p.floor;
  const buf = exportSTL(buildParts(p).parts);

  // rim ring: outer face inset 1.15 at its base, 1.50 at the chamfered tip
  assert.ok(Math.abs((W / 2 - maxXAtZ(buf, H - 0.06)) - 1.15) <= 0.05, 'rim base inset');
  assert.ok(Math.abs((W / 2 - maxXAtZ(buf, H + 1.8)) - 1.50) <= 0.05, 'rim tip inset');
  // bottom chamfer with lip: 0.45; full width again at the top of the floor
  assert.ok(Math.abs((W / 2 - maxXAtZ(buf, 0)) - 0.45) <= 0.05, 'bottom chamfer inset (lip)');
  assert.ok(Math.abs(W / 2 - maxXAtZ(buf, floor)) <= 0.05, 'full width at z=floor');

  // without the lip the bottom chamfer opens up to 0.8
  const noLip = exportSTL(buildParts({ ...p, lip: false }).parts);
  assert.ok(Math.abs((W / 2 - maxXAtZ(noLip, 0)) - 0.8) <= 0.05, 'bottom chamfer inset (no lip)');
});

test('corner-wall guard rounds corner compartments and keeps the wall', () => {
  const p = { width: 160, depth: 100, height: 40, cols: 3, rows: 2, wall: 1.2, floor: 2, divider: 1.2, radius: 12, radiusIn: 0 };
  const out = buildParts(p);
  assert.equal(out.error, undefined);
  assert.ok(out.warnings.some((w) => w.includes('Corner compartments rounded')), out.warnings.join('; '));

  // measure the wall along the TR 45° diagonal at mid-height: the ray passes
  // through the outer corner arc center (68, 38), so the first two hits are
  // the outer face and the cavity face of the corner compartment
  const walls = out.parts.find((part) => part.name === 'walls');
  const mesh = new THREE.Mesh(walls.geom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const ray = new THREE.Raycaster(new THREE.Vector3(83, 53, 20), new THREE.Vector3(-1, -1, 0).normalize());
  const hits = ray.intersectObject(mesh, false);
  // the ray runs along a shared triangle edge, so each face reports twice;
  // collapse hits at the same distance before measuring
  const dists = [...new Set(hits.map((h) => +h.distance.toFixed(4)))];
  assert.ok(dists.length >= 2, `expected >= 2 distinct hits, got ${dists.length}`);
  const thickness = dists[1] - dists[0];
  // gMin = max(0.8, 0.7 * wall) = 0.84; allow for arc polygonization
  assert.ok(thickness >= 0.84 - 0.12, `corner wall ${thickness.toFixed(3)} mm`);
  assert.ok(thickness < 3, `probe measured something other than the corner wall: ${thickness.toFixed(3)} mm`);
});

test('meta.cells enumerates compartments row-major with cavity dims', () => {
  const p = PRESETS.smallTray; // 3 x 2 grid
  const { meta } = buildParts(p);
  assert.equal(meta.cells.length, p.cols * p.rows);
  meta.cells.forEach((c) => {
    assert.equal(c.w, meta.cavW);
    assert.equal(c.d, meta.cavD);
    assert.equal(c.h, meta.cavH);
  });
  // row-major: the first row runs across the columns
  assert.deepEqual(meta.cells.map((c) => [c.i, c.j]).slice(0, 4), [[0, 0], [1, 0], [2, 0], [0, 1]]);
  // corner cells sit at ±(outer half - wall - half cavity)
  const ex = p.width / 2 - p.wall - meta.cavW / 2;
  const ey = p.depth / 2 - p.wall - meta.cavD / 2;
  const first = meta.cells[0], last = meta.cells[meta.cells.length - 1];
  assert.ok(Math.abs(first.cx + ex) < 1e-9 && Math.abs(first.cy + ey) < 1e-9, 'front-left corner cell');
  assert.ok(Math.abs(last.cx - ex) < 1e-9 && Math.abs(last.cy - ey) < 1e-9, 'back-right corner cell');
});

test('thin-wall lip warning gates at wall < 1.8', () => {
  const lipWarnings = (p) => buildParts(p).warnings.filter((w) => w.includes('Stacking lip rim overhangs'));
  assert.equal(lipWarnings(PRESETS.trayA).length, 0, 'no warning at wall 2.0');
  const thin = lipWarnings({ ...PRESETS.trayA, wall: 1.7 });
  assert.equal(thin.length, 1);
  assert.equal(thin[0], 'Stacking lip rim overhangs the cavity slightly on walls under 1.8 mm.');
  assert.equal(lipWarnings({ ...PRESETS.trayA, lip: false, wall: 1.7 }).length, 0, 'lip off never warns');
});

test('error paths', () => {
  const tiny = buildParts({ width: 40, depth: 60, height: 30, cols: 12, rows: 1, wall: 1.6, floor: 2, divider: 1.2, radius: 0, radiusIn: 0 });
  assert.match(tiny.error, /under 3 mm/);

  const thickFloor = buildParts({ width: 100, depth: 100, height: 10, cols: 1, rows: 1, wall: 2, floor: 9, divider: 1.2, radius: 3, radiusIn: 1.5 });
  assert.match(thickFloor.error, /Floor thickness/);

  const breach = buildParts({ width: 160, depth: 100, height: 40, cols: 8, rows: 2, wall: 0.8, floor: 2, divider: 1.2, radius: 12, radiusIn: 0 });
  assert.match(breach.error, /corner wall vanishes/);
});

test('floor fillet adds material', () => {
  const withFillet = computeStats(buildParts(PRESETS.partsBin).parts).volumeMM3;
  const without = computeStats(buildParts({ ...PRESETS.partsBin, floorFillet: false }).parts).volumeMM3;
  assert.ok(withFillet - without > 100, `fillet added only ${(withFillet - without).toFixed(1)} mm³`);
});
