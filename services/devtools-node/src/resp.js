export const RESP_MESSAGE_LIMIT = 1024 * 1024;
const MAX_ARGUMENTS = 64;

function lineEnd(buffer, offset) {
  const index = buffer.indexOf("\r\n", offset, "utf8");
  return index < 0 ? null : index;
}

function integerLine(buffer, offset, label) {
  const end = lineEnd(buffer, offset);
  if (end === null) return null;
  const source = buffer.subarray(offset, end).toString("ascii");
  if (!/^-?\d+$/.test(source)) throw new Error(`${label} is invalid`);
  const value = Number(source);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is outside the safe integer range`);
  return { value, next: end + 2 };
}

function parseBulk(buffer, offset) {
  if (buffer[offset] !== 36) throw new Error("RESP array entries must be bulk strings");
  const length = integerLine(buffer, offset + 1, "RESP bulk length");
  if (!length) return null;
  if (length.value < 0) return { value: null, next: length.next };
  if (length.value > RESP_MESSAGE_LIMIT) throw new Error("RESP bulk string exceeds the 1 MB limit");
  const end = length.next + length.value;
  if (buffer.length < end + 2) return null;
  if (buffer[end] !== 13 || buffer[end + 1] !== 10) throw new Error("RESP bulk string is not CRLF terminated");
  return { value: buffer.subarray(length.next, end).toString("utf8"), next: end + 2 };
}

function parseArray(buffer) {
  const length = integerLine(buffer, 1, "RESP array length");
  if (!length) return null;
  if (length.value < 0 || length.value > MAX_ARGUMENTS) throw new Error("RESP command has an invalid argument count");
  const values = [];
  let offset = length.next;
  for (let index = 0; index < length.value; index += 1) {
    const entry = parseBulk(buffer, offset);
    if (!entry) return null;
    if (entry.value === null) throw new Error("RESP commands cannot contain null arguments");
    values.push(entry.value);
    offset = entry.next;
  }
  return { value: values, bytes: offset };
}

function parseInline(buffer) {
  const end = lineEnd(buffer, 0);
  if (end === null) return null;
  const source = buffer.subarray(0, end).toString("utf8").trim();
  if (!source) return { value: [], bytes: end + 2 };
  const values = source.split(/\s+/u);
  if (values.length > MAX_ARGUMENTS) throw new Error("RESP inline command has too many arguments");
  return { value: values, bytes: end + 2 };
}

export class RespCommandDecoder {
  constructor({ limit = RESP_MESSAGE_LIMIT } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RESP_MESSAGE_LIMIT) {
      throw new TypeError("RESP decoder limit is invalid");
    }
    this.limit = limit;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > this.limit) throw new Error("RESP request exceeds the 1 MB limit");
    const output = [];
    while (this.buffer.length) {
      const parsed = this.buffer[0] === 42 ? parseArray(this.buffer) : parseInline(this.buffer);
      if (!parsed) break;
      this.buffer = this.buffer.subarray(parsed.bytes);
      if (parsed.value.length) output.push(parsed.value);
    }
    return output;
  }
}

function safeLine(value) {
  return String(value).replace(/[\r\n]+/gu, " ").slice(0, 4096);
}

export function respSimple(value) {
  return Buffer.from(`+${safeLine(value)}\r\n`, "utf8");
}

export function respError(value) {
  return Buffer.from(`-ERR ${safeLine(value)}\r\n`, "utf8");
}

export function respBulk(value) {
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`, "ascii"), bytes, Buffer.from("\r\n")]);
}

export function respJson(value) {
  return respBulk(JSON.stringify(value));
}
