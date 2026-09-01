import test from 'node:test';
import assert from 'node:assert/strict';
import {
  overlapsAny, nextSpot, snapAxis, clampToEnvelope, cellAt, emptyRectAt,
  layoutIssues, serializeState, parseState
} from '../src/layout.js';

const mk = (x, y, width, depth) => ({ x, y, p: { width, depth } });

test('overlapsAny: touching edges are not overlaps, 0.02 mm intrusion is', () => {
  const trays = [mk(0, 0, 196, 106)];
  assert.equal(overlapsAny(trays, 196, 0, 100, 100, null), false, 'touching right edge');
  assert.equal(overlapsAny(trays, 0, 106, 100, 100, null), false, 'touching back edge');
  assert.equal(overlapsAny(trays, 195.98, 0, 100, 100, null), true, '0.02 mm intrusion in x');
  assert.equal(overlapsAny(trays, 0, 105.98, 100, 100, null), true, '0.02 mm intrusion in y');
  assert.equal(overlapsAny(trays, 0, 0, 196, 106, trays[0]), false, 'self is ignored');
});

test('nextSpot: wraps below when the row is full, fills the row when it fits', () => {
  const env = { w: 338, d: 330.5 };
  const trays = [mk(0, 0, 196, 106)];
  // a second 196-wide tray cannot fit to the right of the first (392 > 338)
  assert.deepEqual(nextSpot(trays, env, 196, 106), { x: 0, y: 106 });
  // a 142-wide tray exactly fills the row (196 + 142 = 338)
  assert.deepEqual(nextSpot(trays, env, 142, 106), { x: 196, y: 0 });
});

test('nextSpot: null when nothing fits', () => {
  const full = [mk(0, 0, 200, 100)];
  assert.equal(nextSpot(full, { w: 200, d: 100 }, 100, 50), null, 'envelope fully occupied');
  assert.equal(nextSpot([], { w: 200, d: 100 }, 300, 50), null, 'tray wider than the envelope');
});

test('snapAxis: butt, align, and envelope snaps within 4 mm only', () => {
  const trays = [mk(50, 0, 100, 100)];
  const span = 338, size = 60;
  assert.equal(snapAxis(trays, 147, size, span, null, 'x'), 150, 'butt against right side');
  assert.equal(snapAxis(trays, 52, size, span, null, 'x'), 50, 'align left edges');
  assert.equal(snapAxis(trays, 92.5, size, span, null, 'x'), 90, 'align right edges');
  assert.equal(snapAxis(trays, 3.9, size, span, null, 'x'), 0, 'envelope start');
  assert.equal(snapAxis(trays, 275, size, span, null, 'x'), 278, 'envelope end (span - size)');
  assert.equal(snapAxis(trays, 154.5, size, span, null, 'x'), 154.5, 'no snap at 4.5 mm');
});

test('clampToEnvelope: envelope bounds and 0.5 mm grid, same rule as dragging', () => {
  assert.equal(clampToEnvelope(-5, 100, 338), 0, 'below zero');
  assert.equal(clampToEnvelope(500, 100, 338), 238, 'past the far edge -> span - size');
  assert.equal(clampToEnvelope(120.3, 100, 338), 120.5, 'snaps to 0.5 mm');
  assert.equal(clampToEnvelope(50, 400, 338), 0, 'tray larger than the envelope pins to 0');
});

test('cellAt: cavity hit, divider and outer wall are null', () => {
  // 100 x 80 tray, wall 2, divider 2, 2 x 1 grid: cavities 47 x 76 at cx ±24.5
  const cells = [
    { i: 0, j: 0, cx: -24.5, cy: 0, w: 47, d: 76, h: 30 },
    { i: 1, j: 0, cx: 24.5, cy: 0, w: 47, d: 76, h: 30 }
  ];
  assert.equal(cellAt(cells, -24.5, 0), cells[0], 'center of the left cavity');
  assert.equal(cellAt(cells, 24.5, 30), cells[1], 'inside the right cavity');
  assert.equal(cellAt(cells, 0, 0), null, 'point on the divider');
  assert.equal(cellAt(cells, -49, 0), null, 'point on the outer wall');
  assert.equal(cellAt(cells, 0, 39), null, 'outside the cavities in y');
});

test('emptyRectAt: inside a tray, L-shaped void, and slivers', () => {
  // L-shaped void: one block in the bottom-left of a 200 x 300 envelope
  const env = { w: 200, d: 300 };
  const trays = [mk(0, 0, 100, 100)];
  assert.equal(emptyRectAt(trays, env, 50, 50), null, 'point inside a tray');
  const r = emptyRectAt(trays, env, 120, 120);
  // x-first expansion gives 200 x 200 above the block; y-first only 100 x 300
  assert.deepEqual(r, { x: 0, y: 100, w: 200, d: 200 });
  assert.equal(overlapsAny(trays, r.x, r.y, r.w, r.d, null), false, 'result overlaps a tray');
  assert.equal(emptyRectAt(trays, env, 250, 50), null, 'point outside the envelope');

  // 3 mm gap between two trays is a sliver
  const gap = [mk(0, 0, 100, 100), mk(103, 0, 97, 100)];
  assert.equal(emptyRectAt(gap, { w: 200, d: 100 }, 101.5, 50), null, 'sub-5 mm sliver');
});

test('layoutIssues: overlap pairs and envelope violations with tray indices', () => {
  const env = { w: 338, d: 330.5 };
  const trays = [mk(0, 0, 196, 106), mk(150, 0, 196, 106), mk(200, 300, 100, 100)];
  const { issues, bad } = layoutIssues(trays, env);
  assert.ok(issues.some((s) => s.includes('T1 overlaps T2')), issues.join('; '));
  assert.ok(issues.some((s) => s.startsWith('T3 exceeds the usable envelope')), issues.join('; '));
  assert.deepEqual(bad, { 0: 1, 1: 1, 2: 1 });

  const clean = layoutIssues([mk(0, 0, 100, 100)], env);
  assert.deepEqual(clean, { issues: [], bad: {} });
});

test('state round-trip and malformed hashes', () => {
  const params = {
    width: 160, depth: 100, height: 35, cols: 3, rows: 2, wall: 1.8, floor: 2,
    divider: 1.2, radius: 3, radiusIn: 1.5,
    lip: false, tab: false, scoops: false, floorHoles: false, floorFillet: false
  };
  const defaults = { drawer: { w: 340, d: 332.5, clr: 2 }, params };
  const state = {
    drawer: { on: true, w: 340, d: 332.5, clr: 2 },
    trays: [
      { x: 0, y: 0, p: { ...params } },
      { x: 196, y: 0, p: { ...params, width: 142, lip: true } }
    ]
  };
  assert.deepEqual(parseState(serializeState(state), defaults), state);

  assert.equal(parseState('', defaults), false);
  assert.equal(parseState('#', defaults), false);
  assert.equal(parseState('#not-json', defaults), false);
  assert.equal(parseState('#%zz', defaults), false, 'bad URI encoding must not throw');
  assert.equal(parseState('#' + encodeURIComponent('{"t":[]}'), defaults), false, 'empty tray list');
});
