const ALLOWED_COMMANDS = new Set([
  "move()",
  "turnLeft()",
  "putBeeper()",
  "pickBeeper()",
  "frontIsClear()",
  "leftIsClear()",
  "rightIsClear()",
  "beepersPresent()",
  "beepersInBag()",
  "bagEmpty()",
  "bagCount()",
]);
const PAINT_CORNER_RE = /^paintCorner\("([^"]+)"\)$/;

/** @typedef {{ type: 'cmd', cmd: string }} CmdStmt */
/** @typedef {{ type: 'if', condition: string, body: Statement[] }} IfStmt */
/** @typedef {{ type: 'for', count: number, body: Statement[] }} ForStmt */
/** @typedef {{ type: 'while', condition: string, body: Statement[] }} WhileStmt */
/** @typedef {{ type: 'call', name: string }} CallStmt */
/** @typedef {{ type: 'defun', name: string, body: Statement[] }} DefunStmt */
/** @typedef {CmdStmt | IfStmt | ForStmt | WhileStmt | CallStmt | DefunStmt} Statement */

/** @typedef {string | { type: 'if', condition: string, body: Statement[] } | { type: 'for', count: number, body: Statement[] } | { type: 'while', condition: string, body: Statement[] } | { type: 'call', name: string } | { type: 'defun', name: string, body: Statement[] } | { type: 'scopePush' } | { type: 'scopePop' }} QueueItem */

const IF_HEADER_RE = /^if\s*\((\w+)\(\)\)\s*\{\s*$/;
const WHILE_HEADER_RE = /^while\s*\((\w+)\(\)\)\s*\{\s*$/;
const FUNCTION_HEADER_RE = /^function\s+(\w+)\s*\(\s*\)\s*\{\s*$/;
/** JS-like: for (let i = 0; i < N; …) { — N must be a non-negative integer; last clause any increment */
const FOR_HEADER_RE =
  /^for\s*\(\s*let\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*(\d+)\s*;\s*[^)]+\)\s*\{\s*$/;

export const CONDITION_NAMES = [
  "frontIsClear",
  "leftIsClear",
  "rightIsClear",
  "beepersPresent",
  "beepersInBag",
  "bagEmpty",
];

export const MAX_FOR_ITERATIONS = 10000;

/** Names that cannot be user functions (syntax / builtins). */
const RESERVED_FUNCTION_NAMES = new Set([
  "if",
  "while",
  "for",
  "function",
  "let",
  "const",
  "var",
  "paintCorner",
]);
const BUILTIN_COMMAND_NAMES = new Set([
  "move",
  "turnLeft",
  "putBeeper",
  "pickBeeper",
  "frontIsClear",
  "leftIsClear",
  "rightIsClear",
  "beepersPresent",
  "beepersInBag",
  "bagEmpty",
  "bagCount",
]);

function normalizeToken(token) {
  return token.endsWith(";") ? token.slice(0, -1).trim() : token;
}

function validateCommandToken(token, lineLabel) {
  if (ALLOWED_COMMANDS.has(token) || PAINT_CORNER_RE.test(token)) {
    return;
  }
  throw new Error(
    `${lineLabel}: Unsupported command "${token}". Allowed: move(), turnLeft(), putBeeper(), pickBeeper(), frontIsClear(), leftIsClear(), rightIsClear(), beepersPresent(), beepersInBag(), bagEmpty(), bagCount(), paintCorner("Color")`
  );
}

function validateCommandLine(line, lineNumber) {
  const token = normalizeToken(line);
  validateCommandToken(token, `Line ${lineNumber}`);
}

function validateUserFunctionName(name, lineNumber) {
  if (RESERVED_FUNCTION_NAMES.has(name)) {
    throw new Error(`Line ${lineNumber}: Invalid function name "${name}" (reserved word)`);
  }
  if (BUILTIN_COMMAND_NAMES.has(name)) {
    throw new Error(`Line ${lineNumber}: Name "${name}" is already a built-in command`);
  }
}

/**
 * User call `foo();` — not a built-in or paintCorner(...).
 * @param {string} line
 * @returns {CallStmt | null}
 */
function tryParseCall(line) {
  const trimmed = line.trim();
  const m = trimmed.match(/^(\w+)\(\)\s*;?\s*$/);
  if (!m) return null;
  const token = normalizeToken(trimmed);
  if (ALLOWED_COMMANDS.has(token)) return null;
  if (PAINT_CORNER_RE.test(token)) return null;
  const name = m[1];
  if (RESERVED_FUNCTION_NAMES.has(name) || BUILTIN_COMMAND_NAMES.has(name)) return null;
  return { type: "call", name };
}

/**
 * Lexical visibility: `defun` is visible only after its declaration in the same block;
 * bodies of if/for/while do not leak names outward.
 * @param {Statement[]} stmts
 * @param {Set<string>} env
 * @param {string} ctx
 */
function validateBlock(stmts, env, ctx) {
  let currentEnv = new Set(env);
  for (const st of stmts) {
    if (st.type === "call") {
      if (!currentEnv.has(st.name)) {
        throw new Error(`${ctx}: call to undefined function "${st.name}"`);
      }
    } else if (st.type === "defun") {
      if (currentEnv.has(st.name)) {
        throw new Error(`${ctx}: duplicate function name "${st.name}" in the same block`);
      }
      const innerEnv = new Set([...currentEnv, st.name]);
      validateBlock(st.body, innerEnv, `${ctx} → ${st.name}`);
      currentEnv = new Set([...currentEnv, st.name]);
    } else if (st.type === "if" || st.type === "for" || st.type === "while") {
      validateBlock(st.body, currentEnv, ctx);
    }
  }
}

/**
 * @param {string[]} lines
 * @param {number} i
 * @returns {{ stmt: Statement, nextIndex: number } | null}
 */
function tryParseStructuredStatement(lines, i) {
  const line = lines[i].trim();

  const ifMatch = line.match(IF_HEADER_RE);
  if (ifMatch) {
    const condition = ifMatch[1];
    if (!CONDITION_NAMES.includes(condition)) {
      throw new Error(`Line ${i + 1}: if condition must be one of: ${CONDITION_NAMES.join(", ")}`);
    }
    const inner = parseBlock(lines, i + 1, true);
    return { stmt: { type: "if", condition, body: inner.stmts }, nextIndex: inner.nextIndex };
  }

  const forMatch = line.match(FOR_HEADER_RE);
  if (forMatch) {
    const count = parseInt(forMatch[1], 10);
    if (count > MAX_FOR_ITERATIONS) {
      throw new Error(
        `Line ${i + 1}: for loop count must be at most ${MAX_FOR_ITERATIONS} (got ${count})`
      );
    }
    const inner = parseBlock(lines, i + 1, true);
    return { stmt: { type: "for", count, body: inner.stmts }, nextIndex: inner.nextIndex };
  }

  const whileMatch = line.match(WHILE_HEADER_RE);
  if (whileMatch) {
    const condition = whileMatch[1];
    if (!CONDITION_NAMES.includes(condition)) {
      throw new Error(`Line ${i + 1}: while condition must be one of: ${CONDITION_NAMES.join(", ")}`);
    }
    const inner = parseBlock(lines, i + 1, true);
    return { stmt: { type: "while", condition, body: inner.stmts }, nextIndex: inner.nextIndex };
  }

  return null;
}

/**
 * @param {string[]} lines trimmed non-empty, non-comment lines
 * @param {number} start
 * @param {boolean} mustCloseWithBrace — if true, block must end with `}` before EOF
 * @returns {{ stmts: Statement[], nextIndex: number }}
 */
function parseBlock(lines, start, mustCloseWithBrace) {
  const stmts = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === "}") {
      return { stmts, nextIndex: i + 1 };
    }

    const structured = tryParseStructuredStatement(lines, i);
    if (structured) {
      stmts.push(structured.stmt);
      i = structured.nextIndex;
      continue;
    }

    const callStmt = tryParseCall(lines[i]);
    if (callStmt) {
      stmts.push(callStmt);
      i += 1;
      continue;
    }

    const funMatch = line.match(FUNCTION_HEADER_RE);
    if (funMatch) {
      const name = funMatch[1];
      validateUserFunctionName(name, i + 1);
      const inner = parseBlock(lines, i + 1, true);
      stmts.push({ type: "defun", name, body: inner.stmts });
      i = inner.nextIndex;
      continue;
    }

    validateCommandLine(line, i + 1);
    stmts.push({ type: "cmd", cmd: normalizeToken(line) });
    i += 1;
  }
  if (mustCloseWithBrace) {
    throw new Error(`Missing closing "}" (opened before line ${start + 1})`);
  }
  return { stmts, nextIndex: i };
}

/**
 * Top level: optional `function name() { ... }` blocks plus main program.
 * @param {string[]} lines
 * @returns {{ mainStmts: Statement[], functions: Record<string, Statement[]> }}
 */
function parseTopLevel(lines) {
  /** @type {Record<string, Statement[]>} */
  const functions = Object.create(null);
  const mainStmts = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "}") {
      throw new Error(`Line ${i + 1}: Unexpected "}"`);
    }

    const funMatch = line.match(FUNCTION_HEADER_RE);
    if (funMatch) {
      const name = funMatch[1];
      validateUserFunctionName(name, i + 1);
      if (functions[name]) {
        throw new Error(`Line ${i + 1}: Duplicate function "${name}"`);
      }
      const inner = parseBlock(lines, i + 1, true);
      functions[name] = inner.stmts;
      i = inner.nextIndex;
      continue;
    }

    const structured = tryParseStructuredStatement(lines, i);
    if (structured) {
      mainStmts.push(structured.stmt);
      i = structured.nextIndex;
      continue;
    }

    const callStmt = tryParseCall(lines[i]);
    if (callStmt) {
      mainStmts.push(callStmt);
      i += 1;
      continue;
    }

    validateCommandLine(lines[i], i + 1);
    mainStmts.push({ type: "cmd", cmd: normalizeToken(lines[i]) });
    i += 1;
  }

  const globalNames = new Set(Object.keys(functions));
  validateBlock(mainStmts, globalNames, "Program");
  for (const fname of globalNames) {
    validateBlock(functions[fname], globalNames, `Function "${fname}"`);
  }

  return { mainStmts, functions };
}

/**
 * Repeat body `count` times as a flat list of queue items (nested if/for preserved as nodes).
 * @param {number} count
 * @param {Statement[]} body
 * @returns {QueueItem[]}
 */
export function expandForToQueueItems(count, body) {
  const out = [];
  for (let k = 0; k < count; k += 1) {
    for (const st of body) {
      out.push(statementToQueueItem(st));
    }
  }
  return out;
}

/**
 * Flat program for the runner: strings and compiled `if` / `for` / `while` nodes (body stays as Statement[]).
 * @param {Statement} s
 * @returns {QueueItem}
 */
export function statementToQueueItem(s) {
  if (s.type === "cmd") return s.cmd;
  if (s.type === "if") return { type: "if", condition: s.condition, body: s.body };
  if (s.type === "for") return { type: "for", count: s.count, body: s.body };
  if (s.type === "while") return { type: "while", condition: s.condition, body: s.body };
  if (s.type === "call") return { type: "call", name: s.name };
  if (s.type === "defun") return { type: "defun", name: s.name, body: s.body };
  throw new Error("Unknown statement type");
}

/**
 * @returns {{ main: QueueItem[], functions: Record<string, Statement[]> }}
 */
export function parseProgram(source) {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));

  const { mainStmts, functions } = parseTopLevel(lines);
  return {
    main: mainStmts.map(statementToQueueItem),
    functions,
  };
}

export function runCommand(engine, command) {
  if (command === "move()") engine.move();
  else if (command === "turnLeft()") engine.turnLeft();
  else if (command === "putBeeper()") engine.putBeeper();
  else if (command === "pickBeeper()") engine.pickBeeper();
  else if (command === "frontIsClear()") return engine.frontIsClear();
  else if (command === "leftIsClear()") return engine.leftIsClear();
  else if (command === "rightIsClear()") return engine.rightIsClear();
  else if (command === "beepersPresent()") return engine.beepersPresent();
  else if (command === "beepersInBag()") return engine.beepersInBag();
  else if (command === "bagEmpty()") return engine.bagEmpty();
  else if (command === "bagCount()") return engine.getBagCount();
  else {
    const paintMatch = command.match(PAINT_CORNER_RE);
    if (paintMatch) engine.paintCorner(paintMatch[1]);
  }
  return null;
}

export const CONDITION_EVALUATORS = {
  frontIsClear: (e) => e.frontIsClear(),
  leftIsClear: (e) => e.leftIsClear(),
  rightIsClear: (e) => e.rightIsClear(),
  beepersPresent: (e) => e.beepersPresent(),
  beepersInBag: (e) => e.beepersInBag(),
  bagEmpty: (e) => e.bagEmpty(),
};
