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
/** @typedef {{ type: 'return', expr: string }} ReturnStmt */
/** @typedef {CmdStmt | IfStmt | ForStmt | WhileStmt | CallStmt | DefunStmt | ReturnStmt} Statement */

/** @typedef {string | { type: 'if', condition: string, body: Statement[] } | { type: 'for', count: number, body: Statement[] } | { type: 'while', condition: string, body: Statement[] } | { type: 'call', name: string } | { type: 'defun', name: string, body: Statement[] } | { type: 'return', expr: string } | { type: 'scopePush' } | { type: 'scopePop' } | { type: 'condEvalResume', slot: { value: boolean | null, done: boolean } }} QueueItem */

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

/**
 * Витягує текст умови між першою `(` після `if`/`while` і відповідною `)` (з урахуванням вкладених дужок).
 * Рядок має далі містити `{` (можуть бути пробіли).
 * @returns {string | null}
 */
function extractConditionAfterKeyword(line, keyword) {
  const re = new RegExp(`^${keyword}\\s*\\(`);
  const m = line.match(re);
  if (!m) return null;
  let depth = 1;
  let i = m[0].length;
  const start = i;
  while (depth > 0 && i < line.length) {
    if (line[i] === "(") depth += 1;
    else if (line[i] === ")") depth -= 1;
    i += 1;
  }
  if (depth !== 0) return null;
  const cond = line.slice(start, i - 1).trim();
  const after = line.slice(i).trim();
  if (!after.startsWith("{")) return null;
  return cond;
}

/** @typedef {{ type: 'lparen' | 'rparen' | 'not' | 'and' | 'or' | 'pred' | 'usercall' | 'bool', name?: string, value?: boolean }} CondToken */

/**
 * Токенізація умови: предикати як `name()`, літерали `true` / `false`, `&&`, `||`, `!`, дужки.
 * @param {string} expr
 * @returns {CondToken[]}
 */
function tokenizeCondition(expr) {
  const s = expr.trim();
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) break;
    const c = s[i];
    if (c === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
      continue;
    }
    if (c === "!") {
      tokens.push({ type: "not" });
      i += 1;
      continue;
    }
    if (c === "&" && s[i + 1] === "&") {
      tokens.push({ type: "and" });
      i += 2;
      continue;
    }
    if (c === "|" && s[i + 1] === "|") {
      tokens.push({ type: "or" });
      i += 2;
      continue;
    }
    const idMatch = s.slice(i).match(/^([a-zA-Z_]\w*)/);
    if (!idMatch) {
      throw new Error(`Condition: unexpected character "${c}" at position ${i}`);
    }
    const name = idMatch[1];
    i += name.length;
    if (name === "true" || name === "false") {
      tokens.push({ type: "bool", value: name === "true" });
      continue;
    }
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (s[i] !== "(") {
      throw new Error(`Condition: expected '(' after "${name}"`);
    }
    i += 1;
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (s[i] !== ")") {
      throw new Error(`Condition: expected ')' after "${name}("`);
    }
    i += 1;
    if (CONDITION_NAMES.includes(name)) {
      tokens.push({ type: "pred", name });
    } else {
      tokens.push({ type: "usercall", name });
    }
  }
  return tokens;
}

/**
 * @param {CondToken[]} tokens
 * @param {object} engine
 * @param {{ evalUserCall?: (name: string) => boolean }} [opts]
 */
function evaluateConditionTokens(tokens, engine, opts = {}) {
  let pos = 0;
  function peek() {
    return tokens[pos];
  }
  function take() {
    return tokens[pos++];
  }
  function parseOr() {
    let left = parseAnd();
    while (peek()?.type === "or") {
      take();
      const right = parseAnd();
      left = left || right;
    }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    while (peek()?.type === "and") {
      take();
      const right = parseUnary();
      left = left && right;
    }
    return left;
  }
  function parseUnary() {
    if (peek()?.type === "not") {
      take();
      return !parseUnary();
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (t?.type === "lparen") {
      take();
      const v = parseOr();
      if (peek()?.type !== "rparen") {
        throw new Error("Condition: missing ')'");
      }
      take();
      return v;
    }
    if (t?.type === "pred") {
      take();
      const fn = CONDITION_EVALUATORS[t.name];
      return fn(engine);
    }
    if (t?.type === "usercall") {
      take();
      if (typeof opts.evalUserCall !== "function") {
        throw new Error(
          `Condition: "${t.name}()" is a user function — allowed only inside functions with return (built-in predicates: ${CONDITION_NAMES.join(", ")})`
        );
      }
      return opts.evalUserCall(t.name);
    }
    if (t?.type === "bool") {
      take();
      return t.value;
    }
    throw new Error("Condition: expected predicate, user call, literal, or '('");
  }
  const result = parseOr();
  if (pos < tokens.length) {
    throw new Error("Condition: extra tokens after expression");
  }
  return result;
}

/**
 * AST умови для поетапного обчислення з чергою (користувацькі функції).
 * @typedef {{ type: 'lit', v: boolean }} CondAstLit
 * @typedef {{ type: 'pred', name: string }} CondAstPred
 * @typedef {{ type: 'user', name: string }} CondAstUser
 * @typedef {{ type: 'not', a: CondAst }} CondAstNot
 * @typedef {{ type: 'and', left: CondAst, right: CondAst }} CondAstAnd
 * @typedef {{ type: 'or', left: CondAst, right: CondAst }} CondAstOr
 * @typedef {CondAstLit | CondAstPred | CondAstUser | CondAstNot | CondAstAnd | CondAstOr} CondAst
 */

/**
 * @param {CondToken[]} tokens
 * @param {number} i
 * @returns {[CondAst, number]}
 */
function parseCondOr(tokens, i) {
  let [left, j] = parseCondAnd(tokens, i);
  while (tokens[j]?.type === "or") {
    const [right, k] = parseCondAnd(tokens, j + 1);
    left = { type: "or", left, right };
    j = k;
  }
  return [left, j];
}

/**
 * @param {CondToken[]} tokens
 * @param {number} i
 * @returns {[CondAst, number]}
 */
function parseCondAnd(tokens, i) {
  let [left, j] = parseCondUnary(tokens, i);
  while (tokens[j]?.type === "and") {
    const [right, k] = parseCondUnary(tokens, j + 1);
    left = { type: "and", left, right };
    j = k;
  }
  return [left, j];
}

/**
 * @param {CondToken[]} tokens
 * @param {number} i
 * @returns {[CondAst, number]}
 */
function parseCondUnary(tokens, i) {
  if (tokens[i]?.type === "not") {
    const [inner, j] = parseCondUnary(tokens, i + 1);
    return [{ type: "not", a: inner }, j];
  }
  return parseCondPrimary(tokens, i);
}

/**
 * @param {CondToken[]} tokens
 * @param {number} i
 * @returns {[CondAst, number]}
 */
function parseCondPrimary(tokens, i) {
  const t = tokens[i];
  if (t?.type === "lparen") {
    const [inner, j] = parseCondOr(tokens, i + 1);
    if (tokens[j]?.type !== "rparen") {
      throw new Error("Condition: missing ')'");
    }
    return [inner, j + 1];
  }
  if (t?.type === "bool") {
    return [{ type: "lit", v: t.value }, i + 1];
  }
  if (t?.type === "pred") {
    return [{ type: "pred", name: t.name }, i + 1];
  }
  if (t?.type === "usercall") {
    return [{ type: "user", name: t.name }, i + 1];
  }
  throw new Error("Condition: expected '(', literal, predicate, or user call");
}

/**
 * Розбір умови в AST (для `if`/`while` з покроковим виконанням користувацьких функцій).
 * @param {string} expr
 * @returns {CondAst}
 */
export function parseConditionAst(expr) {
  const raw = String(expr ?? "").trim();
  if (!raw) {
    throw new Error("Empty condition");
  }
  if (!/&&|\|\||\(/.test(raw) && /^!?(\w+)$/.test(raw)) {
    const neg = raw.startsWith("!");
    const name = neg ? raw.slice(1) : raw;
    if (name === "true" || name === "false") {
      const v = name === "true";
      const lit = { type: "lit", v };
      return neg ? { type: "not", a: lit } : lit;
    }
    if (CONDITION_NAMES.includes(name)) {
      const node = { type: "pred", name };
      return neg ? { type: "not", a: node } : node;
    }
    const node = { type: "user", name };
    return neg ? { type: "not", a: node } : node;
  }
  const tokens = tokenizeCondition(raw);
  if (tokens.length === 0) {
    throw new Error("Empty condition");
  }
  const [ast, pos] = parseCondOr(tokens, 0);
  if (pos !== tokens.length) {
    throw new Error("Condition: extra tokens after expression");
  }
  return ast;
}

/**
 * @param {CondAst} ast
 * @returns {boolean}
 */
export function conditionAstHasUserCall(ast) {
  if (!ast) return false;
  switch (ast.type) {
    case "lit":
    case "pred":
      return false;
    case "user":
      return true;
    case "not":
      return conditionAstHasUserCall(ast.a);
    case "and":
      return conditionAstHasUserCall(ast.left) || conditionAstHasUserCall(ast.right);
    case "or":
      return conditionAstHasUserCall(ast.left) || conditionAstHasUserCall(ast.right);
    default:
      return false;
  }
}

/**
 * Обчислює умову `if`/`while`: `&&`, `||`, `!`, дужки; предикати `name()` або `foo()` (користувацька функція з `return`).
 * @param {string} expr
 * @param {object} engine
 * @param {{ evalUserCall?: (name: string) => boolean }} [opts]
 */
export function evaluateConditionExpression(expr, engine, opts = {}) {
  const raw = String(expr ?? "").trim();
  if (!raw) {
    throw new Error("Empty condition");
  }
  /* Сумісність зі старим форматом без дужок: `frontIsClear`, `!rightIsClear`, `true`, `false` */
  if (!/&&|\|\||\(/.test(raw) && /^!?(\w+)$/.test(raw)) {
    const neg = raw.startsWith("!");
    const name = neg ? raw.slice(1) : raw;
    if (name === "true" || name === "false") {
      const v = name === "true";
      return neg ? !v : v;
    }
    if (!CONDITION_NAMES.includes(name)) {
      if (typeof opts.evalUserCall === "function") {
        const v = opts.evalUserCall(name);
        return neg ? !v : v;
      }
      throw new Error(`Condition: unknown predicate "${name}"`);
    }
    const fn = CONDITION_EVALUATORS[name];
    const v = fn(engine);
    return neg ? !v : v;
  }
  const tokens = tokenizeCondition(raw);
  if (tokens.length === 0) {
    throw new Error("Empty condition");
  }
  return evaluateConditionTokens(tokens, engine, opts);
}

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
  "return",
  "true",
  "false",
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
/**
 * @param {string} line
 * @returns {{ type: 'return', expr: string } | null}
 */
function tryParseReturnLine(line) {
  const trimmed = line.trim();
  if (!/^return\s+/i.test(trimmed)) return null;
  const m = trimmed.match(/^return\s+(.+)$/i);
  if (!m) return null;
  let expr = m[1].trim();
  if (expr.endsWith(";")) {
    expr = expr.slice(0, -1).trim();
  }
  if (!expr) throw new Error("Empty return expression");
  return { type: "return", expr };
}

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
    } else if (st.type === "return") {
      /* вираз перевіряється під час виконання */
    }
  }
}

/**
 * @param {string[]} lines
 * @param {number} i
 * @returns {{ stmt: Statement, nextIndex: number } | null}
 */
function tryParseStructuredStatement(lines, i, allowReturn) {
  const line = lines[i].trim();

  if (/^if\s*\(/.test(line)) {
    const cond = extractConditionAfterKeyword(line, "if");
    if (cond === null) return null;
    if (!cond) throw new Error(`Line ${i + 1}: empty if condition`);
    const inner = parseBlock(lines, i + 1, true, allowReturn);
    return { stmt: { type: "if", condition: cond, body: inner.stmts }, nextIndex: inner.nextIndex };
  }

  const forMatch = line.match(FOR_HEADER_RE);
  if (forMatch) {
    const count = parseInt(forMatch[1], 10);
    if (count > MAX_FOR_ITERATIONS) {
      throw new Error(
        `Line ${i + 1}: for loop count must be at most ${MAX_FOR_ITERATIONS} (got ${count})`
      );
    }
    const inner = parseBlock(lines, i + 1, true, allowReturn);
    return { stmt: { type: "for", count, body: inner.stmts }, nextIndex: inner.nextIndex };
  }

  if (/^while\s*\(/.test(line)) {
    const cond = extractConditionAfterKeyword(line, "while");
    if (cond === null) return null;
    if (!cond) throw new Error(`Line ${i + 1}: empty while condition`);
    const inner = parseBlock(lines, i + 1, true, allowReturn);
    return { stmt: { type: "while", condition: cond, body: inner.stmts }, nextIndex: inner.nextIndex };
  }

  return null;
}

/**
 * @param {string[]} lines trimmed non-empty, non-comment lines
 * @param {number} start
 * @param {boolean} mustCloseWithBrace — if true, block must end with `}` before EOF
 * @param {boolean} allowReturn — `return` дозволено лише всередині `function … { }`
 * @returns {{ stmts: Statement[], nextIndex: number }}
 */
function parseBlock(lines, start, mustCloseWithBrace, allowReturn) {
  const stmts = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === "}") {
      return { stmts, nextIndex: i + 1 };
    }

    const structured = tryParseStructuredStatement(lines, i, allowReturn);
    if (structured) {
      stmts.push(structured.stmt);
      i = structured.nextIndex;
      continue;
    }

    const retStmt = tryParseReturnLine(line);
    if (retStmt) {
      if (!allowReturn) {
        throw new Error(`Line ${i + 1}: return is only allowed inside a function body`);
      }
      stmts.push(retStmt);
      i += 1;
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
      const inner = parseBlock(lines, i + 1, true, allowReturn);
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

    if (/^\s*return\b/.test(line)) {
      throw new Error(`Line ${i + 1}: return is only allowed inside a function body`);
    }

    const funMatch = line.match(FUNCTION_HEADER_RE);
    if (funMatch) {
      const name = funMatch[1];
      validateUserFunctionName(name, i + 1);
      if (functions[name]) {
        throw new Error(`Line ${i + 1}: Duplicate function "${name}"`);
      }
      const inner = parseBlock(lines, i + 1, true, true);
      functions[name] = inner.stmts;
      i = inner.nextIndex;
      continue;
    }

    const structured = tryParseStructuredStatement(lines, i, false);
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
  if (s.type === "return") return { type: "return", expr: s.expr };
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
