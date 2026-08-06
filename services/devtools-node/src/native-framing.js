import os from "node:os";

export const NATIVE_INPUT_LIMIT = 4 * 1024 * 1024;
export const NATIVE_OUTPUT_LIMIT = 1024 * 1024;
const LITTLE_ENDIAN = os.endianness() === "LE";

function jsonBytes(value) {
  let source;
  try {
    source = JSON.stringify(value);
  } catch {
    throw new TypeError("Native message must be JSON serializable");
  }
  if (source === undefined) throw new TypeError("Native message cannot be undefined");
  const bytes = Buffer.from(source, "utf8");
  if (bytes.length > NATIVE_OUTPUT_LIMIT) throw new Error("Native host output exceeds Chrome's 1 MB limit");
  return bytes;
}

export function encodeNativeMessage(value) {
  const body = jsonBytes(value);
  const header = Buffer.allocUnsafe(4);
  if (LITTLE_ENDIAN) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  constructor({ limit = NATIVE_INPUT_LIMIT } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NATIVE_INPUT_LIMIT) {
      throw new TypeError("Native message decoder limit is invalid");
    }
    this.limit = limit;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const output = [];
    while (this.buffer.length >= 4) {
      const length = LITTLE_ENDIAN ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0);
      if (length > this.limit) throw new Error("Native message exceeds the configured limit");
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        throw new Error("Native message contains invalid JSON");
      }
      output.push(message);
    }
    if (this.buffer.length > this.limit + 4) throw new Error("Native message buffer exceeds the configured limit");
    return output;
  }
}

export async function writeNativeMessage(stream, value) {
  const frame = encodeNativeMessage(value);
  if (stream.write(frame)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}
