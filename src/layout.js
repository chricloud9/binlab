// BinLab drawer-layout helpers. Pure: no DOM, no three.js.
// A tray is { x, y, p } with p.width / p.depth in mm; an envelope is the
// usable drawer area { w, d }. Coordinates are top-view, origin at the
// drawer's front-left corner. Comparisons use a 0.01 mm epsilon so trays
// that merely touch are not treated as overlapping.

/**
 * Format a number for display: fixed decimals, trailing ".0" stripped.
 * @param {number} v
 * @param {number} [d=1] decimal places
 * @returns {string}
 */
export function fmt(v, d) { return (+v).toFixed(d === undefined ? 1 : d).replace(/\.0$/, ''); }

/**
 * Whether a w x d rect at (x, y) overlaps any tray (touching edges do not count).
 * @param {Array<object>} trays
 * @param {number} x @param {number} y @param {number} w @param {number} d
 * @param {object|null} self tray to ignore (identity comparison)
 * @returns {boolean}
 */
export function overlapsAny(trays, x, y, w, d, self) {
  for (let i = 0; i < trays.length; i++) {
    const t = trays[i];
    if (t === self) continue;
    if (x < t.x + t.p.width - 0.01 && t.x < x + w - 0.01 &&
        y < t.y + t.p.depth - 0.01 && t.y < y + d - 0.01) return true;
  }
  return false;
}

/**
 * First free spot for a w x d tray: candidates are the origin and the right /
 * back edge of every tray, preferring lowest y, then lowest x.
 * @param {Array<object>} trays
 * @param {{w: number, d: number}} env usable envelope
 * @param {number} w @param {number} d
 * @returns {{x: number, y: number}|null} snapped to 0.5 mm; null if nothing fits
 */
export function nextSpot(trays, env, w, d) {
  const cands = [{ x: 0, y: 0 }];
  trays.forEach((t) => {
    cands.push({ x: t.x + t.p.width, y: t.y });
    cands.push({ x: t.x, y: t.y + t.p.depth });
  });
  let best = null;
  cands.forEach((c) => {
    if (c.x + w > env.w + 0.01 || c.y + d > env.d + 0.01) return;
    if (overlapsAny(trays, c.x, c.y, w, d, null)) return;
    if (!best || c.y < best.y - 0.01 || (Math.abs(c.y - best.y) < 0.01 && c.x < best.x)) best = c;
  });
  return best ? { x: Math.round(best.x * 2) / 2, y: Math.round(best.y * 2) / 2 } : null;
}

/**
 * Clamp a tray position into the envelope on one axis and snap it to the
 * 0.5 mm grid — the same rule dragging uses, shared by the typed X/Y inputs.
 * @param {number} v proposed position on the axis
 * @param {number} size tray extent on the axis
 * @param {number} span envelope extent on the axis
 * @returns {number}
 */
export function clampToEnvelope(v, size, span) {
  return Math.round(Math.max(0, Math.min(Math.max(0, span - size), v)) * 2) / 2;
}

/**
 * Snap a dragged tray edge coordinate to nearby tray edges (butt or align)
 * and the envelope edges, within 4 mm.
 * @param {Array<object>} trays
 * @param {number} v proposed position on the axis
 * @param {number} size tray extent on the axis
 * @param {number} span envelope extent on the axis
 * @param {object|null} self tray being dragged (excluded)
 * @param {'x'|'y'} axis
 * @returns {number} snapped position (v unchanged if nothing is in range)
 */
export function snapAxis(trays, v, size, span, self, axis) {
  const SNAP = 4, cands = [0, span - size];
  trays.forEach((o) => {
    if (o === self) return;
    const os = axis === 'x' ? o.x : o.y;
    const ol = axis === 'x' ? o.p.width : o.p.depth;
    cands.push(os + ol, os - size, os, os + ol - size); // butt either side, align either edge
  });
  let best = v, bd = SNAP;
  cands.forEach((c) => { const d2 = Math.abs(c - v); if (d2 < bd) { bd = d2; best = c; } });
  return best;
}

/**
 * Largest empty axis-aligned rect around a point, or null.
 * Expands to the nearest tray/envelope edges twice (row-first and
 * column-first) and keeps the larger result, so a point in an L-shaped void
 * gets the better of the two rectangles. Slivers under 5 mm are rejected.
 * @param {Array<object>} trays
 * @param {{w: number, d: number}} env usable envelope
 * @param {number} px @param {number} py point in envelope coordinates
 * @returns {{x: number, y: number, w: number, d: number}|null}
 */
export function emptyRectAt(trays, env, px, py) {
  if (px < 0 || py < 0 || px > env.w || py > env.d) return null;
  for (let i = 0; i < trays.length; i++) {
    const t = trays[i];
    if (px > t.x && px < t.x + t.p.width && py > t.y && py < t.y + t.p.depth) return null;
  }
  function expand(xFirst) {
    let x0 = 0, x1 = env.w, y0 = 0, y1 = env.d;
    function passX(yl, yh) {
      trays.forEach((t) => {
        if (t.y < yh - 0.01 && t.y + t.p.depth > yl + 0.01) {
          const tx1 = t.x + t.p.width;
          if (tx1 <= px + 0.01 && tx1 > x0) x0 = tx1;
          if (t.x >= px - 0.01 && t.x < x1) x1 = t.x;
        }
      });
    }
    function passY(xl, xh) {
      trays.forEach((t) => {
        if (t.x < xh - 0.01 && t.x + t.p.width > xl + 0.01) {
          const ty1 = t.y + t.p.depth;
          if (ty1 <= py + 0.01 && ty1 > y0) y0 = ty1;
          if (t.y >= py - 0.01 && t.y < y1) y1 = t.y;
        }
      });
    }
    if (xFirst) { passX(py, py); passY(x0, x1); } else { passY(px, px); passX(y0, y1); }
    return { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
  }
  const a = expand(true), b = expand(false);
  const r = (a.w * a.d >= b.w * b.d) ? a : b;
  return (r.w < 5 || r.d < 5) ? null : r;
}

/**
 * Human-readable layout problems: trays outside the envelope and pairwise
 * overlaps, plus a map of offending tray indices (used for the red warning
 * cages).
 * @param {Array<object>} trays
 * @param {{w: number, d: number}} env usable envelope
 * @returns {{issues: string[], bad: Object<number, 1>}}
 */
export function layoutIssues(trays, env) {
  const issues = [];
  const bad = {};
  trays.forEach((t, i) => {
    if (t.x + t.p.width > env.w + 0.01 || t.y + t.p.depth > env.d + 0.01) {
      issues.push('T' + (i + 1) + ' exceeds the usable envelope ' + fmt(env.w) + ' × ' + fmt(env.d) + '.');
      bad[i] = 1;
    }
  });
  for (let a = 0; a < trays.length; a++) for (let b = a + 1; b < trays.length; b++) {
    const A = trays[a], B = trays[b];
    if (A.x < B.x + B.p.width - 0.01 && B.x < A.x + A.p.width - 0.01 &&
        A.y < B.y + B.p.depth - 0.01 && B.y < A.y + A.p.depth - 0.01) {
      issues.push('T' + (a + 1) + ' overlaps T' + (b + 1) + '.');
      bad[a] = 1; bad[b] = 1;
    }
  }
  return { issues, bad };
}

/**
 * Serialize drawer + tray state to a URL hash string.
 * @param {{drawer: {on: boolean, w: number, d: number, clr: number},
 *   trays: Array<{x: number, y: number, p: object}>}} state
 * @returns {string} '#' + URI-encoded JSON
 */
export function serializeState(state) {
  const s = {
    d: { on: state.drawer.on, w: state.drawer.w, d: state.drawer.d, clr: state.drawer.clr },
    t: state.trays.map((t) => ({ x: t.x, y: t.y, p: t.p }))
  };
  return '#' + encodeURIComponent(JSON.stringify(s));
}

/**
 * Parse a URL hash back into drawer + tray state. Unknown parameter keys are
 * dropped, missing ones filled from defaults, tray count capped at 24.
 * @param {string} hash location.hash, '#' included
 * @param {{drawer: {w: number, d: number, clr: number}, params: object}} defaults
 *   fallback drawer dims and a template of valid tray parameters
 * @returns {{drawer: {on: boolean, w: number, d: number, clr: number},
 *   trays: Array<{x: number, y: number, p: object}>}|false} false if the hash
 *   is empty or malformed (never throws)
 */
export function parseState(hash, defaults) {
  try {
    if (!hash || hash.length < 3) return false;
    const s = JSON.parse(decodeURIComponent(hash.slice(1)));
    if (!s || !s.t || !s.t.length) return false;
    const drawer = { on: !!(s.d && s.d.on), w: defaults.drawer.w, d: defaults.drawer.d, clr: defaults.drawer.clr };
    if (s.d) {
      drawer.w = +s.d.w || drawer.w;
      drawer.d = +s.d.d || drawer.d;
      drawer.clr = (+s.d.clr >= 0) ? +s.d.clr : drawer.clr;
    }
    // hard cap: a hand-edited or hostile hash must not create an unbounded
    // number of trays (each one costs a full geometry rebuild)
    const trays = s.t.slice(0, 24).map((t) => {
      const p = Object.assign({}, defaults.params);
      Object.keys(p).forEach((k) => { if (t.p && t.p[k] !== undefined) p[k] = t.p[k]; });
      return { x: +t.x || 0, y: +t.y || 0, p };
    });
    return { drawer, trays };
  } catch (e) { return false; }
}
