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

// Stacking lip v2 is being landed as a series of commits. Fixtures that carry
// the lip are regenerated in the last commit of the series; until then their
// byte comparison is deferred (every other fixture check still runs, and the
// non-lip fixtures must stay byte-identical throughout).
const LIP_V2_PENDING = true;
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
    if (!(LIP_V2_PENDING && p.lip)) {
      assert.ok(got.equals(want), `${name}.stl differs from fixture (${got.length} vs ${want.length} bytes)`);
    }

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

test('thin walls get a rim support wedge instead of an overhang warning', () => {
  const build = (p) => buildParts(p);
  const hasWedge = (out) => out.parts.some((part) => part.name === 'wedge');
  const overhang = (out) => out.warnings.filter((w) => /overhang/i.test(w));
  for (const wall of [1.6, 2, 2.5]) {
    const out = build({ ...PRESETS.trayA, wall });
    assert.ok(hasWedge(out), `wedge present at wall ${wall}`);
    assert.equal(overhang(out).length, 0, `no overhang warning at wall ${wall}`);
  }
  // rim inner edge is at 1.45 + 1.1 = 2.55; from wall 2.65 the wall carries it
  assert.ok(!hasWedge(build({ ...PRESETS.trayA, wall: 2.7 })), 'no wedge once the wall reaches the rim inner edge');
  assert.ok(!hasWedge(build({ ...PRESETS.trayA, lip: false, wall: 1.6 })), 'no wedge without the lip');
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

/* ---------------- stacking lip v2: profile probes and mating simulation ---------------- */

// All triangles of a binary STL as [[x,y,z] x 3].
function stlTriangles(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true), out = [];
  for (let t = 0; t < n; t++) {
    const off = 84 + 50 * t, tri = [];
    for (let v = 0; v < 3; v++) {
      const vo = off + 12 + 12 * v;
      tri.push([dv.getFloat32(vo, true), dv.getFloat32(vo + 4, true), dv.getFloat32(vo + 8, true)]);
    }
    out.push(tri);
  }
  return out;
}

// z of every non-vertical triangle that a vertical ray at (x, y) passes
// through (a shared edge reports twice; callers only take min/max).
function zHits(tris, x, y) {
  const hits = [];
  for (const [a, b, c] of tris) {
    if (Math.max(a[0], b[0], c[0]) < x || Math.min(a[0], b[0], c[0]) > x) continue;
    if (Math.max(a[1], b[1], c[1]) < y || Math.min(a[1], b[1], c[1]) > y) continue;
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(det) < 1e-9) continue;
    const l1 = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) / det;
    const l2 = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
    hits.push(l1 * a[2] + l2 * b[2] + l3 * c[2]);
  }
  return hits;
}

// Wall profile: for insets 0..5 in `step` increments along one wall, the top
// (max z) and underside (min z) of material. Walls: right (+x), left, front (-y), back.
const WALLS = ['right', 'left', 'front', 'back'];
function wallProfile(tris, p, wall, step) {
  const out = [];
  for (let k = 0; k * step <= 5 + 1e-9; k++) {
    const i = +(k * step).toFixed(4);
    const x = wall === 'right' ? p.width / 2 - i : wall === 'left' ? -p.width / 2 + i : 0;
    const y = wall === 'front' ? -p.depth / 2 + i : wall === 'back' ? p.depth / 2 - i : 0;
    const z = zHits(tris, x, y);
    out.push({ i, top: Math.max(...z), bottom: Math.min(...z) });
  }
  return out;
}

// The engine's lip constants, restated so the tests assert the design rather
// than whatever the engine emits.
function lipSpec(p) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const SKIRT = 1.2, CLR = 0.25, RIM_H = 1.6;
  const rimOuterInset = SKIRT + CLR;
  const rimW = clamp(p.wall - rimOuterInset - 0.15, 1.1, 1.8);
  const ch2 = clamp((rimW - 0.7) / 2, 0.2, 0.6);
  const grooveDepth = Math.min(RIM_H - 0.05, p.floor - 0.8);
  const cg = Math.min(ch2 + 2 * CLR, grooveDepth - 0.3);
  const grooveInnerInset = rimOuterInset + rimW + CLR;
  const chB = Math.min(0.45, p.floor - 0.3);
  return {
    SKIRT, CLR, RIM_H, rimOuterInset, rimW, rimInner: rimOuterInset + rimW, ch2, grooveDepth, cg,
    grooveInnerInset, chB, apexBand: (rimW + 2 * CLR) - 2 * cg
  };
}

// Seat height of an identical bin stacked on this one, from the right-wall
// profile: the smallest lift that leaves no interpenetration. `shift` moves
// the upper bin along +x (outward on the right wall), in whole samples.
function seatOf(prof, shift = 0) {
  let seat = -Infinity;
  for (let k = 0; k < prof.length; k++) {
    const up = prof[k + shift];
    if (!up) continue;
    seat = Math.max(seat, prof[k].top - up.bottom);
  }
  return seat;
}

const LIP_CASES = {
  trayA:     PRESETS.trayA,
  thinWall:  { ...PRESETS.trayA, wall: 1.6 },
  thinFloor: { ...PRESETS.trayA, floor: 2.0 }
};

for (const [name, p] of Object.entries(LIP_CASES)) {
  const H = p.height, STEP = 0.02;
  const s = lipSpec(p);
  const out = buildParts(p);
  const tris = stlTriangles(exportSTL(out.parts));
  const prof = wallProfile(tris, p, 'right', STEP);
  const at = (inset) => prof[Math.round(inset / STEP)];
  const inGroove = prof.filter((q) => q.i > s.SKIRT + 0.01 && q.i < s.grooveInnerInset - 0.01);

  test(`lip v2 ${name}: profile extraction`, () => {
    assert.equal(out.error, undefined);
    assert.ok(s.apexBand >= 0.2 - 1e-6, `apex band ${s.apexBand.toFixed(3)} would be a knife edge`);

    // rim: base where the top first rises above the wall, tip where it reaches full height
    const base = prof.find((q) => q.top > H + 0.01).i;
    const tip = prof.find((q) => q.top >= H + s.RIM_H - 0.005).i;
    assert.ok(Math.abs(base - s.rimOuterInset) <= 0.03, `rim base inset ${base}`);
    assert.ok(Math.abs(tip - (s.rimOuterInset + s.ch2)) <= 0.03, `rim tip inset ${tip}`);
    const rimTop = Math.max(...prof.map((q) => q.top));
    assert.ok(Math.abs(rimTop - (H + s.RIM_H)) <= 0.01, `rim top z ${rimTop}`);

    // groove mouth: where the underside leaves the bed on each side of the void
    const mouthOuter = prof.find((q) => q.i > s.chB + 0.1 && q.bottom > 0.01).i;
    const mouthInner = [...prof].reverse().find((q) => q.i < s.grooveInnerInset + 0.5 && q.bottom > 0.01).i;
    assert.ok(Math.abs(mouthOuter - s.SKIRT) <= 0.03, `outer mouth inset ${mouthOuter}`);
    assert.ok(Math.abs(mouthInner - s.grooveInnerInset) <= 0.03, `inner mouth inset ${mouthInner}`);

    // apex band at grooveDepth, at least 0.2 wide
    const apex = Math.max(...inGroove.map((q) => q.bottom));
    assert.ok(Math.abs(apex - s.grooveDepth) <= 0.01, `apex z ${apex}`);
    const apexW = inGroove.filter((q) => q.bottom >= s.grooveDepth - 0.005).length * STEP;
    assert.ok(apexW >= 0.2 - 0.03, `apex band measured ${apexW.toFixed(2)} mm`);

    // 45-degree roof faces between mouth and apex on both sides
    const slope = (i1, i2) => (at(i2).bottom - at(i1).bottom) / (i2 - i1);
    const sOut = slope(s.SKIRT + 0.06, s.SKIRT + s.cg - 0.06);
    const sIn = slope(s.grooveInnerInset - s.cg + 0.06, s.grooveInnerInset - 0.06);
    assert.ok(Math.abs(sOut - 1) <= 0.05, `outer roof slope ${sOut.toFixed(3)}`);
    assert.ok(Math.abs(sIn + 1) <= 0.05, `inner roof slope ${sIn.toFixed(3)}`);
  });

  test(`lip v2 ${name}: groove roof has no bridge`, () => {
    // any level run of the underside below the apex must be no wider than the apex band
    let run = 0, worst = 0;
    for (let k = 1; k < inGroove.length; k++) {
      const a = inGroove[k - 1], b = inGroove[k];
      const flat = Math.abs(b.bottom - a.bottom) < 1e-3 && b.bottom < s.grooveDepth - 0.01;
      run = flat ? run + STEP : 0;
      worst = Math.max(worst, run);
    }
    assert.ok(worst <= s.apexBand + 0.05, `flat ceiling segment of ${worst.toFixed(2)} mm below the apex`);
  });

  test(`lip v2 ${name}: mating simulation seats on the rim chamfers`, () => {
    const seat = seatOf(prof);
    const want = s.RIM_H + s.CLR - s.grooveDepth;
    assert.ok(Math.abs((seat - H) - want) <= 0.03, `seat - H = ${(seat - H).toFixed(3)}, want ${want.toFixed(3)}`);
    assert.ok(Math.abs(out.meta.lipFloat - (seat - H)) <= 0.03, `meta.lipFloat ${out.meta.lipFloat}`);
    assert.ok(Math.abs(out.meta.stackPitch - seat) <= 0.03, `meta.stackPitch ${out.meta.stackPitch}`);
    assert.ok(Math.abs(out.meta.lipEngagement - (H + s.RIM_H - seat)) <= 0.03, `meta.lipEngagement ${out.meta.lipEngagement}`);

    // contact set: only the two rim chamfer faces, never the tip flat, wall top, or skirt
    const contact = prof.filter((q) => Math.abs(seat + q.bottom - q.top) <= 0.02).map((q) => q.i);
    const onOuter = (i) => i >= s.rimOuterInset - 0.03 && i <= s.rimOuterInset + s.ch2 + 0.03;
    const onInner = (i) => i >= s.rimInner - s.ch2 - 0.03 && i <= s.rimInner + 0.03;
    assert.ok(contact.length >= 6, `contact set too small: ${contact.join(', ')}`);
    assert.ok(contact.some(onOuter) && contact.some(onInner), 'both chamfers must carry load');
    for (const i of contact) assert.ok(onOuter(i) || onInner(i), `contact off the chamfers at inset ${i}`);
    // the tip flat floats CLR under the apex band, the skirt floats over the wall top
    const tipMid = at(+((s.rimOuterInset + s.rimW / 2).toFixed(2)));
    assert.ok(seat + tipMid.bottom - tipMid.top >= s.CLR - 0.03, 'tip flat touches the apex band');
    const skirtMid = at(+(((s.chB + s.SKIRT) / 2).toFixed(2)));
    assert.ok(seat + skirtMid.bottom - skirtMid.top >= 0.05, 'skirt bears on the wall top');

    // zero interpenetration: 100 probes per wall, all four walls
    for (const wall of WALLS) {
      const wp = wallProfile(tris, p, wall, 0.05);
      assert.equal(wp.length, 101);
      for (const q of wp) {
        assert.ok(seat + q.bottom - q.top >= -0.005, `${wall} wall interpenetrates at inset ${q.i}`);
      }
    }
  });

  test(`lip v2 ${name}: no lateral play at seat`, () => {
    const seat = seatOf(prof);
    const n = Math.round(0.10 / STEP);
    for (const sign of [1, -1]) {
      const rise = seatOf(prof, sign * n) - seat;
      assert.ok(Math.abs(rise - 0.10) <= 0.03, `shift ${sign * 0.1}: seat rose ${rise.toFixed(3)}`);
    }
  });

  test(`lip v2 ${name}: bed face`, () => {
    const buf = exportSTL(out.parts);
    assert.ok(Math.abs((p.width / 2 - maxXAtZ(buf, 0)) - s.chB) <= 0.03, 'bottom chamfer inset');
    // continuous bed contact from the chamfer to the skirt's inner face
    const bed = prof.filter((q) => q.i >= s.chB - 0.01 && q.i <= s.SKIRT + 0.01 && q.bottom <= 1e-3).map((q) => q.i);
    for (let k = 1; k < bed.length; k++) assert.ok(bed[k] - bed[k - 1] <= STEP + 1e-9, `gap in the bed face at ${bed[k]}`);
    const width = bed[bed.length - 1] - bed[0];
    assert.ok(width >= 0.7, `skirt bed face ${width.toFixed(2)} mm`);
  });
}

test('lip v2 thin wall: wedge supports the rim inner edge, no overhang warning', () => {
  const p = LIP_CASES.thinWall;
  const s = lipSpec(p);
  const out = buildParts(p);
  const wedge = out.parts.find((part) => part.name === 'wedge');
  assert.ok(wedge, 'wedge part present');
  const tris = stlTriangles(exportSTL([wedge]));
  // the wedge is a swept triangle: one z interval per vertical ray
  const z = zHits(tris, p.width / 2 - (s.rimInner - 0.3), 0);
  const zp = p.height - 0.3;
  assert.ok(z.length && Math.min(...z) <= zp && Math.max(...z) >= zp,
    `no wedge material at inset ${(s.rimInner - 0.3).toFixed(2)}, z = H - 0.3`);
  assert.ok(!out.warnings.some((w) => /overhang/i.test(w)), out.warnings.join('; '));
});

test('bottom chamfer opens to 0.8 without the lip', () => {
  const p = PRESETS.trayA;
  const noLip = exportSTL(buildParts({ ...p, lip: false }).parts);
  assert.ok(Math.abs((p.width / 2 - maxXAtZ(noLip, 0)) - 0.8) <= 0.05, 'bottom chamfer inset (no lip)');
});
