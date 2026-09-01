// BinLab app: DOM controls, tray bar, presets, title block, fit checker,
// download, share, keyboard, and the wiring between geometry, layout, and
// viewer. All three.js work lives in viewer.js; all math in geometry/layout.

import { buildParts, computeStats, exportSTL } from './geometry.js';
import {
  fmt, nextSpot, snapAxis, clampToEnvelope, emptyRectAt, layoutIssues,
  serializeState, parseState
} from './layout.js';
import {
  canvas, planePoint, pickTray, setSpin, orbitRotate, orbitZoom, requestRefit,
  fitView, setDrawerVisuals, showHover, hideHover, disposeGroup, buildTrayGroup,
  setTrayHighlight, makeWarnBox, setBinColor, resize, startAnimation
} from './viewer.js';

/* ---------------- parameter definitions ---------------- */
const DEFS = [
  { sec: 'c-dims',  id: 'width',   lab: 'width',   min: 40,  max: 450, step: 1,   val: 160 },
  { sec: 'c-dims',  id: 'depth',   lab: 'depth',   min: 40,  max: 450, step: 1,   val: 100 },
  { sec: 'c-dims',  id: 'height',  lab: 'height',  min: 10,  max: 150, step: 1,   val: 35 },
  { sec: 'c-grid',  id: 'cols',    lab: 'columns', min: 1,   max: 12,  step: 1,   val: 3 },
  { sec: 'c-grid',  id: 'rows',    lab: 'rows',    min: 1,   max: 12,  step: 1,   val: 2 },
  { sec: 'c-walls', id: 'wall',    lab: 'wall',    min: 0.8, max: 4,   step: 0.1, val: 1.8 },
  { sec: 'c-walls', id: 'floor',   lab: 'floor',   min: 0.8, max: 5,   step: 0.1, val: 2 },
  { sec: 'c-walls', id: 'divider', lab: 'divider', min: 0.8, max: 4,   step: 0.1, val: 1.2 },
  { sec: 'c-style', id: 'radius',   lab: 'outer radius', min: 0, max: 16, step: 0.5, val: 3 },
  { sec: 'c-style', id: 'radiusIn', lab: 'inner radius', min: 0, max: 12, step: 0.5, val: 1.5 }
];
const FLAGS = ['lip', 'tab', 'scoops', 'floorHoles', 'floorFillet'];
const inputs = {};

function defaultParams() {
  const p = {};
  DEFS.forEach((d) => { p[d.id] = d.val; });
  FLAGS.forEach((f) => { p[f] = false; });
  return p;
}
function readParams() {
  const p = {};
  DEFS.forEach((d) => { p[d.id] = parseFloat(inputs[d.id].value); });
  FLAGS.forEach((f) => { p[f] = document.getElementById('f-' + f).checked; });
  return p;
}
function writeInputs(t) {
  DEFS.forEach((d) => {
    inputs[d.id].value = t.p[d.id];
    document.getElementById('r-' + d.id).value = t.p[d.id];
  });
  FLAGS.forEach((f) => { document.getElementById('f-' + f).checked = !!t.p[f]; });
  document.getElementById('px').value = t.x;
  document.getElementById('py').value = t.y;
}

DEFS.forEach((d) => {
  const host = document.getElementById(d.sec);
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = `<label for="r-${d.id}">${d.lab}<em>${d.min}–${d.max}</em></label>`
    + `<input type="range" id="r-${d.id}" min="${d.min}" max="${d.max}" step="${d.step}" value="${d.val}">`
    + `<input type="number" id="n-${d.id}" min="${d.min}" max="${d.max}" step="${d.step}" value="${d.val}" aria-label="${d.lab}">`;
  host.appendChild(row);
  const r = row.children[1], n = row.children[2];
  r.addEventListener('input', () => { n.value = r.value; onParamChange(); });
  n.addEventListener('input', () => { r.value = n.value; onParamChange(); });
  n.addEventListener('change', () => {
    const v = Math.max(d.min, Math.min(d.max, parseFloat(n.value) || d.min));
    n.value = v; r.value = v; onParamChange();
  });
  inputs[d.id] = n;
});
FLAGS.forEach((f) => {
  document.getElementById('f-' + f).addEventListener('change', onParamChange);
});

/* ---------------- state ---------------- */
function makeTray(x, y, p) {
  return { x, y, p, group: null, warnBox: null, parts: null, meta: null, stats: null, err: null, gwarn: [] };
}
let trays = [makeTray(0, 0, defaultParams())];
let sel = 0;
const drawer = { on: false, w: 340, d: 332.5, clr: 2 };

function usable() { return { w: drawer.w - drawer.clr, d: drawer.d - drawer.clr }; }

document.getElementById('drawerOn').addEventListener('change', (e) => {
  drawer.on = e.target.checked;
  requestRefit();
  renderTrayBar(); updateScene();
});
['dw', 'dd', 'dclr'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    const num = (nid, fallback) => {
      const v = parseFloat(document.getElementById(nid).value);
      return Number.isFinite(v) ? v : fallback;
    };
    drawer.w = num('dw', drawer.w);
    drawer.d = num('dd', drawer.d);
    drawer.clr = num('dclr', drawer.clr);
    requestRefit(); updateScene();
  });
});
['px', 'py'].forEach((id, k) => {
  document.getElementById(id).addEventListener('change', (e) => {
    const t = trays[sel], u = usable();
    const v = clampToEnvelope(parseFloat(e.target.value) || 0,
      k === 0 ? t.p.width : t.p.depth, k === 0 ? u.w : u.d);
    t[k === 0 ? 'x' : 'y'] = v;
    e.target.value = v;
    updateScene();
  });
});

/* ---------------- tray bar ---------------- */
function renderTrayBar() {
  const bar = document.getElementById('traybar');
  bar.innerHTML = '';
  trays.forEach((t, i) => {
    const b = document.createElement('button');
    b.textContent = 'T' + (i + 1);
    if (i === sel) b.className = 'active';
    b.addEventListener('click', () => {
      sel = i; writeInputs(trays[sel]); renderTrayBar(); updateScene();
    });
    bar.appendChild(b);
  });
  const mk = (txt, title, fn, disabled) => {
    const b = document.createElement('button');
    b.textContent = txt; b.title = title; b.className = 'act'; b.disabled = !!disabled;
    b.addEventListener('click', fn); bar.appendChild(b);
  };
  mk('+', 'add tray', () => { addTray(defaultParams()); }, !drawer.on);
  mk('⧉', 'duplicate selected', () => { addTray(JSON.parse(JSON.stringify(trays[sel].p))); }, !drawer.on);
  mk('✕', 'delete selected', () => { deleteTray(sel); }, !drawer.on || trays.length < 2);
  document.getElementById('drawerDims').className = 'duo' + (drawer.on ? '' : ' dim');
  document.getElementById('posrow').className = 'duo' + (drawer.on ? '' : ' dim');
}

let addTrayWarn = null, addTrayWarnT = null;
function addTray(p) {
  const spot = nextSpot(trays, usable(), p.width, p.depth);
  if (!spot) {
    addTrayWarn = 'No free spot for a ' + fmt(p.width) + ' × ' + fmt(p.depth) + ' mm tray — clear space or enlarge the drawer.';
    clearTimeout(addTrayWarnT);
    addTrayWarnT = setTimeout(() => { addTrayWarn = null; updateScene(); }, 4000);
    updateScene();
    return;
  }
  trays.push(makeTray(spot.x, spot.y, p));
  sel = trays.length - 1;
  writeInputs(trays[sel]); renderTrayBar(); rebuildTray(sel);
}
function deleteTray(i) {
  disposeGroup(trays[i].group); disposeGroup(trays[i].warnBox);
  trays.splice(i, 1);
  sel = Math.min(sel, trays.length - 1);
  writeInputs(trays[sel]); renderTrayBar(); updateScene();
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Backspace' && e.key !== 'Delete') return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
  if (!drawer.on || trays.length < 2) return;
  e.preventDefault();
  deleteTray(sel);
});

/* ---------------- presets (apply to selected tray) ---------------- */
const PRESETS = {
  'SMALL TRAY': { width: 120, depth: 90,  height: 30, cols: 3, rows: 2, wall: 1.6, floor: 2,   divider: 1.2, radius: 3, radiusIn: 1.5, lip: 0, tab: 0, scoops: 0, floorHoles: 0, floorFillet: 0 },
  'DESK':       { width: 220, depth: 110, height: 40, cols: 4, rows: 2, wall: 2,   floor: 2.4, divider: 1.6, radius: 4, radiusIn: 2,   lip: 0, tab: 0, scoops: 0, floorHoles: 0, floorFillet: 1 },
  'PARTS BIN':  { width: 160, depth: 100, height: 60, cols: 1, rows: 1, wall: 2.4, floor: 2.4, divider: 1.2, radius: 4, radiusIn: 2.5, lip: 1, tab: 1, scoops: 1, floorHoles: 0, floorFillet: 1 },
  'DRAWER':     { width: 400, depth: 280, height: 55, cols: 5, rows: 4, wall: 2,   floor: 2,   divider: 1.4, radius: 3, radiusIn: 1.5, lip: 0, tab: 0, scoops: 0, floorHoles: 1, floorFillet: 0 },
  'TOOL':       { width: 250, depth: 80,  height: 45, cols: 6, rows: 1, wall: 2,   floor: 2.4, divider: 1.8, radius: 3, radiusIn: 1.5, lip: 0, tab: 0, scoops: 0, floorHoles: 0, floorFillet: 0 },
  'SCREWS':     { width: 180, depth: 120, height: 25, cols: 6, rows: 4, wall: 1.6, floor: 1.6, divider: 1,   radius: 2, radiusIn: 1,   lip: 1, tab: 0, scoops: 1, floorHoles: 0, floorFillet: 0 }
};
const presetHost = document.getElementById('presets');
Object.keys(PRESETS).forEach((name) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', () => {
    const src = PRESETS[name], p = {};
    DEFS.forEach((d) => { p[d.id] = src[d.id]; });
    FLAGS.forEach((f) => { p[f] = !!src[f]; });
    trays[sel].p = p;
    writeInputs(trays[sel]);
    presetHost.querySelectorAll('button').forEach((x) => { x.classList.remove('active'); });
    b.classList.add('active');
    requestRefit(); scheduleRebuild();
  });
  presetHost.appendChild(b);
});

document.getElementById('binColor').addEventListener('input', (e) => { setBinColor(e.target.value); });
document.getElementById('printer').addEventListener('change', updateFit);

/* ---------------- canvas interaction: orbit, drag, hover ---------------- */
const pointers = new Map();
let lastPinch = 0;
let drag = null;

canvas.addEventListener('dblclick', (e) => {
  if (!drawer.on || pickTray(e, trays)) return;
  const uu = usable(), pp = planePoint(e);
  if (!pp) return;
  const rect = emptyRectAt(trays, uu, pp.mx + uu.w / 2, pp.my + uu.d / 2);
  if (!rect || rect.w < 40 || rect.d < 40) return;
  const p = JSON.parse(JSON.stringify(trays[sel].p));
  p.width = Math.min(450, Math.round(rect.w * 2) / 2);
  p.depth = Math.min(450, Math.round(rect.d * 2) / 2);
  trays.push(makeTray(Math.round(rect.x * 2) / 2, Math.round(rect.y * 2) / 2, p));
  sel = trays.length - 1;
  hideHover();
  writeInputs(trays[sel]); renderTrayBar(); rebuildTray(sel);
});

canvas.addEventListener('pointerdown', (e) => {
  setSpin(false);
  hideHover();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2 && drag) { drag = null; updateScene(); }
  if (pointers.size === 1) {
    const t = drawer.on ? pickTray(e, trays) : null;
    if (t) {
      const i = trays.indexOf(t);
      if (i !== sel) { sel = i; writeInputs(t); renderTrayBar(); updateScene(); }
      const pp = planePoint(e);
      if (pp) {
        const uu = usable();
        drag = { t, offX: pp.mx - (-uu.w / 2 + t.x), offY: pp.my - (-uu.d / 2 + t.y) };
      }
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (pointers.size === 0 && drawer.on) {
    if (pickTray(e, trays)) { canvas.style.cursor = 'move'; hideHover(); return; }
    const hp = planePoint(e);
    const hu = usable();
    const hr = hp ? emptyRectAt(trays, hu, hp.mx + hu.w / 2, hp.my + hu.d / 2) : null;
    if (hr && hr.w >= 40 && hr.d >= 40) { canvas.style.cursor = 'copy'; showHover(hr, hu); }
    else { canvas.style.cursor = ''; hideHover(); }
    return;
  }
  if (pointers.size === 0) { hideHover(); return; }
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (drag && pointers.size === 1) {
    const pp = planePoint(e);
    if (!pp) return;
    const uu = usable(), w = drag.t.p.width, d = drag.t.p.depth;
    const nx = snapAxis(trays, pp.mx - drag.offX + uu.w / 2, w, uu.w, drag.t, 'x');
    const ny = snapAxis(trays, pp.my - drag.offY + uu.d / 2, d, uu.d, drag.t, 'y');
    drag.t.x = clampToEnvelope(nx, w, uu.w);
    drag.t.y = clampToEnvelope(ny, d, uu.d);
    document.getElementById('px').value = drag.t.x;
    document.getElementById('py').value = drag.t.y;
    drag.t.group.position.set(-uu.w / 2 + drag.t.x + w / 2, -uu.d / 2 + drag.t.y + d / 2, 0);
    if (drag.t.warnBox) {
      drag.t.warnBox.position.x = drag.t.group.position.x;
      drag.t.warnBox.position.y = drag.t.group.position.y;
    }
    return;
  }
  if (pointers.size === 1) {
    orbitRotate(e.clientX - prev.x, e.clientY - prev.y);
  } else if (pointers.size === 2) {
    const pts = Array.from(pointers.values());
    const dd2 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (lastPinch) orbitZoom(lastPinch / dd2);
    lastPinch = dd2;
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId); lastPinch = 0;
  if (drag) { drag = null; updateScene(); }
}
canvas.addEventListener('pointerleave', () => { hideHover(); });
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbitZoom(1 + Math.sign(e.deltaY) * 0.09);
}, { passive: false });

/* ---------------- rebuild ---------------- */
let timer = null;
function onParamChange() { trays[sel].p = readParams(); scheduleRebuild(); }
function scheduleRebuild() { clearTimeout(timer); timer = setTimeout(() => { rebuildTray(sel); }, 120); }

function rebuildTray(i) {
  const t = trays[i];
  const out = buildParts(t.p);
  disposeGroup(t.group); t.group = null;
  if (out.error) {
    t.err = out.error; t.parts = null; t.meta = null; t.stats = null; t.gwarn = [];
  } else {
    t.err = null;
    t.group = buildTrayGroup(out.parts, t);
    t.parts = out.parts; t.meta = out.meta; t.gwarn = out.warnings;
    t.stats = computeStats(out.parts);
  }
  updateScene();
}

function updateScene() {
  const u = usable();
  if (!drawer.on) hideHover();
  // positions + visibility + selection edges + warn boxes
  trays.forEach((t, i) => {
    disposeGroup(t.warnBox); t.warnBox = null;
    if (!t.group) return;
    if (drawer.on) {
      t.group.visible = true;
      t.group.position.set(-u.w / 2 + t.x + t.p.width / 2, -u.d / 2 + t.y + t.p.depth / 2, 0);
    } else {
      t.group.visible = (i === sel);
      t.group.position.set(0, 0, 0);
    }
    setTrayHighlight(t.group, drawer.on && i === sel);
  });
  const { issues, bad } = drawer.on ? layoutIssues(trays, u) : { issues: [], bad: {} };
  if (drawer.on) trays.forEach((t, i) => {
    if (!bad[i] || !t.group) return;
    const h = t.meta ? t.meta.totalH : t.p.height;
    const box = makeWarnBox(t.p.width, t.p.depth, h);
    box.position.copy(t.group.position); box.position.z = h / 2;
    t.warnBox = box;
  });

  // drawer visuals
  setDrawerVisuals(drawer.on ? { w: drawer.w, d: drawer.d, uw: u.w, ud: u.d } : null);

  // grid + camera
  const spanBase = drawer.on ? Math.max(drawer.w, drawer.d) : Math.max(trays[sel].p.width, trays[sel].p.depth);
  const st = trays[sel];
  const hTot = st.meta ? st.meta.totalH : st.p.height;
  const diag = drawer.on ? Math.hypot(drawer.w, drawer.d, 80) : Math.hypot(st.p.width, st.p.depth, hTot);
  fitView(spanBase, diag, drawer.on ? 10 : hTot * 0.42, drawer.on ? 1.25 : 1.55);

  // title block
  const errEl = document.getElementById('err');
  const dl = document.getElementById('dl');
  if (st.err) { errEl.textContent = 'T' + (sel + 1) + ': ' + st.err; errEl.style.display = 'block'; dl.disabled = true; }
  else { errEl.style.display = 'none'; dl.disabled = false; }
  dl.textContent = drawer.on ? 'Download STL · T' + (sel + 1) : 'Download STL';

  document.getElementById('tbDrawerRow').style.display = drawer.on ? '' : 'none';
  document.getElementById('tbTrayRow').style.display = drawer.on ? '' : 'none';
  if (drawer.on) {
    let area = 0;
    trays.forEach((t) => { area += t.p.width * t.p.depth; });
    document.getElementById('t-drawer').textContent =
      fmt(drawer.w) + ' × ' + fmt(drawer.d) + ' · ' + Math.min(100, Math.round(100 * area / (u.w * u.d))) + '%';
    document.getElementById('t-tray').textContent = (sel + 1) + ' / ' + trays.length + ' · at ' + fmt(st.x) + ', ' + fmt(st.y);
  }
  if (st.meta && st.stats) {
    document.getElementById('t-body').textContent = fmt(st.p.width, 0) + ' × ' + fmt(st.p.depth, 0) + ' × ' + fmt(st.meta.totalH);
    document.getElementById('t-cells').textContent = st.meta.compartments + ' · ' + st.p.cols + '×' + st.p.rows;
    document.getElementById('t-id').textContent = fmt(st.meta.cavW) + ' × ' + fmt(st.meta.cavD) + ' × ' + fmt(st.meta.cavH);
    document.getElementById('t-vol').textContent = (st.stats.volumeMM3 / 1000).toFixed(1) + ' cm³';
    document.getElementById('t-mass').textContent = '≈ ' + Math.round(st.stats.volumeMM3 * 1.24 / 1000) + ' g';
    document.getElementById('t-mesh').textContent = st.stats.triangles.toLocaleString() + ' tris';
  }

  // warnings
  const w = document.getElementById('warns');
  w.innerHTML = '';
  (st.gwarn || []).concat(issues, addTrayWarn ? [addTrayWarn] : []).forEach((txt) => {
    const d = document.createElement('div'); d.textContent = txt; w.appendChild(d);
  });
  updateFit();
  clearTimeout(hashT); hashT = setTimeout(stateToHash, 400);
}

function updateFit() {
  const el = document.getElementById('fit');
  const v = document.getElementById('printer').value;
  if (!v) { el.textContent = ''; el.className = ''; return; }
  const bed = v.split(',').map(Number);
  const msgs = [];
  let anyBad = false;
  trays.forEach((t, i) => {
    if (drawer.on === false && i !== sel) return;
    const W = t.p.width, D = t.p.depth, Hh = t.meta ? t.meta.totalH : t.p.height;
    const xy = (W <= bed[0] && D <= bed[1]) || (W <= bed[1] && D <= bed[0]);
    const z = Hh <= bed[2];
    if (!(xy && z)) { anyBad = true; msgs.push('T' + (i + 1) + (!xy ? ' exceeds bed' : ' too tall')); }
  });
  if (anyBad) { el.textContent = msgs.join(' · ') + ' (' + bed[0] + '×' + bed[1] + '×' + bed[2] + ')'; el.className = 'bad'; }
  else { el.textContent = (drawer.on ? 'ALL TRAYS FIT' : 'FITS') + ' · ' + bed[0] + '×' + bed[1] + ' bed'; el.className = 'ok'; }
}

/* ---------------- download ---------------- */
document.getElementById('dl').addEventListener('click', () => {
  const st = trays[sel];
  if (!st.parts) return;
  const buf = exportSTL(st.parts);
  const blob = new Blob([buf], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const p = st.p;
  a.download = (drawer.on ? 'tray' + (sel + 1) + '_' : 'bin_') + p.width + 'x' + p.depth + 'x' + p.height + '_' + p.cols + 'x' + p.rows + '.stl';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
});

/* ---------------- share / URL state ---------------- */
let hashT = null;
function stateToHash() {
  try {
    const h = serializeState({ drawer, trays });
    if (h.length < 6000) history.replaceState(null, '', h);
  } catch (e) { /* history API unavailable (e.g. sandboxed frame) */ }
}
function stateFromHash() {
  const s = parseState(location.hash, { drawer: { w: drawer.w, d: drawer.d, clr: drawer.clr }, params: defaultParams() });
  if (!s) return false;
  drawer.on = s.drawer.on; drawer.w = s.drawer.w; drawer.d = s.drawer.d; drawer.clr = s.drawer.clr;
  document.getElementById('drawerOn').checked = drawer.on;
  document.getElementById('dw').value = drawer.w;
  document.getElementById('dd').value = drawer.d;
  document.getElementById('dclr').value = drawer.clr;
  trays = s.trays.map((t) => makeTray(t.x, t.y, t.p));
  sel = 0;
  return true;
}
const shareBtn = document.getElementById('share');
if (shareBtn) shareBtn.addEventListener('click', () => {
  stateToHash();
  const url = location.href;
  const done = () => { shareBtn.textContent = 'Copied'; setTimeout(() => { shareBtn.textContent = 'Share'; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => { window.prompt('Copy link:', url); });
  else window.prompt('Copy link:', url);
});

/* ---------------- go ---------------- */
stateFromHash();
renderTrayBar();
writeInputs(trays[sel]);
resize();
trays.forEach((_, i) => { rebuildTray(i); });
startAnimation();
