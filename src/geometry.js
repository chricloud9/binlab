// BinLab geometry engine. Model space is z-up, mm. All transforms baked into geometry.
// Pure: no DOM. Expects a global `THREE` (three.js r128) in scope.
/* global THREE */

const OV = 0.06;   // shell overlap to avoid coincident faces
const PEN = 0.3;   // penetration of add-on solids into walls/floor
const SEG = 10;    // curve segments per arc

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Rounded rect centered on (cx, cy); r is a scalar or per-corner [BL, BR, TR, TL].
const roundedRect = (cls, w, d, r, cx, cy) => {
  cx = cx || 0; cy = cy || 0;
  const rr = Array.isArray(r) ? r.slice() : [r, r, r, r]; // [BL, BR, TR, TL]
  for (let k = 0; k < 4; k++) rr[k] = Math.max(0, Math.min(rr[k] || 0, w / 2 - 0.01, d / 2 - 0.01));
  const bl = rr[0], br = rr[1], tr = rr[2], tl = rr[3];
  const s = new cls();
  const x = cx - w / 2, y = cy - d / 2;
  s.moveTo(x + bl, y);
  s.lineTo(x + w - br, y);
  if (br > 0.05) s.absarc(x + w - br, y + br, br, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + d - tr);
  if (tr > 0.05) s.absarc(x + w - tr, y + d - tr, tr, 0, Math.PI / 2, false);
  s.lineTo(x + tl, y + d);
  if (tl > 0.05) s.absarc(x + tl, y + d - tl, tl, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + bl);
  if (bl > 0.05) s.absarc(x + bl, y + bl, bl, Math.PI, 1.5 * Math.PI, false);
  s.closePath();
  return s;
};
const shapeRR = (w, d, r, cx, cy) => roundedRect(THREE.Shape, w, d, r, cx, cy);
const pathRR = (w, d, r, cx, cy) => roundedRect(THREE.Path, w, d, r, cx, cy);
// inset i from a W x D radius-r outline
const insetRR = (cls, W, D, r, i) => roundedRect(cls, W - 2 * i, D - 2 * i, r - i, 0, 0);

const extrudeZ = (shape, depth, z0) => {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: SEG });
  if (z0) g.translate(0, 0, z0);
  return g;
};

// permutation (u,v,t) -> (t,u,v), det = +1 (no reflection)
const PERM = new THREE.Matrix4().set(
  0, 0, 1, 0,
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1
);

// CCW outline of a per-corner rounded rect centered at origin. 4*(seg+1) points always.
const outlinePts = (w, d, radii, seg) => {
  const pts = [];
  const defs = [
    { cx:  w / 2 - radii[1], cy: -d / 2 + radii[1], r: radii[1], a0: -Math.PI / 2 }, // BR
    { cx:  w / 2 - radii[2], cy:  d / 2 - radii[2], r: radii[2], a0: 0 },            // TR
    { cx: -w / 2 + radii[3], cy:  d / 2 - radii[3], r: radii[3], a0: Math.PI / 2 },  // TL
    { cx: -w / 2 + radii[0], cy: -d / 2 + radii[0], r: radii[0], a0: Math.PI }       // BL
  ];
  defs.forEach((c) => {
    for (let k = 0; k <= seg; k++) {
      const a = c.a0 + (k / seg) * Math.PI / 2;
      pts.push([c.cx + c.r * Math.cos(a), c.cy + c.r * Math.sin(a)]);
    }
  });
  return pts;
};

const geomVolume = (g) => {
  const pos = g.getAttribute('position');
  let v = 0;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
    const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
    const cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
};

const flipGeom = (g) => {
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i += 3) {
    const x = pos.getX(i + 1), y = pos.getY(i + 1), z = pos.getZ(i + 1);
    pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
    pos.setXYZ(i + 2, x, y, z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
};

// Sweep a closed cross-section polygon [[inset, z], ...] around a per-corner
// rounded rect (w x d, radii[4]). Returns a closed torus-like solid, outward wound.
// Winding of the input polygon is unknown, so the signed volume decides whether
// the triangle order must be flipped to face outward.
const sweepSolid = (w, d, radii, cross) => {
  const rings = cross.map((cz) => {
    const i = cz[0];
    const rr = radii.map((r) => Math.max(0.02, r - i));
    return { pts: outlinePts(w - 2 * i, d - 2 * i, rr, SEG), z: cz[1] };
  });
  const n = rings[0].pts.length, m = rings.length, pos = [];
  for (let k = 0; k < m; k++) {
    const A = rings[k], B = rings[(k + 1) % m];
    for (let i2 = 0; i2 < n; i2++) {
      const j2 = (i2 + 1) % n;
      const a0 = A.pts[i2], a1 = A.pts[j2], b0 = B.pts[i2], b1 = B.pts[j2];
      pos.push(a0[0], a0[1], A.z, a1[0], a1[1], A.z, b1[0], b1[1], B.z);
      pos.push(a0[0], a0[1], A.z, b1[0], b1[1], B.z, b0[0], b0[1], B.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (geomVolume(g) < 0) flipGeom(g); else g.computeVertexNormals();
  return g;
};

const arcPts = (cx, cz, r, a0, a1, n) => {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (a1 - a0) * k / n;
    out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return out;
};

/**
 * Build the solid parts of one bin from its parameters.
 *
 * @param {object} p bin parameters: width, depth, height, cols, rows, wall,
 *   floor, divider, radius, radiusIn, and boolean flags lip, tab, scoops,
 *   floorHoles, floorFillet.
 * @returns {{parts: Array<{name: string, geom: THREE.BufferGeometry}>,
 *   warnings: string[], meta: object} | {error: string}}
 *   Parts are emitted in a fixed order (walls, floor/collar or
 *   skirt/groove/center/rim/wedge, fillet, scoop, tab); the STL fixture
 *   tests depend on that order.
 */
export function buildParts(p) {
  const warnings = [];
  const W = p.width, D = p.depth, H = p.height;
  const wall = p.wall, floor = p.floor, div = p.divider;
  const cols = p.cols, rows = p.rows;
  const r = clamp(p.radius, 0, Math.min(W / 2 - 1, D / 2 - 1));

  const cavW = (W - 2 * wall - (cols - 1) * div) / cols;
  const cavD = (D - 2 * wall - (rows - 1) * div) / rows;
  if (cavW < 3 || cavD < 3) {
    return { error: 'Compartments would be under 3 mm wide. Reduce columns, rows, or divider thickness.' };
  }
  if (floor >= H - 1) return { error: 'Floor thickness must be at least 1 mm less than height.' };

  const rcMax = Math.max(0, Math.min(cavW / 2 - 0.4, cavD / 2 - 0.4));
  const rIn = (p.radiusIn === undefined || p.radiusIn === null)
    ? (r > 0.05 ? clamp(r - wall, 0.8, rcMax) : 0)
    : p.radiusIn;
  const rcUser = clamp(rIn, 0, rcMax);
  // corner compartments: outer-facing corner radius floor so the outer arc
  // never thins the corner wall below gMin. gap = sqrt2*w - (sqrt2-1)*(r - rc)
  const gMin = Math.max(0.8, 0.7 * wall);
  const rcFloor = r > 0.05 ? clamp(r - (Math.SQRT2 * wall - gMin) / (Math.SQRT2 - 1), 0, rcMax) : 0;
  const rcCorner = Math.max(rcUser, rcFloor);
  const cornerGap = Math.SQRT2 * wall - (Math.SQRT2 - 1) * (r - rcCorner);
  if (r > 0.05 && cornerGap < 0.15) {
    return { error: 'Outer radius too large for this wall and compartment size: the corner wall vanishes. Reduce outer radius or increase wall thickness.' };
  }
  if (rcCorner > rcUser + 0.05) {
    warnings.push('Corner compartments rounded to r=' + rcCorner.toFixed(1) + ' mm to keep a ' + gMin.toFixed(1) + ' mm corner wall.');
  }

  // cell centers
  const xs = [], ys = [];
  const x0 = -W / 2 + wall + cavW / 2, y0 = -D / 2 + wall + cavD / 2;
  for (let i = 0; i < cols; i++) xs.push(x0 + i * (cavW + div));
  for (let j = 0; j < rows; j++) ys.push(y0 + j * (cavD + div));

  // ---- stacking lip parameters (v2) ----
  // The rim of this bin (outer inset SKIRT+CLR, width rimW) drops into the
  // base groove of the bin above (between insets SKIRT and grooveInnerInset)
  // with CLR play on each side in the straight sections. Both rim tip and
  // groove roof carry 45-degree chamfers; the bin seats face-on-face on them.
  let lip = !!p.lip;
  const SKIRT = 1.2;                 // skirt ring width; bed face after the 0.45 chamfer = 0.75 mm (two lines)
  const CLR = 0.25;                  // straight-section clearance per side
  const RIM_H = 1.6;                 // rim height above the wall top
  const rimOuterInset = SKIRT + CLR;                       // 1.45
  const rimW = clamp(wall - rimOuterInset - 0.15, 1.1, 1.8);
  // rim tip chamfer: leaves a 0.7 mm tip flat, never under 0.2 mm of chamfer
  const ch2 = clamp((rimW - 0.7) / 2, 0.2, 0.6);
  const grooveDepthTarget = RIM_H - 0.05;                  // 1.55
  const grooveDepth = Math.min(grooveDepthTarget, floor - 0.8);
  // Groove roof chamfer. The rim base sits CLR inside the groove mouth, so the
  // two 45-degree faces coincide only when the roof chamfer is ch2 + 2*CLR:
  // the rim then seats on its chamfers with the tip flat CLR below the apex
  // band. Thin floors cap it so at least 0.3 mm of vertical groove wall stays.
  const cg = Math.min(ch2 + 2 * CLR, grooveDepth - 0.3);
  const grooveInnerInset = rimOuterInset + rimW + CLR;
  // Seating: the rim chamfers meet the roof chamfers with the tip flat tipGap
  // below the apex band (CLR unless a thin floor capped cg, then the tip lands
  // on the apex first). Upper base above the lower wall top = lipFloat.
  const tipGap = Math.max(0, cg - ch2 - CLR);
  const lipFloat = RIM_H - grooveDepth + tipGap;
  const stackPitch = H + lipFloat;              // height added per stacked bin
  const lipEngagement = grooveDepth - tipGap;   // rim depth inside the groove at seat
  if (lip && grooveDepth < 0.6) {
    lip = false;
    warnings.push('Stacking lip disabled: floor under 1.4 mm cannot take the base groove.');
  } else if (lip && grooveDepth < 1.2) {
    warnings.push('Stacking lip engagement is only ' + lipEngagement.toFixed(2) + ' mm; floor \u2265 2.4 mm recommended.');
  }

  const parts = [];

  // ---- walls + dividers: outer outline minus cavity holes ----
  const wallsShape = shapeRR(W, D, r, 0, 0);
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const rads = [rcUser, rcUser, rcUser, rcUser]; // [BL, BR, TR, TL]
    if (i === 0        && j === 0       ) rads[0] = rcCorner;
    if (i === cols - 1 && j === 0       ) rads[1] = rcCorner;
    if (i === cols - 1 && j === rows - 1) rads[2] = rcCorner;
    if (i === 0        && j === rows - 1) rads[3] = rcCorner;
    wallsShape.holes.push(pathRR(cavW, cavD, rads, xs[i], ys[j]));
  }
  parts.push({ name: 'walls', geom: extrudeZ(wallsShape, H - floor + OV, floor - OV) });

  // ---- floor holes (per compartment, weight saving) ----
  const scoops = !!p.scoops;
  const scoopR = Math.min(12, cavD * 0.55, H - floor - 2);
  const scoopsOn = scoops && scoopR >= 3;
  if (scoops && !scoopsOn) warnings.push('Finger scoops skipped: compartments too small or bin too shallow.');

  const holePaths = [];
  if (p.floorHoles) {
    const frontMargin = scoopsOn ? Math.max(4.5, scoopR + 2) : 4.5;
    const hw = cavW - 9, hd = cavD - 4.5 - frontMargin;
    if (hw >= 8 && hd >= 8) {
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const hcy = ys[j] - cavD / 2 + frontMargin + hd / 2;
        holePaths.push(pathRR(hw, hd, 3, xs[i], hcy));
      }
    } else {
      warnings.push('Floor holes skipped: compartments too small.');
    }
  }

  // ---- floor, with 45-degree bottom edge chamfer ----
  const outerR4 = [r, r, r, r];
  let chB = lip ? Math.min(0.45, floor - 0.3) : Math.min(0.8, floor - 0.4);
  if (chB < 0.2) chB = 0;
  if (!lip) {
    const floorShape = insetRR(THREE.Shape, W, D, r, chB);
    floorShape.holes = holePaths;
    parts.push({ name: 'floor', geom: extrudeZ(floorShape, floor, 0) });
    if (chB > 0) {
      parts.push({ name: 'collar', geom: sweepSolid(W, D, outerR4, [
        [chB, 0], [0, chB], [0, floor], [chB + OV, floor]
      ]) });
    }
  } else {
    // skirt ring with chamfered outer bottom edge, one swept cross-section
    const skirtCross = chB > 0
      ? [[chB, 0], [0, chB], [0, floor], [SKIRT, floor], [SKIRT, 0]]
      : [[0, 0], [0, floor], [SKIRT, floor], [SKIRT, 0]];
    parts.push({ name: 'skirt', geom: sweepSolid(W, D, outerR4, skirtCross) });
    // groove ring: thinned floor over the groove, its underside a 45-degree
    // gable so the void prints without bridging. Read from the bed upward the
    // void has vertical walls to z = grooveDepth - cg, then 45-degree roof
    // faces converging on a flat apex band at z = grooveDepth. The outer and
    // inner edges run OV into the skirt and center slab; the roof lines are
    // extended by OV along their 45-degree direction so the slope is exact.
    parts.push({ name: 'groove', geom: sweepSolid(W, D, outerR4, [
      [SKIRT - OV, floor],
      [SKIRT - OV, grooveDepth - cg - OV],
      [SKIRT + cg, grooveDepth],
      [grooveInnerInset - cg, grooveDepth],
      [grooveInnerInset + OV, grooveDepth - cg - OV],
      [grooveInnerInset + OV, floor]
    ]) });
    // center slab: full-height floor, carries the holes
    const center = insetRR(THREE.Shape, W, D, r, grooveInnerInset);
    center.holes = holePaths;
    parts.push({ name: 'center', geom: extrudeZ(center, floor, 0) });
    // rim: vertical flanks with true 45-degree tip chamfers (ch2 by ch2), so
    // the chamfer faces are parallel to the groove roof and the bin above
    // seats face-on-face on them, self-centering. The old 4-point trapezoid
    // ran its flanks straight from base to tip, far steeper than 45 degrees.
    const rimInner = rimOuterInset + rimW;
    parts.push({ name: 'rim', geom: sweepSolid(W, D, outerR4, [
      [rimOuterInset, H - OV], [rimInner, H - OV],
      [rimInner, H + RIM_H - ch2], [rimInner - ch2, H + RIM_H],
      [rimOuterInset + ch2, H + RIM_H], [rimOuterInset, H + RIM_H - ch2]
    ]) });
    // rim support wedge: on walls thinner than the rim's inner edge the rim
    // would cantilever over the cavity, so a 45-degree triangle under its
    // inner edge carries it down to the cavity face (penetrating the wall by PEN)
    if (wall < rimInner + 0.1) {
      const run = rimInner + OV - (wall - PEN);
      parts.push({ name: 'wedge', geom: sweepSolid(W, D, outerR4, [
        [wall - PEN, H - OV], [rimInner + OV, H - OV], [wall - PEN, H - OV - run]
      ]) });
    }
  }

  // ---- interior floor fillet: concave sweep around each compartment perimeter ----
  if (p.floorFillet) {
    const fr = Math.min(2, cavW / 6, cavD / 6);
    if (fr >= 0.8) {
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const frads = [rcUser, rcUser, rcUser, rcUser];
        if (i === 0        && j === 0       ) frads[0] = rcCorner;
        if (i === cols - 1 && j === 0       ) frads[1] = rcCorner;
        if (i === cols - 1 && j === rows - 1) frads[2] = rcCorner;
        if (i === 0        && j === rows - 1) frads[3] = rcCorner;
        const fcross = [[-PEN, floor - PEN], [fr, floor - PEN], [fr, floor]]
          .concat(arcPts(fr, floor + fr, fr, -Math.PI / 2, -Math.PI, 6))
          .concat([[-PEN, floor + fr]]);
        const fg = sweepSolid(cavW, cavD, frads, fcross);
        fg.translate(xs[i], ys[j], 0);
        parts.push({ name: 'fillet', geom: fg });
      }
    } else {
      warnings.push('Floor fillet skipped: compartments too small.');
    }
  }

  // ---- finger scoops: concave quarter-round fillet at the front of each cavity ----
  if (scoopsOn) {
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const Rs = scoopR;
      const prof = new THREE.Shape();
      prof.moveTo(-PEN, -PEN);
      prof.lineTo(Rs, -PEN);
      prof.lineTo(Rs, 0);
      prof.absarc(Rs, Rs, Rs, -Math.PI / 2, Math.PI, true); // concave, ends at (0, Rs)
      prof.lineTo(-PEN, Rs);
      prof.closePath();
      const g = new THREE.ExtrudeGeometry(prof, { depth: cavW + 2 * PEN, bevelEnabled: false, curveSegments: SEG });
      g.applyMatrix4(PERM); // (u,v,t) -> (t,u,v): u into bin (+y), v up (+z), t across (+x)
      g.translate(xs[i] - cavW / 2 - PEN, ys[j] - cavD / 2, floor);
      parts.push({ name: 'scoop', geom: g });
    }
  }

  // ---- label tab: shelf at front wall top with 45-degree chamfer underneath ----
  if (p.tab) {
    const tabW = Math.min(W - 2 * wall - 2, 60), tabD = 11, th = 1.6;
    if (tabW < 20) {
      warnings.push('Label tab skipped: bin narrower than 24 mm.');
    } else {
      const tp = new THREE.Shape(); // (u,v): u into bin from inner front wall face, v from wall top (CCW)
      tp.moveTo(-PEN, 0);
      tp.lineTo(-PEN, -th - (tabD + PEN));
      tp.lineTo(tabD, -th);
      tp.lineTo(tabD, 0);
      tp.closePath();
      const tg = new THREE.ExtrudeGeometry(tp, { depth: tabW, bevelEnabled: false, curveSegments: SEG });
      tg.applyMatrix4(PERM);
      tg.translate(-tabW / 2, -D / 2 + wall, H);
      parts.push({ name: 'tab', geom: tg });
    }
  }

  // compartment footprints for hover hit-testing, row-major (metadata only —
  // must never affect the emitted geometry)
  const cells = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    cells.push({ i, j, cx: xs[i], cy: ys[j], w: cavW, d: cavD, h: H - floor });
  }

  return {
    parts,
    warnings,
    meta: {
      cavW, cavD, cavH: H - floor,
      cells,
      compartments: cols * rows,
      totalH: H + (lip ? RIM_H : 0),
      lip,
      // stacking interface (null without the lip)
      stackPitch: lip ? stackPitch : null,
      lipFloat: lip ? lipFloat : null,
      lipEngagement: lip ? lipEngagement : null,
      grooveDepth: lip ? grooveDepth : null
    }
  };
}

const eachTriangle = (geom, fn) => {
  const pos = geom.getAttribute('position');
  const idx = geom.getIndex();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    fn(a, b, c);
  }
};

/**
 * Triangle count, total signed volume, and non-finite-triangle count over a
 * part list.
 *
 * @param {Array<{name: string, geom: THREE.BufferGeometry}>} parts
 * @returns {{triangles: number, volumeMM3: number, nonFinite: number}}
 */
export function computeStats(parts) {
  let tris = 0, vol = 0, bad = 0;
  parts.forEach((p) => {
    eachTriangle(p.geom, (a, b, c) => {
      tris++;
      const v = (a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)) / 6;
      if (!isFinite(v)) bad++;
      vol += v;
    });
  });
  return { triangles: tris, volumeMM3: vol, nonFinite: bad };
}

/**
 * Signed volume of one part in mm^3 (positive for an outward-wound closed shell).
 *
 * @param {{name: string, geom: THREE.BufferGeometry}} part
 * @returns {number}
 */
export function partVolume(part) {
  let vol = 0;
  eachTriangle(part.geom, (a, b, c) => {
    vol += (a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)) / 6;
  });
  return vol;
}

/**
 * Serialize parts to a binary STL file image.
 *
 * @param {Array<{name: string, geom: THREE.BufferGeometry}>} parts
 * @returns {ArrayBuffer} 84-byte header + 50 bytes per triangle, little-endian.
 */
export function exportSTL(parts) {
  let tris = 0;
  parts.forEach((p) => {
    const pos = p.geom.getAttribute('position');
    const idx = p.geom.getIndex();
    tris += (idx ? idx.count : pos.count) / 3;
  });
  const buf = new ArrayBuffer(84 + 50 * tris);
  const dv = new DataView(buf);
  const header = 'BinLab parametric bin generator';
  for (let h = 0; h < header.length && h < 80; h++) dv.setUint8(h, header.charCodeAt(h));
  dv.setUint32(80, tris, true);
  let off = 84;
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  parts.forEach((p) => {
    eachTriangle(p.geom, (a, b, c) => {
      ab.copy(b).sub(a); ac.copy(c).sub(a); n.copy(ab).cross(ac).normalize();
      if (!isFinite(n.x)) n.set(0, 0, 1);
      dv.setFloat32(off, n.x, true); dv.setFloat32(off + 4, n.y, true); dv.setFloat32(off + 8, n.z, true);
      dv.setFloat32(off + 12, a.x, true); dv.setFloat32(off + 16, a.y, true); dv.setFloat32(off + 20, a.z, true);
      dv.setFloat32(off + 24, b.x, true); dv.setFloat32(off + 28, b.y, true); dv.setFloat32(off + 32, b.z, true);
      dv.setFloat32(off + 36, c.x, true); dv.setFloat32(off + 40, c.y, true); dv.setFloat32(off + 44, c.z, true);
      dv.setUint16(off + 48, 0, true);
      off += 50;
    });
  });
  return buf;
}
