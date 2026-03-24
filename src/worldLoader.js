const DIRECTIONS = new Set(["N", "E", "S", "W"]);

function positiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Поле "${field}" має бути цілим числом ≥ 1.`);
  }
  return n;
}

function nonNegInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Поле "${field}" має бути цілим числом ≥ 0.`);
  }
  return n;
}

/**
 * @param {string} text
 * @returns {object} config for KarelEngine — поле bagCount лише початкова кількість у корзині,
 *   не сумується з біперами з масиву beepers (ті лежать на клітинках карти).
 */
export function parseWorldJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Файл світу не є коректним JSON.");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Корінь файлу світу має бути об'єктом.");
  }

  const width = positiveInt(data.width, "width");
  const height = positiveInt(data.height, "height");
  const startX = nonNegInt(data.startX ?? 0, "startX");
  const startY = nonNegInt(data.startY ?? 0, "startY");

  if (startX >= width || startY >= height) {
    throw new Error("startX / startY мають бути всередині сітки.");
  }

  const startDir = data.startDir ?? "E";
  if (typeof startDir !== "string" || !DIRECTIONS.has(startDir)) {
    throw new Error('startDir має бути одним із: "N", "E", "S", "W".');
  }

  const beepers = Array.isArray(data.beepers) ? data.beepers : [];
  for (const cell of beepers) {
    if (typeof cell !== "string") throw new Error("beepers: очікується масив рядків \"x,y\" або \"x,y:n\".");
    let m = cell.match(/^(\d+),(\d+):(\d+)$/);
    let bx;
    let by;
    if (m) {
      bx = Number(m[1]);
      by = Number(m[2]);
      const n = Number(m[3]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Некоректна кількість біперів у "${cell}" (n має бути цілим ≥ 1).`);
      }
    } else {
      m = cell.match(/^(\d+),(\d+)$/);
      if (!m) throw new Error(`Некоректний біпер "${cell}" (формат \"x,y\" або \"x,y:n\").`);
      bx = Number(m[1]);
      by = Number(m[2]);
    }
    if (bx >= width || by >= height) {
      throw new Error(`Біпер "${cell}" виходить за межі поля.`);
    }
  }

  const walls = Array.isArray(data.walls) ? data.walls : [];
  for (const w of walls) {
    if (typeof w !== "string") throw new Error("walls: очікується масив рядків.");
    const m = w.match(/^([ne]),(\d+),(\d+)$/);
    if (!m) {
      throw new Error(`Некоректна стіна "${w}" (очікується \"n,x,y\" або \"e,x,y\").`);
    }
    const edge = m[1];
    const ix = Number(m[2]);
    const iy = Number(m[3]);
    if (edge === "n") {
      if (iy >= height - 1 || ix >= width) {
        throw new Error(`Стіна "${w}" поза межами сітки.`);
      }
    } else if (edge === "e") {
      if (ix >= width - 1 || iy >= height) {
        throw new Error(`Стіна "${w}" поза межами сітки.`);
      }
    }
  }

  let cornerColors = {};
  if (data.cornerColors != null) {
    if (typeof data.cornerColors !== "object" || Array.isArray(data.cornerColors)) {
      throw new Error("cornerColors має бути об'єктом \"x,y\" → назва кольору.");
    }
    for (const [key, val] of Object.entries(data.cornerColors)) {
      if (!/^\d+,\d+$/.test(key)) {
        throw new Error(`Некоректний ключ cornerColors "${key}".`);
      }
      const [cx, cy] = key.split(",").map(Number);
      if (cx >= width || cy >= height) {
        throw new Error(`cornerColors[${key}] поза межами поля.`);
      }
      if (typeof val !== "string") {
        throw new Error(`cornerColors[${key}] має бути рядком (назва кольору).`);
      }
      cornerColors[key] = val;
    }
  }

  /** Лише біпери в корзині на старті; біпери на полі — у beepers. */
  const bagCount = data.bagCount != null ? nonNegInt(data.bagCount, "bagCount") : 0;

  return {
    width,
    height,
    startX,
    startY,
    startDir,
    beepers,
    walls,
    cornerColors,
    bagCount,
  };
}
