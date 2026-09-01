// BinLab viewer: three.js scene, lights, grid, orbit camera, pick/drag plane
// math, hover highlight, and the drawer wireframe. Owns everything that
// touches THREE; the app layer only moves the objects it gets back.
// Display space is three.js y-up; the world group is rotated so model z-up
// geometry stands upright. Expects a global `THREE` (r128).
/* global THREE */

const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
stage.insertBefore(renderer.domElement, stage.firstChild);

/** The WebGL canvas (for cursor styling and event wiring). */
export const canvas = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e4e79);
const camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
scene.add(new THREE.HemisphereLight(0xdfeaf4, 0x24405c, 0.95));
const key = new THREE.DirectionalLight(0xffffff, 0.75); key.position.set(1, 1.6, 0.9); scene.add(key);
const fill = new THREE.DirectionalLight(0xbcd4e8, 0.28); fill.position.set(-1.2, 0.7, -0.8); scene.add(fill);

const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);
let grid = null, drawerVis = null;

const binMat = new THREE.MeshStandardMaterial({ color: 0xd7d3c8, roughness: 0.55, metalness: 0.05 });
const edgeMat = new THREE.LineBasicMaterial({ color: 0xeaf2f8, transparent: true, opacity: 0.32 });
const selEdgeMat = new THREE.LineBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.85 });
const errMat = new THREE.LineBasicMaterial({ color: 0xff8a5c });
const drawerLineMat = new THREE.LineBasicMaterial({ color: 0xbcd9ef, transparent: true, opacity: 0.9 });
const usableMat = new THREE.LineDashedMaterial({ color: 0x8fd0ff, dashSize: 6, gapSize: 5, transparent: true, opacity: 0.8 });
const floorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide });

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const orbit = { theta: 0.65, phi: 1.12, radius: 320, spin: !reduced };
const target = new THREE.Vector3(0, 20, 0);
let refit = true;

const raycaster = new THREE.Raycaster();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // display-space floor

const pointerNDC = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
};

/**
 * Project a pointer event onto the drawer floor plane.
 * @returns {{mx: number, my: number}|null} model-space x/y in mm, or null when
 *   the ray misses the plane
 */
export function planePoint(e) {
  raycaster.setFromCamera(pointerNDC(e), camera);
  const v = new THREE.Vector3();
  return raycaster.ray.intersectPlane(dragPlane, v) ? { mx: v.x, my: -v.z } : null;
}

/**
 * Raycast a pointer event against the visible tray meshes and return the hit
 * in tray-local model coordinates (z-up, origin at the tray center) — the
 * space meta.cells lives in. Pointing into a cavity hits the floor surface;
 * a wall-top hit lands between cell footprints.
 * @param {Array<object>} trays tray list (each with a .group)
 * @returns {{tray: object, x: number, y: number}|null}
 */
export function pickTrayPoint(e, trays) {
  raycaster.setFromCamera(pointerNDC(e), camera);
  const meshes = [];
  trays.forEach((t) => {
    if (t.group && t.group.visible) t.group.traverse((o) => { if (o.isMesh) meshes.push(o); });
  });
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const tray = hits[0].object.userData.tray;
  const local = tray.group.worldToLocal(hits[0].point.clone());
  return { tray, x: local.x, y: local.y };
}

/**
 * Raycast a pointer event against the visible tray meshes.
 * @param {Array<object>} trays tray list (each with a .group)
 * @returns {object|null} the hit tray
 */
export function pickTray(e, trays) {
  const hit = pickTrayPoint(e, trays);
  return hit ? hit.tray : null;
}

/** Enable or pause the idle turntable spin. */
export function setSpin(v) { orbit.spin = v; }

/** Rotate the orbit camera by a pointer delta in pixels. */
export function orbitRotate(dx, dy) {
  orbit.theta -= dx * 0.006;
  orbit.phi -= dy * 0.006;
  orbit.phi = Math.max(0.05, Math.min(3.05, orbit.phi));
}

/** Scale the orbit distance (wheel/pinch zoom), clamped to 60–3000 mm. */
export function orbitZoom(scale) {
  orbit.radius = Math.max(60, Math.min(3000, orbit.radius * scale));
}

/** Ask the next fitView call to also reset the orbit distance. */
export function requestRefit() { refit = true; }

/**
 * Rebuild the ground grid and aim the camera.
 * @param {number} spanBase largest footprint dimension the grid must cover
 * @param {number} diag scene diagonal used for the refit distance
 * @param {number} targetY look-at height
 * @param {number} fitScale distance multiplier applied on a pending refit
 */
export function fitView(spanBase, diag, targetY, fitScale) {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  const span = spanBase * 2.2;
  grid = new THREE.GridHelper(span, Math.round(span / 20), 0x35699a, 0x2a5a89);
  scene.add(grid);
  target.set(0, targetY, 0);
  if (refit) { orbit.radius = diag * fitScale; refit = false; }
}

/** Dispose all geometries under an object and detach it from the world. */
export function disposeGroup(g) {
  if (!g) return;
  g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  world.remove(g);
}

/**
 * Build the display group for one tray: a mesh plus soft edge lines per part.
 * Each mesh carries the tray in userData for picking.
 * @param {Array<{name: string, geom: THREE.BufferGeometry}>} parts
 * @param {object} tray
 * @returns {THREE.Group} already added to the world
 */
export function buildTrayGroup(parts, tray) {
  const group = new THREE.Group();
  parts.forEach((part) => {
    const mesh = new THREE.Mesh(part.geom, binMat);
    mesh.userData.tray = tray;
    group.add(mesh);
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(part.geom, 28), edgeMat));
  });
  world.add(group);
  return group;
}

/** Swap a tray group's edge lines between the selected and idle materials. */
export function setTrayHighlight(group, selected) {
  group.traverse((o) => { if (o.isLineSegments) o.material = selected ? selEdgeMat : edgeMat; });
}

/**
 * Red wireframe cage for a tray with a layout problem.
 * @returns {THREE.LineSegments} already added to the world; caller positions it
 */
export function makeWarnBox(w, d, h) {
  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 2, d + 2, h + 2)), errMat);
  world.add(box);
  return box;
}

/** Set the bin material color from a CSS color string. */
export function setBinColor(v) { binMat.color.set(v); }

/**
 * Show, replace, or clear the drawer wireframe: outer outline, dashed usable
 * envelope, corner posts, and a faint floor plane.
 * @param {{w: number, d: number, uw: number, ud: number}|null} dims outer and
 *   usable drawer dimensions, or null to remove the visuals
 */
export function setDrawerVisuals(dims) {
  disposeGroup(drawerVis); drawerVis = null;
  if (!dims) return;
  drawerVis = new THREE.Group();
  const rect = (w, d, mat, dashed) => {
    const pts = [new THREE.Vector3(-w / 2, -d / 2, 0), new THREE.Vector3(w / 2, -d / 2, 0),
                 new THREE.Vector3(w / 2, d / 2, 0), new THREE.Vector3(-w / 2, d / 2, 0), new THREE.Vector3(-w / 2, -d / 2, 0)];
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(g, mat);
    if (dashed) line.computeLineDistances();
    return line;
  };
  drawerVis.add(rect(dims.w, dims.d, drawerLineMat, false));
  drawerVis.add(rect(dims.uw, dims.ud, usableMat, true));
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach((s) => {
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(s[0] * dims.w / 2, s[1] * dims.d / 2, 0),
      new THREE.Vector3(s[0] * dims.w / 2, s[1] * dims.d / 2, 40)]);
    drawerVis.add(new THREE.Line(g, drawerLineMat));
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(dims.w, dims.d), floorMat);
  plane.position.z = -0.05;
  drawerVis.add(plane);
  world.add(drawerVis);
}

let hoverGroup = null;
const ensureHover = () => {
  if (hoverGroup) return;
  hoverGroup = new THREE.Group();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }));
  const pts = [new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0),
               new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0), new THREE.Vector3(-0.5, -0.5, 0)];
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
  hoverGroup.add(m); hoverGroup.add(line);
  hoverGroup.visible = false;
  world.add(hoverGroup);
};

/**
 * Highlight an empty drawer rect (white plane + outline) under the cursor.
 * @param {{x: number, y: number, w: number, d: number}} r
 * @param {{w: number, d: number}} env usable envelope
 */
export function showHover(r, env) {
  ensureHover();
  hoverGroup.visible = true;
  hoverGroup.position.set(-env.w / 2 + r.x + r.w / 2, -env.d / 2 + r.y + r.d / 2, 0.15);
  hoverGroup.scale.set(r.w, r.d, 1);
}

/** Hide the empty-space hover highlight. */
export function hideHover() { if (hoverGroup) hoverGroup.visible = false; }

let cellHoverGroup = null;
const ensureCellHover = () => {
  if (cellHoverGroup) return;
  cellHoverGroup = new THREE.Group();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
  const pts = [new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0),
               new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0), new THREE.Vector3(-0.5, -0.5, 0)];
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.5 }));
  cellHoverGroup.add(m); cellHoverGroup.add(line);
  cellHoverGroup.visible = false;
  world.add(cellHoverGroup);
};

/**
 * Highlight one compartment of a tray (pale gold plane just above its floor).
 * @param {object} tray tray whose group carries the world offset
 * @param {{cx: number, cy: number, w: number, d: number}} cell from meta.cells
 */
export function showCellHover(tray, cell) {
  ensureCellHover();
  const g = tray.group.position;
  cellHoverGroup.visible = true;
  cellHoverGroup.position.set(g.x + cell.cx, g.y + cell.cy, tray.p.floor + 0.1);
  cellHoverGroup.scale.set(cell.w, cell.d, 1);
}

/** Hide the compartment hover highlight. */
export function hideCellHover() { if (cellHoverGroup) cellHoverGroup.visible = false; }

/** Match the renderer and camera to the stage size. */
export function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(stage);

function animate() {
  requestAnimationFrame(animate);
  if (orbit.spin) orbit.theta += 0.0018;
  // hide the grid when the camera dips below the horizon
  if (grid) grid.visible = orbit.phi <= Math.PI / 2 + 0.03;
  camera.position.set(
    target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
    target.y + orbit.radius * Math.cos(orbit.phi),
    target.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta)
  );
  camera.lookAt(target);
  renderer.render(scene, camera);
}

/** Start the render loop. */
export function startAnimation() { animate(); }
