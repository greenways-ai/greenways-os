import { readFile } from "node:fs/promises";

const encoder = new TextEncoder();

export function encodeBase64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

export async function readPrivateJwk(path) {
  const jwk = JSON.parse(await readFile(path, "utf8"));
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) {
    throw new Error(`${path} must contain a private P-256 JWK`);
  }
  return jwk;
}

export async function importPrivateP256(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export async function signEs256(privateKey, bytes) {
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    bytes,
  ));
  if (signature.byteLength !== 64) throw new Error("Web Crypto did not produce a 64-byte P-256 signature");
  return encodeBase64url(signature);
}

export function publisherPayload({ registry, coordinate, version, lockDigest, approvalIdentity }) {
  return encoder.encode([
    registry,
    coordinate,
    version,
    lockDigest,
    JSON.stringify(approvalIdentity),
  ].join("\0"));
}
