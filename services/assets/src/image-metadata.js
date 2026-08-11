const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function positiveDimension(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Image ${label} must be a positive safe integer`);
  }
  return value;
}

function inspectPng(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG is missing its IHDR chunk");
  return {
    mime: "image/png",
    extension: "png",
    width: positiveDimension(bytes.readUInt32BE(16), "width"),
    height: positiveDimension(bytes.readUInt32BE(20), "height"),
  };
}

function inspectGif(bytes) {
  if (bytes.length < 10) return null;
  const signature = bytes.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return {
    mime: "image/gif",
    extension: "gif",
    width: positiveDimension(bytes.readUInt16LE(6), "width"),
    height: positiveDimension(bytes.readUInt16LE(8), "height"),
  };
}

function inspectJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error("JPEG contains an invalid segment length");
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) throw new Error("JPEG frame header is truncated");
      return {
        mime: "image/jpeg",
        extension: "jpg",
        height: positiveDimension(bytes.readUInt16BE(offset + 3), "height"),
        width: positiveDimension(bytes.readUInt16BE(offset + 5), "width"),
      };
    }
    offset += length;
  }
  throw new Error("JPEG dimensions could not be found");
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function inspectWebp(bytes) {
  if (bytes.length < 30
      || bytes.toString("ascii", 0, 4) !== "RIFF"
      || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("ascii", 12, 16);
  const payload = 20;
  if (chunk === "VP8X") {
    return {
      mime: "image/webp",
      extension: "webp",
      width: positiveDimension(readUInt24LE(bytes, payload + 4) + 1, "width"),
      height: positiveDimension(readUInt24LE(bytes, payload + 7) + 1, "height"),
    };
  }
  if (chunk === "VP8 ") {
    if (bytes.length < payload + 10
        || bytes[payload + 3] !== 0x9d
        || bytes[payload + 4] !== 0x01
        || bytes[payload + 5] !== 0x2a) {
      throw new Error("WebP VP8 frame header is invalid");
    }
    return {
      mime: "image/webp",
      extension: "webp",
      width: positiveDimension(bytes.readUInt16LE(payload + 6) & 0x3fff, "width"),
      height: positiveDimension(bytes.readUInt16LE(payload + 8) & 0x3fff, "height"),
    };
  }
  if (chunk === "VP8L") {
    if (bytes[payload] !== 0x2f || bytes.length < payload + 5) {
      throw new Error("WebP VP8L frame header is invalid");
    }
    const b1 = bytes[payload + 1];
    const b2 = bytes[payload + 2];
    const b3 = bytes[payload + 3];
    const b4 = bytes[payload + 4];
    return {
      mime: "image/webp",
      extension: "webp",
      width: positiveDimension(1 + (((b2 & 0x3f) << 8) | b1), "width"),
      height: positiveDimension(1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)), "height"),
    };
  }
  throw new Error(`Unsupported WebP chunk ${JSON.stringify(chunk)}`);
}

function svgNumber(value) {
  if (typeof value !== "string") return null;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)(?:px)?\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function inspectSvg(bytes) {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 65536)).toString("utf8").replace(/^\uFEFF/, "");
  const match = /<svg\b([^>]*)>/i.exec(prefix);
  if (!match) return null;
  const attributes = match[1];
  const attribute = (name) => {
    const found = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(attributes);
    return found?.[1] ?? null;
  };
  let width = svgNumber(attribute("width"));
  let height = svgNumber(attribute("height"));
  const viewBox = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if ((!width || !height) && viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    width ??= viewBox[2] > 0 ? Math.round(viewBox[2]) : null;
    height ??= viewBox[3] > 0 ? Math.round(viewBox[3]) : null;
  }
  if (!width || !height) throw new Error("SVG requires positive width/height or a positive viewBox");
  return {
    mime: "image/svg+xml",
    extension: "svg",
    width: positiveDimension(width, "width"),
    height: positiveDimension(height, "height"),
  };
}

export function inspectImage(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0) throw new Error("Image file is empty");
  for (const inspect of [inspectPng, inspectJpeg, inspectWebp, inspectGif, inspectSvg]) {
    const metadata = inspect(bytes);
    if (metadata) return metadata;
  }
  throw new Error("Unsupported image format; expected PNG, JPEG, WebP, GIF, or SVG");
}
