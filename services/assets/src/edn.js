const KEYWORD = /^[A-Za-z*+!_?<>=$%&.-][A-Za-z0-9*+!_?<>=$%&.\/-]*$/;

function encodeKey(value) {
  if (KEYWORD.test(value)) return `:${value}`;
  return JSON.stringify(value);
}

export function encodeEdn(value) {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("EDN cannot encode a non-finite number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(encodeEdn).join(" ")}]`;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("EDN asset values must be plain objects");
    }
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${encodeKey(key)} ${encodeEdn(entry)}`).join(" ")}}`;
  }
  throw new TypeError(`EDN cannot encode ${typeof value}`);
}
