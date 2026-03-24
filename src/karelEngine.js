const DIRECTIONS = ["N", "E", "S", "W"];
const CAMERA_ZOOM_MIN = 0.2;
const CAMERA_ZOOM_MAX = 3;
let cameraZoom = 1;
/** One smooth move or turn: 0.5 s (run queue waits until this finishes — no extra timer pause). */
export const KAREL_ANIM_MS = 500;
/** paintCorner: opacity 0 → 1 over this duration (same easing as move). */
const PAINT_FADE_MS = KAREL_ANIM_MS;

/** @type {Map<string, { startMs: number }>} */
const cornerPaintFade = new Map();

function clearCornerPaintFade() {
  cornerPaintFade.clear();
}

export function isCornerPaintFadeAnimating() {
  const now = performance.now();
  for (const [, fade] of cornerPaintFade) {
    if ((now - fade.startMs) / PAINT_FADE_MS < 1) return true;
  }
  return false;
}
const MOVE_ANIM_MS = KAREL_ANIM_MS;
const ROTATE_ANIM_MS = KAREL_ANIM_MS;
const LIGHTING_PRESET = "qtBright"; // "qtBright" | "current"
const WALL_EDGE_BREAKS = 1000;

const renderAnim = {
  initialized: false,
  x: 0,
  y: 0,
  yaw: 0,
  fromX: 0,
  fromY: 0,
  toX: 0,
  toY: 0,
  moveStartMs: 0,
  moving: false,
  fromYaw: 0,
  toYaw: 0,
  rotStartMs: 0,
  rotating: false,
  lastDir: "E",
};

/** Скинути внутрішній стан анімації (після заміни рушія / світу). */
export function resetRenderAnimation() {
  renderAnim.initialized = false;
  renderAnim.moving = false;
  renderAnim.rotating = false;
}

function clampCameraZoom(value) {
  return Math.max(CAMERA_ZOOM_MIN, Math.min(CAMERA_ZOOM_MAX, value));
}

export function setCameraZoom(value) {
  cameraZoom = clampCameraZoom(value);
  return cameraZoom;
}

export function adjustCameraZoom(delta) {
  cameraZoom = clampCameraZoom(cameraZoom + delta);
  return cameraZoom;
}

export function getCameraZoom() {
  return cameraZoom;
}

function dirToYaw(dir) {
  const yawByDir = {
    N: Math.PI,
    E: Math.PI / 2,
    S: 0,
    W: -Math.PI / 2,
  };
  return yawByDir[dir];
}

function easeInOut(t) {
  return t * t * (3 - 2 * t);
}

function shortestAngleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function getRenderPose(state, nowMs) {
  if (!renderAnim.initialized) {
    const yaw = dirToYaw(state.dir);
    renderAnim.initialized = true;
    renderAnim.x = state.x;
    renderAnim.y = state.y;
    renderAnim.yaw = yaw;
    renderAnim.fromX = state.x;
    renderAnim.fromY = state.y;
    renderAnim.toX = state.x;
    renderAnim.toY = state.y;
    renderAnim.fromYaw = yaw;
    renderAnim.toYaw = yaw;
    renderAnim.lastDir = state.dir;
  }

  if (state.x !== renderAnim.toX || state.y !== renderAnim.toY) {
    renderAnim.fromX = renderAnim.x;
    renderAnim.fromY = renderAnim.y;
    renderAnim.toX = state.x;
    renderAnim.toY = state.y;
    renderAnim.moveStartMs = nowMs;
    renderAnim.moving = true;
  }

  if (state.dir !== renderAnim.lastDir) {
    const targetYaw = dirToYaw(state.dir);
    renderAnim.fromYaw = renderAnim.yaw;
    renderAnim.toYaw = renderAnim.fromYaw + shortestAngleDelta(renderAnim.fromYaw, targetYaw);
    renderAnim.rotStartMs = nowMs;
    renderAnim.rotating = true;
    renderAnim.lastDir = state.dir;
  }

  if (renderAnim.moving) {
    if (MOVE_ANIM_MS <= 0) {
      renderAnim.x = renderAnim.toX;
      renderAnim.y = renderAnim.toY;
      renderAnim.moving = false;
    } else {
      const t = Math.min(1, (nowMs - renderAnim.moveStartMs) / MOVE_ANIM_MS);
      // Linear: constant speed over the step (no ease-out “stop” at the end).
      renderAnim.x = renderAnim.fromX + (renderAnim.toX - renderAnim.fromX) * t;
      renderAnim.y = renderAnim.fromY + (renderAnim.toY - renderAnim.fromY) * t;
      if (t >= 1) renderAnim.moving = false;
    }
  } else {
    renderAnim.x = renderAnim.toX;
    renderAnim.y = renderAnim.toY;
  }

  if (renderAnim.rotating) {
    if (ROTATE_ANIM_MS <= 0) {
      renderAnim.yaw = renderAnim.toYaw;
      renderAnim.rotating = false;
    } else {
      const t = Math.min(1, (nowMs - renderAnim.rotStartMs) / ROTATE_ANIM_MS);
      renderAnim.yaw = renderAnim.fromYaw + (renderAnim.toYaw - renderAnim.fromYaw) * t;
      if (t >= 1) renderAnim.rotating = false;
    }
  } else {
    renderAnim.yaw = renderAnim.toYaw;
  }

  return { x: renderAnim.x, y: renderAnim.y, yaw: renderAnim.yaw };
}

/** True while pose is catching up to engine state (move/turn animation or pending first frame). */
export function isKarelPoseAnimating(state) {
  if (renderAnim.moving || renderAnim.rotating) return true;
  if (state.x !== renderAnim.toX || state.y !== renderAnim.toY) return true;
  if (state.dir !== renderAnim.lastDir) return true;
  return false;
}

function paintColorToRgb(name) {
  const colorMap = {
    red: [220, 80, 80],
    green: [80, 180, 100],
    blue: [80, 120, 220],
    yellow: [230, 210, 80],
    orange: [230, 140, 60],
    cyan: [80, 200, 220],
    magenta: [200, 80, 200],
    white: [240, 240, 240],
    black: [40, 40, 40],
    gray: [140, 140, 140],
    grey: [140, 140, 140],
  };
  return colorMap[name.toLowerCase()] ?? [180, 180, 200];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

function edgeNoise(index, edgeTag) {
  // Deterministic pseudo-random [0..1] per edge/index (stable every frame).
  const x = Math.sin(index * 12.9898 + edgeTag * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** One key per grid edge: "n,x,y" (north face of cell x,y) or "e,x,y" (east face). */
function normalizeWallSet(walls) {
  if (!walls) return new Set();
  if (walls instanceof Set) return new Set(walls);
  return new Set(walls);
}

/**
 * Demo map: internal walls with gaps (vertical column + horizontal row).
 * - East edges e,3,y for y in 0,1,2,4,5,6 — gap at row 3 (passage between columns 3 and 4).
 * - North edges n,x,4 for x != 5 — gap at column 5 (passage between rows 4 and 5).
 * Plus a short corner like the Python demo (north + east of cell 6,6).
 */
export function createDemoWorldConfig() {
  const width = 8;
  const height = 8;
  const walls = [];
  for (const y of [0, 1, 2, 4, 5, 6]) {
    walls.push(`e,3,${y}`);
  }
  for (let x = 0; x < width; x += 1) {
    if (x !== 5) walls.push(`n,${x},4`);
  }
  walls.push("n,6,6", "e,6,6");
  return {
    width,
    height,
    startX: 0,
    startY: 0,
    startDir: "E",
    beepers: ["4,2", "6,5"],
    walls,
  };
}

const INTERNAL_EDGE_PALETTE = [
  [124, 188, 244], // blue
  [246, 214, 92], // yellow
  [236, 124, 176], // pink
  [118, 204, 132], // green
  [168, 120, 232], // violet
];

/** RGB from same formulas as perimeter north/south bricks. */
function brickColorNorthSouth(ix, row, wallPalette, salt = 0) {
  const patchNoise = edgeNoise(Math.floor(ix / 3) + row * 17 + salt * 0.37, 41 + salt * 0.11);
  const patchIdx = Math.floor(patchNoise * wallPalette.length) % wallPalette.length;
  const [br, bg, bb] = wallPalette[patchIdx];
  const shade = edgeNoise(ix + row * 37 + salt * 0.53, 43 + salt * 0.17) * 22 - 11;
  return [
    Math.max(0, Math.min(255, br + shade)),
    Math.max(0, Math.min(255, bg + shade)),
    Math.max(0, Math.min(255, bb + shade)),
  ];
}

/** RGB from same formulas as perimeter west/east bricks. */
function brickColorWestEast(iz, row, wallPalette, salt = 0) {
  const patchNoise = edgeNoise(Math.floor(iz / 3) + row * 19 + salt * 0.41, 42 + salt * 0.13);
  const patchIdx = Math.floor(patchNoise * wallPalette.length) % wallPalette.length;
  const [br, bg, bb] = wallPalette[patchIdx];
  const shade = edgeNoise(iz + row * 41 + salt * 0.47, 44 + salt * 0.19) * 22 - 11;
  return [
    Math.max(0, Math.min(255, br + shade)),
    Math.max(0, Math.min(255, bg + shade)),
    Math.max(0, Math.min(255, bb + shade)),
  ];
}

/** Same salt scalars as perimeter masonry (internal walls must use these with global ix/iz). */
function brickSaltNorthPerimeter(ix, row) {
  return ix * 29 + row * 7 + 101;
}
function brickSaltSouthPerimeter(ix, row) {
  return ix * 31 + row * 11 + 131;
}
function brickSaltWestPerimeter(iz, row) {
  return iz * 37 + row * 13 + 151;
}
function brickSaltEastPerimeter(iz, row) {
  return iz * 41 + row * 17 + 181;
}

/** Darker stroke so each brick reads as a separate block (WEBGL box edges). */
function brickStrokeFromFaceColor(p, r, g, b) {
  p.stroke(
    Math.max(8, Math.min(255, Math.floor(r * 0.42 + 5))),
    Math.max(8, Math.min(255, Math.floor(g * 0.42 + 5))),
    Math.max(8, Math.min(255, Math.floor(b * 0.46 + 8)))
  );
  p.strokeWeight(0.28);
}

/** Lit perimeter bricks read darker than unlit fill(); nudge toward internal vividness. */
function boostLitBrickRgb(r, g, b, factor = 1.12) {
  return [
    Math.min(255, Math.round(r * factor)),
    Math.min(255, Math.round(g * factor)),
    Math.min(255, Math.round(b * factor)),
  ];
}

function ambientBrickNorthSouth(p, ix, row, wallPalette, salt = 0) {
  const [r0, g0, b0] = brickColorNorthSouth(ix, row, wallPalette, salt);
  const [r, g, b] = boostLitBrickRgb(r0, g0, b0);
  p.ambientMaterial(r, g, b);
  brickStrokeFromFaceColor(p, r, g, b);
}

function ambientBrickWestEast(p, iz, row, wallPalette, salt = 0) {
  const [r0, g0, b0] = brickColorWestEast(iz, row, wallPalette, salt);
  const [r, g, b] = boostLitBrickRgb(r0, g0, b0);
  p.ambientMaterial(r, g, b);
  brickStrokeFromFaceColor(p, r, g, b);
}

/** Same brick run as perimeter north/south faces; only segment bounds and z differ. */
function drawBrickStripAlongX(
  p,
  originX,
  segmentLeft,
  segmentRight,
  zCenter,
  floorY,
  wallH,
  wallThickness,
  wallPalette,
  brickRows,
  brickH,
  brickLenNS,
  saltFn
) {
  for (let row = 0; row < brickRows; row += 1) {
    const y = floorY - wallH + brickH * (row + 0.5);
    const offset = (row % 2) * (brickLenNS * 0.5);
    for (let bx = segmentLeft; bx < segmentRight; bx += brickLenNS) {
      const cxRaw = bx + offset;
      const halfW = (brickLenNS * 0.96) / 2;
      const left = Math.max(segmentLeft, cxRaw - halfW);
      const right = Math.min(segmentRight, cxRaw + halfW);
      const actualW = right - left;
      if (actualW <= 0.001) continue;
      const cx = (left + right) * 0.5;
      const ix = Math.floor((bx - originX) / brickLenNS);
      ambientBrickNorthSouth(p, ix, row, wallPalette, saltFn(ix, row));
      p.push();
      p.translate(cx, y, zCenter);
      p.box(actualW, brickH * 0.9, wallThickness);
      p.pop();
    }
  }
}

/** Same brick run as perimeter west/east faces; only segment bounds and x differ. */
function drawBrickStripAlongZ(
  p,
  originZ,
  segmentNear,
  segmentFar,
  xCenter,
  floorY,
  wallH,
  wallThickness,
  wallPalette,
  brickRows,
  brickH,
  brickLenEW,
  saltFn
) {
  for (let row = 0; row < brickRows; row += 1) {
    const y = floorY - wallH + brickH * (row + 0.5);
    const offset = (row % 2) * (brickLenEW * 0.5);
    for (let bz = segmentNear; bz < segmentFar; bz += brickLenEW) {
      const czRaw = bz + offset;
      const halfW = (brickLenEW * 0.96) / 2;
      const near = Math.max(segmentNear, czRaw - halfW);
      const far = Math.min(segmentFar, czRaw + halfW);
      const actualW = far - near;
      if (actualW <= 0.001) continue;
      const cz = (near + far) * 0.5;
      const iz = Math.floor((bz - originZ) / brickLenEW);
      ambientBrickWestEast(p, iz, row, wallPalette, saltFn(iz, row));
      p.push();
      p.translate(xCenter, y, cz);
      p.box(wallThickness, brickH * 0.9, actualW);
      p.pop();
    }
  }
}

function applySceneLights(p, worldSpan) {
  if (LIGHTING_PRESET === "qtBright") {
    p.ambientLight(62, 62, 68);
    p.directionalLight(226, 222, 214, -0.14, -1, -0.1);
    p.directionalLight(154, 164, 188, 0.6, -0.25, 0.34);
    p.pointLight(184, 184, 192, 0, -worldSpan * 0.82, worldSpan * 0.16);
    p.pointLight(94, 94, 94, 0, -worldSpan * 0.28, worldSpan * 1.05); // front light
  } else {
    p.ambientLight(28, 28, 28);
    p.directionalLight(228, 228, 228, -0.15, -1, -0.08);
    p.directionalLight(82, 82, 82, 0.55, -0.28, 0.36);
    p.pointLight(132, 132, 132, 0, -worldSpan * 0.95, worldSpan * 0.12);
    p.pointLight(86, 86, 86, 0, -worldSpan * 0.3, worldSpan * 1.05); // front light
  }
}

export class KarelEngine {
  constructor(config = {}) {
    this.width = config.width ?? 8;
    this.height = config.height ?? 8;
    this.initialState = {
      x: config.startX ?? 0,
      y: config.startY ?? 0,
      dir: config.startDir ?? "E",
      beepers: new Set(config.beepers ?? []),
      cornerColors: { ...(config.cornerColors ?? {}) },
      bagCount: config.bagCount ?? 0,
      walls: normalizeWallSet(config.walls),
    };
    this.reset();
  }

  reset() {
    clearCornerPaintFade();
    this.state = {
      x: this.initialState.x,
      y: this.initialState.y,
      dir: this.initialState.dir,
      beepers: new Set(this.initialState.beepers),
      cornerColors: { ...this.initialState.cornerColors },
      bagCount: this.initialState.bagCount,
      walls: new Set(this.initialState.walls),
    };
  }

  getState() {
    return this.state;
  }

  serializeCell(x, y) {
    return `${x},${y}`;
  }

  isDirectionBlocked(x, y, dir) {
    const { walls } = this.state;
    if (dir === "N") {
      if (y >= this.height - 1) return true;
      return walls.has(`n,${x},${y}`);
    }
    if (dir === "S") {
      if (y <= 0) return true;
      return walls.has(`n,${x},${y - 1}`);
    }
    if (dir === "E") {
      if (x >= this.width - 1) return true;
      return walls.has(`e,${x},${y}`);
    }
    if (dir === "W") {
      if (x <= 0) return true;
      return walls.has(`e,${x - 1},${y}`);
    }
    return true;
  }

  hasWallAhead() {
    const { x, y, dir } = this.state;
    return this.isDirectionBlocked(x, y, dir);
  }

  frontIsClear() {
    const { x, y, dir } = this.state;
    return !this.isDirectionBlocked(x, y, dir);
  }

  leftIsClear() {
    const dirLeft = { N: "W", W: "S", S: "E", E: "N" };
    const { x, y, dir } = this.state;
    return !this.isDirectionBlocked(x, y, dirLeft[dir]);
  }

  rightIsClear() {
    const dirRight = { N: "E", E: "S", S: "W", W: "N" };
    const { x, y, dir } = this.state;
    return !this.isDirectionBlocked(x, y, dirRight[dir]);
  }

  beepersPresent() {
    return this.state.beepers.has(this.serializeCell(this.state.x, this.state.y));
  }

  move() {
    if (this.hasWallAhead()) {
      throw new Error("Karel crashed into a wall.");
    }

    if (this.state.dir === "N") this.state.y += 1;
    if (this.state.dir === "S") this.state.y -= 1;
    if (this.state.dir === "E") this.state.x += 1;
    if (this.state.dir === "W") this.state.x -= 1;
  }

  turnLeft() {
    const idx = DIRECTIONS.indexOf(this.state.dir);
    this.state.dir = DIRECTIONS[(idx + 3) % 4];
  }

  putBeeper() {
    this.state.beepers.add(this.serializeCell(this.state.x, this.state.y));
  }

  pickBeeper() {
    const key = this.serializeCell(this.state.x, this.state.y);
    if (!this.state.beepers.has(key)) {
      throw new Error("No beeper to pick on this cell.");
    }
    this.state.beepers.delete(key);
  }

  paintCorner(colorName) {
    const key = this.serializeCell(this.state.x, this.state.y);
    this.state.cornerColors[key] = colorName;
    cornerPaintFade.set(key, { startMs: performance.now() });
  }
}

export function drawWorld(p, engine, width = 480, height = 480) {
  const cols = engine.width;
  const rows = engine.height;
  const REFERENCE_SIZE = 480;
  const worldSpan = REFERENCE_SIZE * 0.9;
  const cell = worldSpan / Math.max(cols, rows);
  const state = engine.getState();
  const nowMs = p.millis();
  const pose = getRenderPose(state, nowMs);
  const bob = Math.sin(nowMs * 0.005) * cell * 0.02;
  const wallH = cell * 0.42;
  const floorY = 0;

  const gridW = cols * cell;
  const gridD = rows * cell;
  const originX = -gridW / 2;
  const originZ = -gridD / 2;

  if (LIGHTING_PRESET === "qtBright") {
    p.background(22, 26, 34);
  } else {
    p.background(24, 24, 26);
  }
  applySceneLights(p, worldSpan);

  // Camera similar to qt 3D: from south/front, looking north into scene.
  p.camera(0, -worldSpan * 0.32, worldSpan * 1.78 * cameraZoom, 0, 0, 0, 0, 1, 0);

  p.push();
  p.rotateX(-0.6);
  p.rotateY(-0.08);

  // Floor tiles.
  p.noLights();
  for (let x = 0; x < cols; x += 1) {
    for (let y = 0; y < rows; y += 1) {
      const px = originX + x * cell + cell / 2;
      const pz = originZ + (rows - 1 - y) * cell + cell / 2;
      const checker = (x + y) % 2;
      p.push();
      p.translate(px, floorY + cell * 0.025, pz);
      p.noStroke();
      if (checker) p.fill(6, 14, 28);
      else p.fill(2, 4, 14);
      p.box(cell * 0.98, cell * 0.05, cell * 0.98);
      const cellKey = `${x},${y}`;
      const paintColor = state.cornerColors[cellKey];
      if (paintColor) {
        const [r, g, b] = paintColorToRgb(paintColor);
        p.push();
        p.translate(0, -cell * 0.03, 0);
        p.noStroke();
        let a = 255;
        const fade = cornerPaintFade.get(cellKey);
        if (fade) {
          const t = Math.min(1, (performance.now() - fade.startMs) / PAINT_FADE_MS);
          a = easeInOut(t) * 255;
          if (t >= 1) cornerPaintFade.delete(cellKey);
        }
        p.fill(r, g, b, a);
        p.cylinder(cell * 0.4, cell * 0.03, 22, 1);
        p.pop();
      }
      p.pop();
    }
  }
  applySceneLights(p, worldSpan);

  // Grid lines.
  p.stroke(118, 118, 118);
  p.strokeWeight(1);
  for (let x = 0; x <= cols; x += 1) {
    const gx = originX + x * cell;
    p.line(gx, floorY + 1, originZ, gx, floorY + 1, originZ + gridD);
  }
  for (let y = 0; y <= rows; y += 1) {
    const gz = originZ + y * cell;
    p.line(originX, floorY + 1, gz, originX + gridW, floorY + 1, gz);
  }

  const wallThickness = cell * 0.08;

  // Sawtooth border with random-looking tooth size/depth.
  p.noStroke();
  p.ambientMaterial(236, 124, 176);

  // Base border as brick masonry.
  const brickRows = 6;
  const brickH = wallH / brickRows;
  const brickLenNS = cell * 0.6;
  const brickLenEW = cell * 0.6;
  // Same saturated palette as internal walls (brighter than old 3-tone perimeter).
  const outerWallPalette = INTERNAL_EDGE_PALETTE;

  // North + south perimeter (same strip primitive as internal edges).
  drawBrickStripAlongX(
    p,
    originX,
    originX,
    originX + gridW,
    originZ - wallThickness / 2,
    floorY,
    wallH,
    wallThickness,
    outerWallPalette,
    brickRows,
    brickH,
    brickLenNS,
    brickSaltNorthPerimeter
  );
  drawBrickStripAlongX(
    p,
    originX,
    originX,
    originX + gridW,
    originZ + gridD + wallThickness / 2,
    floorY,
    wallH,
    wallThickness,
    outerWallPalette,
    brickRows,
    brickH,
    brickLenNS,
    brickSaltSouthPerimeter
  );

  // West + east perimeter.
  drawBrickStripAlongZ(
    p,
    originZ,
    originZ,
    originZ + gridD,
    originX - wallThickness / 2,
    floorY,
    wallH,
    wallThickness,
    outerWallPalette,
    brickRows,
    brickH,
    brickLenEW,
    brickSaltWestPerimeter
  );
  drawBrickStripAlongZ(
    p,
    originZ,
    originZ,
    originZ + gridD,
    originX + gridW + wallThickness / 2,
    floorY,
    wallH,
    wallThickness,
    outerWallPalette,
    brickRows,
    brickH,
    brickLenEW,
    brickSaltEastPerimeter
  );

  p.noStroke();

  // Jagged top edge (polyline-like broken silhouette): ~1000 breaks per wall.
  // We draw many thin cap segments with varying heights.
  const topY = floorY - wallH;
  const northSouthSegW = gridW / WALL_EDGE_BREAKS;
  const eastWestSegW = gridD / WALL_EDGE_BREAKS;
  const capDepth = wallThickness;
  const minCapH = wallH * 0.02;
  const minRange = Math.min(10, wallH * 0.35);
  const maxRange = wallH;
  const northRange = minRange + edgeNoise(0, 31) * (maxRange - minRange);
  const southRange = minRange + edgeNoise(0, 32) * (maxRange - minRange);
  const westRange = minRange + edgeNoise(0, 33) * (maxRange - minRange);
  const eastRange = minRange + edgeNoise(0, 34) * (maxRange - minRange);

  // North wall crest.
  for (let i = 0; i < WALL_EDGE_BREAKS; i += 1) {
    const capH = minCapH + edgeNoise(i, 11) * northRange;
    const x = originX + northSouthSegW * (i + 0.5);
    p.push();
    p.translate(x, topY - capH / 2, originZ - capDepth / 2);
    p.box(northSouthSegW * 1.02, capH, capDepth);
    p.pop();
  }

  // South wall crest.
  for (let i = 0; i < WALL_EDGE_BREAKS; i += 1) {
    const capH = minCapH + edgeNoise(i, 12) * southRange;
    const x = originX + northSouthSegW * (i + 0.5);
    p.push();
    p.translate(x, topY - capH / 2, originZ + gridD + capDepth / 2);
    p.box(northSouthSegW * 1.02, capH, capDepth);
    p.pop();
  }

  // West wall crest.
  for (let i = 0; i < WALL_EDGE_BREAKS; i += 1) {
    const capH = minCapH + edgeNoise(i, 13) * westRange;
    const z = originZ + eastWestSegW * (i + 0.5);
    p.push();
    p.translate(originX - capDepth / 2, topY - capH / 2, z);
    p.box(capDepth, capH, eastWestSegW * 1.02);
    p.pop();
  }

  // East wall crest.
  for (let i = 0; i < WALL_EDGE_BREAKS; i += 1) {
    const capH = minCapH + edgeNoise(i, 14) * eastRange;
    const z = originZ + eastWestSegW * (i + 0.5);
    p.push();
    p.translate(originX + gridW + capDepth / 2, topY - capH / 2, z);
    p.box(capDepth, capH, eastWestSegW * 1.02);
    p.pop();
  }

  // Internal edges: same strip draws, shorter segments (after crest for stable GL state).
  for (const key of state.walls) {
    const [kind, xs, ys] = key.split(",");
    const wx = Number(xs);
    const wy = Number(ys);
    if (kind === "n") {
      if (wx < 0 || wx >= cols || wy < 0 || wy >= rows - 1) continue;
      const zCenter = originZ + (rows - 1 - wy) * cell;
      drawBrickStripAlongX(
        p,
        originX,
        originX + wx * cell,
        originX + (wx + 1) * cell,
        zCenter,
        floorY,
        wallH,
        wallThickness,
        outerWallPalette,
        brickRows,
        brickH,
        brickLenNS,
        brickSaltNorthPerimeter
      );
    } else if (kind === "e") {
      if (wx < 0 || wx >= cols - 1 || wy < 0 || wy >= rows) continue;
      const segmentNear = originZ + (rows - 1 - wy) * cell;
      const segmentFar = originZ + (rows - wy) * cell;
      const xCenter = originX + (wx + 1) * cell;
      drawBrickStripAlongZ(
        p,
        originZ,
        segmentNear,
        segmentFar,
        xCenter,
        floorY,
        wallH,
        wallThickness,
        outerWallPalette,
        brickRows,
        brickH,
        brickLenEW,
        brickSaltEastPerimeter
      );
    }
  }

  const kx = originX + pose.x * cell + cell * 0.5;
  const kz = originZ + (rows - 1 - pose.y) * cell + cell * 0.5;

  // Soft contact shadows.
  p.noLights();
  p.noStroke();
  for (const key of state.beepers) {
    const [bx, by] = key.split(",").map(Number);
    const cx = originX + bx * cell + cell * 0.5;
    const cz = originZ + (rows - 1 - by) * cell + cell * 0.5;
    p.push();
    p.translate(cx, floorY + 0.8, cz);
    p.rotateX(Math.PI / 2);
    p.fill(0, 0, 0, 70);
    p.ellipse(0, 0, cell * 0.28, cell * 0.22);
    p.pop();
  }
  p.push();
  p.translate(kx, floorY + 0.9, kz);
  p.rotateX(Math.PI / 2);
  p.fill(0, 0, 0, 86);
  p.ellipse(0, 0, cell * 0.72, cell * 0.56);
  p.pop();
  applySceneLights(p, worldSpan);

  for (const key of state.beepers) {
    const [bx, by] = key.split(",").map(Number);
    const cx = originX + bx * cell + cell * 0.5;
    const cz = originZ + (rows - 1 - by) * cell + cell * 0.5;
    p.push();
    p.translate(cx, floorY - cell * 0.18, cz);
    p.noStroke();
    p.ambientMaterial(230, 120, 34);
    p.sphere(cell * 0.16, 14, 10);
    p.push();
    p.translate(0, cell * 0.03, 0);
    p.ambientMaterial(202, 98, 26);
    p.torus(cell * 0.11, cell * 0.018, 10, 8);
    p.pop();
    p.pop();
  }

  drawKarel(p, kx, floorY - cell * 0.2 + bob, kz, pose.yaw, cell * 0.35);

  p.pop();
}

function drawKarel(p, x, y, z, yaw, radius) {
  p.push();
  p.translate(x, y, z);
  p.rotateY(yaw);
  p.noStroke();

  // Upper cap.
  p.push();
  p.translate(0, -radius * 1.52, 0);
  p.scale(0.9, 0.42, 0.9);
  // Darker lit materials: keep volume, avoid gray look.
  p.ambientMaterial(2, 2, 2);
  p.sphere(radius * 0.82, 16, 10);
  p.push();
  p.translate(0, -radius * 0.03, radius * 0.05);
  p.ambientMaterial(10, 10, 12);
  p.sphere(radius * 0.58, 14, 10);
  p.pop();
  p.push();
  p.translate(-radius * 0.09, -radius * 0.11, radius * 0.09);
  p.ambientMaterial(24, 30, 44);
  p.sphere(radius * 0.14, 8, 6);
  p.pop();
  p.pop();

  // Two front-top eyes with subtle volume.
  p.push();
  p.translate(-radius * 0.24, -radius * 1.42, radius * 0.8);
  p.ambientMaterial(138, 12, 56);
  p.sphere(radius * 0.18, 12, 10);
  p.push();
  p.translate(0, 0, radius * 0.042);
  p.ambientMaterial(90, 8, 38);
  p.sphere(radius * 0.068, 8, 6);
  p.pop();
  p.push();
  p.translate(-radius * 0.018, -radius * 0.018, radius * 0.074);
  p.ambientMaterial(196, 78, 124);
  p.sphere(radius * 0.026, 7, 5);
  p.pop();
  p.pop();

  p.push();
  p.translate(radius * 0.24, -radius * 1.42, radius * 0.8);
  p.ambientMaterial(138, 12, 56);
  p.sphere(radius * 0.18, 12, 10);
  p.push();
  p.translate(0, 0, radius * 0.042);
  p.ambientMaterial(90, 8, 38);
  p.sphere(radius * 0.068, 8, 6);
  p.pop();
  p.push();
  p.translate(-radius * 0.018, -radius * 0.018, radius * 0.074);
  p.ambientMaterial(196, 78, 124);
  p.sphere(radius * 0.026, 7, 5);
  p.pop();
  p.pop();

  // Aerosol cloud under Karel.
  p.push();
  p.translate(0, -radius * 0.18, 0);
  const gl = p._renderer.GL;
  gl.enable(gl.BLEND);
  // Additive blending keeps fog visually white on dark background.
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false);
  p.noLights();
  p.noStroke();

  const t = p.millis() * 0.0019;
  const pulse = (Math.sin(t * 2.2) + 1) * 0.5;
  const baseAlpha = 70 + pulse * 55;
  const baseHue = (p.millis() * 0.045) % 360;
  const [dr, dg, db] = hslToRgb(baseHue, 0.85, 0.62);

  // Ground fog disk.
  p.push();
  p.rotateX(Math.PI / 2);
  p.fill(dr, dg, db, baseAlpha * 0.85);
  p.ellipse(0, 0, radius * 2.4, radius * 2.1);
  p.pop();

  // Soft drifting puffs.
  const puffs = 8;
  for (let i = 0; i < puffs; i += 1) {
    const hue = (baseHue + i * (360 / puffs)) % 360;
    const [pr, pg, pb] = hslToRgb(hue, 0.88, 0.64);
    const a = (i / puffs) * Math.PI * 2 + t * 0.45;
    const ring = radius * (0.38 + 0.07 * Math.sin(t * 1.3 + i));
    const px = Math.cos(a) * ring;
    const pz = Math.sin(a) * ring;
    const py = -radius * (0.05 + 0.05 * Math.sin(t * 2 + i * 0.8));
    const puffR = radius * (0.17 + 0.03 * Math.sin(t * 2.4 + i));
    p.push();
    p.translate(px, py, pz);
    p.fill(pr, pg, pb, baseAlpha + 18 * Math.sin(t * 2 + i));
    p.sphere(puffR, 10, 8);
    p.pop();
  }

  gl.depthMask(true);
  gl.disable(gl.BLEND);
  p.pop();

  p.pop();
}
