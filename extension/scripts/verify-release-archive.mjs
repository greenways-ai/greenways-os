import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readExtensionIdentity, verifyManifestIdentity } from "./extension-identity.mjs";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceManifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));
const sourceIdentity = await verifyManifestIdentity(extensionRoot, sourceManifest);
const archivePath = resolve(process.argv[2]
  || join(extensionRoot, "release", `greenways-os-extension-v${sourceManifest.version}.zip`));

const temporaryRoot = await mkdtemp(join(tmpdir(), "greenways-release-smoke-"));
try {
  await execFileAsync("unzip", ["-q", archivePath, "-d", temporaryRoot]);
  const manifest = JSON.parse(await readFile(join(temporaryRoot, "manifest.json"), "utf8"));
  const archivedIdentity = await readExtensionIdentity(temporaryRoot);
  await verifyManifestIdentity(temporaryRoot, manifest);
  if (JSON.stringify(archivedIdentity) !== JSON.stringify(sourceIdentity)) {
    throw new Error("Release archive extension identity does not match reviewed source identity");
  }
  if (manifest.content_scripts?.[0]?.matches?.[0] !== "https://playground.hara-lang.org/*") {
    throw new Error("Release archive does not contain the exact production Playground origin");
  }
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${temporaryRoot}`,
      `--load-extension=${temporaryRoot}`,
    ],
  });
  try {
    let worker = context.serviceWorkers().find((candidate) => (
      candidate.url().endsWith("/dist/background.js")
    ));
    if (!worker) {
      worker = await context.waitForEvent("serviceworker", {
        predicate: (candidate) => candidate.url().endsWith("/dist/background.js"),
        timeout: 15_000,
      });
    }
    const runtimeIdentity = await worker.evaluate(() => ({
      id: chrome.runtime.id,
      key: chrome.runtime.getManifest().key,
      version: chrome.runtime.getManifest().version,
    }));
    if (runtimeIdentity.id !== sourceIdentity.extensionId || runtimeIdentity.key !== sourceIdentity.manifestKey) {
      throw new Error(`Loaded extension identity ${runtimeIdentity.id} does not match ${sourceIdentity.extensionId}`);
    }
    const version = runtimeIdentity.version;
    if (version !== manifest.version) throw new Error(`Loaded version ${version} does not match ${manifest.version}`);
  } finally {
    await context.close();
  }
  process.stdout.write(`Verified installed Greenways OS extension v${manifest.version}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
