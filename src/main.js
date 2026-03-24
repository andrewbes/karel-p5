import {
  KarelEngine,
  drawWorld,
  setCameraZoom,
  createDemoWorldConfig,
  isKarelPoseAnimating,
  isCornerPaintFadeAnimating,
  resetRenderAnimation,
} from "./karelEngine.js";
import { parseWorldJson } from "./worldLoader.js";
import {
  parseProgram,
  runCommand,
  statementToQueueItem,
  CONDITION_EVALUATORS,
  expandForToQueueItems,
} from "./interpreter.js";

const statusLine = document.getElementById("statusLine");
const zoomValue = document.getElementById("zoomValue");
const runBtn = document.getElementById("runBtn");
const stepBtn = document.getElementById("stepBtn");
const resetBtn = document.getElementById("resetBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const rulesBtn = document.getElementById("rulesBtn");
const rulesDialog = document.getElementById("rulesDialog");
const rulesCloseBtn = document.getElementById("rulesCloseBtn");
const canvasContainer = document.getElementById("canvasContainer");
const worldSelect = document.getElementById("worldSelect");
const loadWorldFileBtn = document.getElementById("loadWorldFileBtn");
const worldFileInput = document.getElementById("worldFileInput");
const worldCollapseBtn = document.getElementById("worldCollapseBtn");
const worldPanel = document.querySelector(".world-panel");

/** @type {KarelEngine} */
let engine;

let queue = [];
/** Bodies from last successful parseProgram (Statement[] per name). */
let userFunctions = Object.create(null);
/** Lexical scopes for nested functions: innermost map last. */
let scopeStack = [];
/** Pending run schedule (rAF or timeout); cleared on reset. */
let runLoopRafId = null;
let runLoopTimeoutId = null;

function cancelRunSchedule() {
  if (runLoopRafId !== null) {
    cancelAnimationFrame(runLoopRafId);
    runLoopRafId = null;
  }
  if (runLoopTimeoutId !== null) {
    clearTimeout(runLoopTimeoutId);
    runLoopTimeoutId = null;
  }
}

function resetExecutionQueue() {
  queue = [];
  scopeStack = [];
  cancelRunSchedule();
}

function applyWorldConfig(config, statusMsg) {
  engine = new KarelEngine(config);
  resetRenderAnimation();
  resetExecutionQueue();
  if (statusMsg !== undefined && statusMsg !== null) {
    setStatus(statusMsg);
  }
}

applyWorldConfig(createDemoWorldConfig(), "Готово.");

const editor = CodeMirror.fromTextArea(document.getElementById("codeInput"), {
  mode: "javascript",
  lineNumbers: true,
  theme: "default",
  tabSize: 2,
});

function refreshEditorSize() {
  const panel = document.querySelector(".editor-panel");
  if (!panel) return;
  const h2 = panel.querySelector("h2");
  const extra = (h2?.offsetHeight ?? 0) + 20;
  const h = Math.max(120, Math.floor(panel.clientHeight - extra));
  editor.setSize(null, h);
  editor.refresh();
}

editor.setValue(`// Місія на demo.json: двоє «дверей», два біпери на полі, біпер у кут (7,7), повернення на базу (0,0).
// bagCount у карті = 8: після збору/кладки на зворотному шляху на кожному повороті — putBeeper(), якщо ще є біпери в корзині.
// Після кожного turnLeft/turnRight — paintCorner на тій самій клітинці (як раніше).
function turnRight() {
  turnLeft();
  turnLeft();
  turnLeft();
}

// --- (0,0) схід → вертикальні двері на рядку 3 → (4,2), перший біпер ---
turnLeft();
paintCorner("Red");
for (let i = 0; i < 3; i++) {
  move();
}
turnRight();
paintCorner("Orange");
for (let i = 0; i < 3; i++) {
  move();
}
move();
turnRight();
paintCorner("Yellow");
move();
if (beepersPresent()) {
  pickBeeper();
}

// --- (4,2) → (6,5) через горизонтальні двері (5,4)→(5,5) ---
turnLeft();
paintCorner("White");
for (let i = 0; i < 2; i++) {
  move();
}
turnLeft();
paintCorner("Red");
for (let i = 0; i < 2; i++) {
  move();
}
turnLeft();
paintCorner("Orange");
move();
turnRight();
paintCorner("Green");
move();
turnRight();
paintCorner("Cyan");
move();
if (beepersPresent()) {
  pickBeeper();
}

// --- кут поля (7,7): з (6,5) на схід, потім на північ (обхід стіни n,6,6 біля (6,6)) ---
move();
turnLeft();
paintCorner("Red");
for (let i = 0; i < 2; i++) {
  move();
}
putBeeper();

// --- повернення на базу (0,0), схід; після кожного повороту — біпер з корзини, якщо ще є ---
// (while там, де рух іде до стіни; дві короткі ділянки — парою move().)
turnLeft();
if (beepersInBag()) {
  putBeeper();
}
paintCorner("Orange");
turnLeft();
if (beepersInBag()) {
  putBeeper();
}
paintCorner("Yellow");
while (frontIsClear()) {
  move();
}
turnRight();
if (beepersInBag()) {
  putBeeper();
}
paintCorner("Blue");
move();
move();
turnLeft();
if (beepersInBag()) {
  putBeeper();
}
paintCorner("Magenta");
move();
move();
turnRight();
if (beepersInBag()) {
  putBeeper();
}
paintCorner("Magenta");
move();
move();
turnLeft();
if (beepersInBag()) {
  putBeeper();
}
paintCorner("Yellow");
while (frontIsClear()) {
  move();
}
turnRight();
if (beepersInBag()) {
  putBeeper();
}
paintCorner("White");
while (frontIsClear()) {
  move();
}
turnLeft();
if (beepersInBag()) {
  putBeeper();
}
paintCorner("Magenta");
turnLeft();
if (beepersInBag()) {
  putBeeper();
}
paintCorner("White");
`);

let renderWidth = 480;
let renderHeight = 480;
const MOBILE_LAYOUT_MQ = "(max-width: 980px)";
/** Внутрішній масштаб поля на мобільному; у рядку зуму це показується як 100%. */
const DEFAULT_USER_ZOOM_MOBILE = 1.25;
const DEFAULT_USER_ZOOM_DESKTOP = 1;
let userZoomFactor =
  typeof window !== "undefined" && window.matchMedia(MOBILE_LAYOUT_MQ).matches
    ? DEFAULT_USER_ZOOM_MOBILE
    : DEFAULT_USER_ZOOM_DESKTOP;
const USER_ZOOM_MIN = 0.7;
const USER_ZOOM_MAX = 1.6;
const REFERENCE_VIEWPORT_WIDTH = 480;

function getCanvasDimensions() {
  const width = Math.max(200, Math.floor(canvasContainer.clientWidth));
  const height = Math.max(200, Math.floor(canvasContainer.clientHeight));
  return { width, height };
}

function applyResponsiveZoom() {
  const aspect = renderWidth / Math.max(renderHeight, 1);
  // Calibrate "100%" so world fits width across desktop/mobile aspect ratios.
  const fitCompensation = Math.min(1.5, Math.max(1.2, 0.905 + 0.375 * aspect));
  const autoFitZoom = (REFERENCE_VIEWPORT_WIDTH / renderWidth) * fitCompensation;
  const effectiveCameraZoom = autoFitZoom / userZoomFactor;
  setCameraZoom(effectiveCameraZoom);
  updateZoomValue(userZoomFactor);
}

const sketch = (p) => {
  function resizeToContainer() {
    const dims = getCanvasDimensions();
    renderWidth = dims.width;
    renderHeight = dims.height;
    p.resizeCanvas(renderWidth, renderHeight);
    applyResponsiveZoom();
  }

  p.setup = () => {
    const dims = getCanvasDimensions();
    renderWidth = dims.width;
    renderHeight = dims.height;
    p.setAttributes("antialias", true);
    p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
    p.frameRate(60);
    const canvas = p.createCanvas(renderWidth, renderHeight, p.WEBGL);
    canvas.parent("canvasContainer");
    applyResponsiveZoom();
    resizeToContainer();
  };

  p.draw = () => {
    drawWorld(p, engine, renderWidth, renderHeight);
  };

  p.windowResized = () => {
    resizeToContainer();
  };
};

new p5(sketch);

requestAnimationFrame(() => {
  refreshEditorSize();
});
window.addEventListener("resize", () => {
  refreshEditorSize();
});
if (typeof ResizeObserver !== "undefined") {
  const ep = document.querySelector(".editor-panel");
  if (ep) {
    new ResizeObserver(() => refreshEditorSize()).observe(ep);
  }
}

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle("error", isError);
}

function getZoomDisplayBaseline() {
  if (typeof window === "undefined") return DEFAULT_USER_ZOOM_DESKTOP;
  return window.matchMedia(MOBILE_LAYOUT_MQ).matches ? DEFAULT_USER_ZOOM_MOBILE : DEFAULT_USER_ZOOM_DESKTOP;
}

/** Відсоток відносно дефолту для поточного макету (мобільний дефолт = 100%). */
function updateZoomValue(zoom) {
  const baseline = getZoomDisplayBaseline();
  const pct = Math.round((zoom / baseline) * 100);
  zoomValue.textContent = `${pct}%`;
}

function commandNeedsStepAnimation(cmd) {
  const c = cmd.trim().replace(/;+\s*$/, "");
  return c === "move()" || c === "turnLeft()" || /^paintCorner\(/.test(c);
}

function queueItemNeedsAnimation(item) {
  return typeof item === "string" && commandNeedsStepAnimation(item);
}

function resolveFunctionBody(name) {
  for (let i = scopeStack.length - 1; i >= 0; i -= 1) {
    const frame = scopeStack[i];
    if (frame.has(name)) return frame.get(name);
  }
  return userFunctions[name] ?? null;
}

function runWhileQueueItem(item) {
  const fn = CONDITION_EVALUATORS[item.condition];
  if (!fn) throw new Error(`Unknown while condition: ${item.condition}`);
  const ok = fn(engine);
  setStatus(`Executed: while (${item.condition}()) -> ${ok ? "repeat" : "exit"}`);
  if (ok) {
    queue.unshift(...item.body.map(statementToQueueItem), item);
  }
}

function runCallQueueItem(item) {
  const body = resolveFunctionBody(item.name);
  if (!body) throw new Error(`Unknown function: ${item.name}`);
  const inner = body.map(statementToQueueItem);
  queue.unshift({ type: "scopePush" }, ...inner, { type: "scopePop" });
  setStatus(`Executed: ${item.name}()`);
}

function runScopePush() {
  scopeStack.push(new Map());
}

function runScopePop() {
  scopeStack.pop();
}

function runDefunItem(item) {
  if (scopeStack.length === 0) {
    throw new Error("Internal error: nested function outside of a call");
  }
  scopeStack[scopeStack.length - 1].set(item.name, item.body);
  setStatus(`Executed: function ${item.name}() { … } (local)`);
}

function parseEditorCommands() {
  const parsed = parseProgram(editor.getValue());
  userFunctions = parsed.functions;
  return parsed.main;
}

function executeNext() {
  if (queue.length === 0) {
    setStatus("Program completed.");
    return;
  }

  try {
    const item = queue.shift();
    if (typeof item === "string") {
      const result = runCommand(engine, item);
      if (typeof result === "boolean" || typeof result === "number") {
        setStatus(`Executed: ${item} -> ${result}`);
      } else {
        setStatus(`Executed: ${item}`);
      }
    } else if (item && item.type === "if") {
      const fn = CONDITION_EVALUATORS[item.condition];
      if (!fn) throw new Error(`Unknown if condition: ${item.condition}`);
      const ok = fn(engine);
      setStatus(`Executed: if (${item.condition}()) -> ${ok}`);
      if (ok) {
        queue.unshift(...item.body.map(statementToQueueItem));
      }
    } else if (item && item.type === "for") {
      const expanded = expandForToQueueItems(item.count, item.body);
      queue.unshift(...expanded);
      setStatus(`Executed: for (${item.count}×)`);
    } else if (item && item.type === "while") {
      runWhileQueueItem(item);
    } else if (item && item.type === "call") {
      runCallQueueItem(item);
    } else if (item && item.type === "scopePush") {
      runScopePush();
    } else if (item && item.type === "scopePop") {
      runScopePop();
    } else if (item && item.type === "defun") {
      runDefunItem(item);
    } else {
      throw new Error("Invalid program item.");
    }
  } catch (error) {
    resetExecutionQueue();
    setStatus(error.message, true);
  }
}

function scheduleRunWhenAnimationsIdle() {
  function tick() {
    if (!isKarelPoseAnimating(engine.getState()) && !isCornerPaintFadeAnimating()) {
      runLoopRafId = null;
      runQueuedStep();
      return;
    }
    runLoopRafId = requestAnimationFrame(tick);
  }
  runLoopRafId = requestAnimationFrame(tick);
}

function scheduleAfterItem(lastItem) {
  if (queue.length === 0) {
    if (queueItemNeedsAnimation(lastItem)) {
      scheduleRunWhenAnimationsIdle();
    } else {
      cancelRunSchedule();
      setStatus("Program completed.");
    }
    return;
  }

  const next = queue[0];
  if (queueItemNeedsAnimation(next)) {
    scheduleRunWhenAnimationsIdle();
  } else {
    runLoopTimeoutId = setTimeout(() => {
      runLoopTimeoutId = null;
      runQueuedStep();
    }, 0);
  }
}

function runQueuedStep() {
  if (queue.length === 0) {
    cancelRunSchedule();
    setStatus("Program completed.");
    return;
  }

  const item = queue.shift();
  try {
    if (typeof item === "string") {
      const result = runCommand(engine, item);
      if (typeof result === "boolean" || typeof result === "number") {
        setStatus(`Executed: ${item} -> ${result}`);
      } else {
        setStatus(`Executed: ${item}`);
      }
    } else if (item && item.type === "if") {
      const fn = CONDITION_EVALUATORS[item.condition];
      if (!fn) throw new Error(`Unknown if condition: ${item.condition}`);
      const ok = fn(engine);
      setStatus(`Executed: if (${item.condition}()) -> ${ok}`);
      if (ok) {
        queue.unshift(...item.body.map(statementToQueueItem));
      }
    } else if (item && item.type === "for") {
      const expanded = expandForToQueueItems(item.count, item.body);
      queue.unshift(...expanded);
      setStatus(`Executed: for (${item.count}×)`);
    } else if (item && item.type === "while") {
      runWhileQueueItem(item);
    } else if (item && item.type === "call") {
      runCallQueueItem(item);
    } else if (item && item.type === "scopePush") {
      runScopePush();
    } else if (item && item.type === "scopePop") {
      runScopePop();
    } else if (item && item.type === "defun") {
      runDefunItem(item);
    } else {
      throw new Error("Invalid program item.");
    }

    scheduleAfterItem(item);
  } catch (error) {
    resetExecutionQueue();
    setStatus(error.message, true);
  }
}

runBtn.addEventListener("click", () => {
  try {
    resetExecutionQueue();
    queue = parseEditorCommands();
    if (queue.length === 0) {
      setStatus("Nothing to run.");
      return;
    }

    runQueuedStep();
  } catch (error) {
    setStatus(error.message, true);
  }
});

stepBtn.addEventListener("click", () => {
  try {
    if (queue.length === 0) {
      queue = parseEditorCommands();
    }
    executeNext();
  } catch (error) {
    setStatus(error.message, true);
  }
});

resetBtn.addEventListener("click", () => {
  resetExecutionQueue();
  engine.reset();
  setStatus("World reset.");
});

if (rulesBtn && rulesDialog) {
  rulesBtn.addEventListener("click", () => {
    if (typeof rulesDialog.showModal === "function") {
      rulesDialog.showModal();
    }
  });
}
if (rulesCloseBtn && rulesDialog) {
  rulesCloseBtn.addEventListener("click", () => rulesDialog.close());
}
if (rulesDialog) {
  rulesDialog.addEventListener("click", (e) => {
    if (e.target === rulesDialog) rulesDialog.close();
  });
}

zoomInBtn.addEventListener("click", () => {
  userZoomFactor = Math.min(USER_ZOOM_MAX, userZoomFactor + 0.08);
  applyResponsiveZoom();
});

zoomOutBtn.addEventListener("click", () => {
  userZoomFactor = Math.max(USER_ZOOM_MIN, userZoomFactor - 0.08);
  applyResponsiveZoom();
});

const WORLDS_BASE = "./worlds/";

let uploadedWorldOption = null;

async function loadWorldFromManifestFile(filename) {
  const url = `${WORLDS_BASE}${filename}`;
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`Не вдалося завантажити ${filename} (${r.status}).`);
  }
  const text = await r.text();
  const config = parseWorldJson(text);
  applyWorldConfig(config, `Карта: ${filename}`);
}

function initWorldSelectFromManifest(manifest) {
  if (!worldSelect) return;
  worldSelect.replaceChildren();
  for (const file of manifest) {
    const opt = document.createElement("option");
    opt.value = file;
    opt.textContent = file.replace(/\.json$/i, "");
    worldSelect.append(opt);
  }
}

async function initWorldsFromManifest() {
  if (!worldSelect) return;

  let manifest = [];
  try {
    const r = await fetch(`${WORLDS_BASE}manifest.json`);
    if (r.ok) {
      manifest = await r.json();
    }
  } catch {
    /* file:// або мережа недоступна */
  }

  if (!Array.isArray(manifest) || manifest.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "— немає manifest.json —";
    opt.disabled = true;
    worldSelect.append(opt);
    setStatus(
      "Готово. Список карт недоступний (потрібен HTTP-сервер). Використайте «З файлу…» або вбудовану карту.",
      false
    );
    return;
  }

  initWorldSelectFromManifest(manifest);
  const defaultFile = manifest.includes("demo.json") ? "demo.json" : manifest[0];
  worldSelect.value = defaultFile;
  try {
    await loadWorldFromManifestFile(defaultFile);
  } catch (e) {
    setStatus(String(e.message ?? e), true);
  }
}

if (worldSelect) {
  worldSelect.addEventListener("change", async () => {
    const filename = worldSelect.value;
    if (!filename) return;
    if (uploadedWorldOption && filename !== "__uploaded__") {
      uploadedWorldOption.remove();
      uploadedWorldOption = null;
    }
    if (filename === "__uploaded__") return;
    try {
      await loadWorldFromManifestFile(filename);
    } catch (e) {
      setStatus(String(e.message ?? e), true);
    }
  });
}

if (loadWorldFileBtn && worldFileInput) {
  loadWorldFileBtn.addEventListener("click", () => worldFileInput.click());
  worldFileInput.addEventListener("change", async () => {
    const file = worldFileInput.files?.[0];
    worldFileInput.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const config = parseWorldJson(text);
      applyWorldConfig(config, `Карта з файлу: ${file.name}`);
      if (worldSelect) {
        if (!uploadedWorldOption) {
          uploadedWorldOption = document.createElement("option");
          uploadedWorldOption.value = "__uploaded__";
          worldSelect.prepend(uploadedWorldOption);
        }
        uploadedWorldOption.textContent = `Файл: ${file.name}`;
        worldSelect.value = "__uploaded__";
      }
    } catch (e) {
      setStatus(String(e.message ?? e), true);
    }
  });
}

if (worldCollapseBtn && worldPanel) {
  worldCollapseBtn.addEventListener("click", () => {
    worldPanel.classList.toggle("world-panel--collapsed");
    const collapsed = worldPanel.classList.contains("world-panel--collapsed");
    worldCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
    worldCollapseBtn.title = collapsed ? "Показати поле світу" : "Згорнути поле світу";
    worldCollapseBtn.textContent = collapsed ? "▲" : "▼";
    if (!collapsed) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    }
  });
}

initWorldsFromManifest().catch(() => {
  /* початковий applyWorldConfig уже встановив світ */
});

updateZoomValue(userZoomFactor);
