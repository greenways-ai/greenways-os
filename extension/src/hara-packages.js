import { parseEDNString } from "edn-data";
import { unzipSync } from "fflate";

const ednOptions = {
  mapAs: "object", setAs: "array", listAs: "array",
  keywordAs: "string", charAs: "string", objectKeysAs: "string",
};

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function sha256(bytes) {
  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

function packageUrl(entry) {
  return entry["distribution/url"] ?? entry["packages/url"] ?? entry["release-url"] ?? entry.url;
}

function packageDigest(entry) {
  return entry["harp-sha256"] ?? entry.sha256;
}

function safeArchivePath(path) {
  return path && !path.startsWith("/") && !path.includes("\\")
    && path.split("/").every((part) => part && part !== "." && part !== "..");
}

export async function loadLockedPackageResources(lockSource, request = (...args) => globalThis.fetch(...args)) {
  const lock = parseEDNString(String(lockSource), ednOptions);
  if (lock["lock/format"] !== 2) throw new Error("project.lock.edn requires :lock/format 2");
  const staged = {};
  for (const [coordinate, entry] of Object.entries(lock.packages ?? {})) {
    const url = packageUrl(entry);
    const digest = packageDigest(entry);
    if (!url || !digest) throw new Error(`Locked package ${coordinate} is missing its URL or SHA-256`);
    const response = await request(url);
    if (!response.ok) throw new Error(`Locked package ${coordinate} failed: ${response.status}`);
    const archive = new Uint8Array(await response.arrayBuffer());
    if (entry.size !== undefined && archive.byteLength !== entry.size) throw new Error(`Locked package ${coordinate} size mismatch`);
    if (await sha256(archive) !== digest) throw new Error(`Locked package ${coordinate} digest mismatch`);
    const files = unzipSync(archive);
    if (!files["package.edn"]) throw new Error(`Locked package ${coordinate} has no package.edn`);
    for (const path of Object.keys(files)) {
      if (!safeArchivePath(path)) throw new Error(`Locked package ${coordinate} contains an unsafe path`);
    }
    const manifest = parseEDNString(new TextDecoder().decode(files["package.edn"]), ednOptions);
    for (const [path, file] of Object.entries(manifest.files ?? {})) {
      const bytes = files[path];
      if (!bytes) throw new Error(`Locked package ${coordinate} is missing ${path}`);
      if (file.size !== bytes.byteLength || await sha256(bytes) !== file.sha256) {
        throw new Error(`Locked package ${coordinate} failed file verification: ${path}`);
      }
    }
    for (const [namespace, path] of Object.entries(manifest.resources ?? {})) {
      if (staged[namespace]) throw new Error(`Duplicate locked HAL namespace: ${namespace}`);
      const bytes = files[path];
      if (!bytes) throw new Error(`Locked package ${coordinate} is missing resource ${path}`);
      staged[namespace] = new TextDecoder().decode(bytes);
    }
  }
  return staged;
}