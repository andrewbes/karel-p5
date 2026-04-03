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
  evaluateConditionExpression,
  expandForToQueueItems,
  parseConditionAst,
  conditionAstHasUserCall,
  CONDITION_EVALUATORS,
} from "./interpreter.js";

const statusLine = document.getElementById("statusLine");
const bagCountValue = document.getElementById("bagCountValue");
const statusBagWrap = document.getElementById("statusBagWrap");
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
/** Стек контекстів поетапного обчислення умов з викликами користувацьких функцій. */
let condEvalStack = [];
/** Слоти значень `return` під час cond-eval (вкладені виклики). */
let condEvalReturnStack = [];
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
  condEvalStack = [];
  condEvalReturnStack = [];
  cancelRunSchedule();
}

function applyWorldConfig(config, statusMsg) {
  engine = new KarelEngine(config);
  resetRenderAnimation();
  resetExecutionQueue();
  if (statusMsg !== undefined && statusMsg !== null) {
    setStatus(statusMsg);
  }
  updateBagCountDisplay();
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

editor.setValue(`//Приклад коду

function turnRight() {
  turnLeft();
  turnLeft();
  turnLeft();
}

//повернути вліво
turnLeft();

//замалювати клітинку червоним
paintCorner("Red");

//пройти три кроки
for (let i = 0; i < 3; i++) {
  move();
}

//повернути вправо
turnRight();

//дійти до стіни
while (frontIsClear()) {
  move();
}

turnLeft();
while (frontIsClear()) {
  move();
}
turnLeft();
while (!rightIsClear()) {
  move();
}

paintCorner("Orange");
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

/** Шрифт для підпису кількості біперів у WEBGL (p5 text() без loadFont часто не малюється). */
let beeperLabelFont = null;

const sketch = (p) => {
  p.preload = () => {
    beeperLabelFont = p.loadFont(
      "https://unpkg.com/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf"
    );
  };

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
    drawWorld(p, engine, renderWidth, renderHeight, beeperLabelFont);
    updateBagCountDisplay();
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

function updateBagCountDisplay() {
  if (!bagCountValue || !engine) return;
  const n = engine.getBagCount();
  bagCountValue.textContent = String(n);
  if (statusBagWrap) {
    statusBagWrap.setAttribute("aria-label", `У корзині: ${n}`);
  }
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
  if (item && typeof item === "object" && item.type === "condEvalResume") {
    return false;
  }
  return typeof item === "string" && commandNeedsStepAnimation(item);
}

/**
 * @param {object} ast
 * @param {{ kind: 'while', whileItem: object } | { kind: 'if', ifItem: object }} resume
 */
function condEvalQueueStart(ast, resume) {
  condEvalStack.push({ resume, opStack: [] });
  processCondEvalNode(ast);
}

/** @param {object} ast */
function processCondEvalNode(ast) {
  if (ast.type === "lit") {
    condEvalFinish(ast.v);
    return;
  }
  if (ast.type === "pred") {
    condEvalFinish(CONDITION_EVALUATORS[ast.name](engine));
    return;
  }
  if (ast.type === "user") {
    enqueueUserCondEval(ast.name);
    return;
  }
  const ctx = condEvalStack[condEvalStack.length - 1];
  if (!ctx) throw new Error("Internal error: condition evaluation context");
  if (ast.type === "not") {
    ctx.opStack.push({ op: "not" });
    processCondEvalNode(ast.a);
    return;
  }
  if (ast.type === "and") {
    ctx.opStack.push({ op: "andRight", right: ast.right });
    processCondEvalNode(ast.left);
    return;
  }
  if (ast.type === "or") {
    ctx.opStack.push({ op: "orRight", right: ast.right });
    processCondEvalNode(ast.left);
    return;
  }
  throw new Error("Invalid condition AST");
}

function condEvalFinish(value) {
  let v = Boolean(value);
  const ctx = condEvalStack[condEvalStack.length - 1];
  if (!ctx) throw new Error("Internal error: condition evaluation finish");
  while (ctx.opStack.length) {
    const top = ctx.opStack[ctx.opStack.length - 1];
    if (top.op === "not") {
      ctx.opStack.pop();
      v = !v;
      continue;
    }
    if (top.op === "andRight") {
      ctx.opStack.pop();
      if (!v) {
        condEvalCompleteResume(false);
        return;
      }
      processCondEvalNode(top.right);
      return;
    }
    if (top.op === "orRight") {
      ctx.opStack.pop();
      if (v) {
        condEvalCompleteResume(true);
        return;
      }
      processCondEvalNode(top.right);
      return;
    }
  }
  condEvalCompleteResume(v);
}

function condEvalCompleteResume(value) {
  const ctx = condEvalStack.pop();
  if (!ctx) throw new Error("Internal error: condition evaluation complete");
  const { resume } = ctx;
  if (resume.kind === "while") {
    const item = resume.whileItem;
    setStatus(`Executed: while (${item.condition}) -> ${value}`);
    if (value) {
      queue.unshift(...item.body.map(statementToQueueItem), item);
    }
  } else if (resume.kind === "if") {
    const item = resume.ifItem;
    setStatus(`Executed: if (${item.condition}) -> ${value}`);
    if (value) {
      queue.unshift(...item.body.map(statementToQueueItem));
    }
  }
}

function enqueueUserCondEval(name) {
  const body = resolveFunctionBody(name);
  if (!body) throw new Error(`Unknown function: ${name}`);
  const slot = { value: null, done: false };
  condEvalReturnStack.push(slot);
  queue.unshift(
    { type: "scopePush" },
    ...body.map(statementToQueueItem),
    { type: "scopePop" },
    { type: "condEvalResume", slot }
  );
}

function runCondEvalResumeItem(item) {
  const slot = item.slot;
  if (!slot.done) {
    throw new Error("Function must end with return <expression>;");
  }
  condEvalReturnStack.pop();
  condEvalFinish(Boolean(slot.value));
}

const conditionEvalOpts = () => ({
  evalUserCall: (name) => evalUserBooleanFunction(name),
});

function evalCondition(condition) {
  return evaluateConditionExpression(condition, engine, conditionEvalOpts());
}

/**
 * Синхронно виконує тіло функції до першого `return` (для умов і `return` у черзі).
 * @param {import("./interpreter.js").Statement[]} bodyStatements
 * @param {{ requireReturn: boolean }} opts
 * @returns {boolean | undefined}
 */
function runSyncBody(bodyStatements, opts) {
  scopeStack.push(new Map());
  const q = bodyStatements.map(statementToQueueItem);
  try {
    while (q.length > 0) {
      const item = q.shift();
      const ret = runSyncQueueItem(item, q);
      if (ret != null && ret.kind === "return") {
        if (opts.requireReturn) return ret.value;
        return undefined;
      }
    }
  } finally {
    scopeStack.pop();
  }
  if (opts.requireReturn) {
    throw new Error("Function must end with return <expression>;");
  }
  return undefined;
}

/**
 * @param {unknown} item
 * @param {unknown[]} q
 * @returns {{ kind: 'return', value: boolean } | null}
 */
function runSyncQueueItem(item, q) {
  if (typeof item === "string") {
    runCommand(engine, item);
    return null;
  }
  if (item.type === "if") {
    if (evalCondition(item.condition)) {
      q.unshift(...item.body.map(statementToQueueItem));
    }
    return null;
  }
  if (item.type === "for") {
    q.unshift(...expandForToQueueItems(item.count, item.body));
    return null;
  }
  if (item.type === "while") {
    if (evalCondition(item.condition)) {
      q.unshift(...item.body.map(statementToQueueItem), item);
    }
    return null;
  }
  if (item.type === "call") {
    const callee = resolveFunctionBody(item.name);
    if (!callee) throw new Error(`Unknown function: ${item.name}`);
    runSyncBody(callee, { requireReturn: false });
    return null;
  }
  if (item.type === "scopePush") {
    scopeStack.push(new Map());
    return null;
  }
  if (item.type === "scopePop") {
    scopeStack.pop();
    return null;
  }
  if (item.type === "defun") {
    runDefunItem(item);
    return null;
  }
  if (item.type === "return") {
    const v = evaluateConditionExpression(item.expr, engine, conditionEvalOpts());
    return { kind: "return", value: Boolean(v) };
  }
  throw new Error("Invalid program item.");
}

function evalUserBooleanFunction(name) {
  const body = resolveFunctionBody(name);
  if (!body) throw new Error(`Unknown function: ${name}`);
  const v = runSyncBody(body, { requireReturn: true });
  return Boolean(v);
}

function skipQueueUntilMatchingScopePop() {
  let depth = 1;
  while (queue.length > 0 && depth > 0) {
    const next = queue[0];
    if (next?.type === "scopePush") depth += 1;
    else if (next?.type === "scopePop") depth -= 1;
    queue.shift();
  }
  if (depth !== 0) {
    throw new Error('Internal error: unbalanced scope while processing "return"');
  }
}

function runReturnQueueItem(item) {
  if (scopeStack.length === 0) {
    throw new Error("return is only allowed inside a function body");
  }
  const v = evaluateConditionExpression(item.expr, engine, conditionEvalOpts());
  const slot = condEvalReturnStack.length ? condEvalReturnStack[condEvalReturnStack.length - 1] : null;
  if (slot) {
    slot.value = Boolean(v);
    slot.done = true;
  }
  skipQueueUntilMatchingScopePop();
  runScopePop();
  setStatus(`Executed: return (${item.expr})`);
}

function resolveFunctionBody(name) {
  for (let i = scopeStack.length - 1; i >= 0; i -= 1) {
    const frame = scopeStack[i];
    if (frame.has(name)) return frame.get(name);
  }
  return userFunctions[name] ?? null;
}

function runWhileQueueItem(item) {
  const ast = parseConditionAst(item.condition);
  if (conditionAstHasUserCall(ast)) {
    condEvalQueueStart(ast, { kind: "while", whileItem: item });
    return;
  }
  const ok = evalCondition(item.condition);
  setStatus(`Executed: while (${item.condition}) -> ${ok ? "repeat" : "exit"}`);
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
      const ast = parseConditionAst(item.condition);
      if (conditionAstHasUserCall(ast)) {
        condEvalQueueStart(ast, { kind: "if", ifItem: item });
      } else {
        const ok = evalCondition(item.condition);
        setStatus(`Executed: if (${item.condition}) -> ${ok}`);
        if (ok) {
          queue.unshift(...item.body.map(statementToQueueItem));
        }
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
    } else if (item && item.type === "return") {
      runReturnQueueItem(item);
    } else if (item && item.type === "condEvalResume") {
      runCondEvalResumeItem(item);
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
      const ast = parseConditionAst(item.condition);
      if (conditionAstHasUserCall(ast)) {
        condEvalQueueStart(ast, { kind: "if", ifItem: item });
      } else {
        const ok = evalCondition(item.condition);
        setStatus(`Executed: if (${item.condition}) -> ${ok}`);
        if (ok) {
          queue.unshift(...item.body.map(statementToQueueItem));
        }
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
    } else if (item && item.type === "return") {
      runReturnQueueItem(item);
    } else if (item && item.type === "condEvalResume") {
      runCondEvalResumeItem(item);
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
