function location(path) {
  return path.length ? path.join("") : "value";
}

/** Encode host data as HAL-readable EDN without executing downloaded source. */
export function encodeHalValue(value, path = [], seen = new Set()) {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${location(path)} must be a finite number`);
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") {
    throw new TypeError(`${location(path)} is not transportable to HAL`);
  }
  if (seen.has(value)) throw new TypeError(`${location(path)} contains a circular reference`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => encodeHalValue(item, [...path, `[${index}]`], seen)).join(" ")}]`;
    }
    if (value instanceof Set) {
      return `#{${[...value].map((item, index) => encodeHalValue(item, [...path, `{${index}}`], seen)).join(" ")}}`;
    }
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
    return `{${entries.map(([key, item]) => {
      if (typeof key !== "string") throw new TypeError(`${location(path)} has a non-string map key`);
      return `${JSON.stringify(key)} ${encodeHalValue(item, [...path, `.${key}`], seen)}`;
    }).join(" ")}}`;
  } finally {
    seen.delete(value);
  }
}
