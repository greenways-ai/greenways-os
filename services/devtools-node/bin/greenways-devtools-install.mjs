#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "ai.greenways.devtools";
const EXTENSION_ID = /^[a-p]{32}$/;

function argumentsMap(args) {
  const output = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    output[key.slice(2)] = args[++index];
  }
  return output;
}

function manifestDirectory(browser) {
  if (process.platform === "darwin") {
    const names = {
      chrome: "Google/Chrome",
      "chrome-beta": "Google/Chrome Beta",
      chromium: "Chromium",
      brave: "BraveSoftware/Brave-Browser",
    };
    if (!names[browser]) throw new Error(`Unsupported macOS browser: ${browser}`);
    return join(homedir(), "Library/Application Support", names[browser], "NativeMessagingHosts");
  }
  if (process.platform === "linux") {
    const names = {
      chrome: "google-chrome",
      "chrome-beta": "google-chrome-beta",
      chromium: "chromium",
      brave: "BraveSoftware/Brave-Browser",
    };
    if (!names[browser]) throw new Error(`Unsupported Linux browser: ${browser}`);
    return join(homedir(), ".config", names[browser], "NativeMessagingHosts");
  }
  throw new Error("The DevTools host installer currently supports macOS and Linux");
}

const options = argumentsMap(process.argv.slice(2));
const extensionId = String(options["extension-id"] || "").trim();
const browser = String(options.browser || "chrome").trim();
if (!EXTENSION_ID.test(extensionId)) {
  throw new Error("--extension-id must be the exact 32-character Chrome extension id");
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostScript = join(packageRoot, "bin/greenways-devtools-host.mjs");
const binDirectory = join(homedir(), ".greenways", "bin");
const wrapper = join(binDirectory, "greenways-devtools-host");
const manifestDir = manifestDirectory(browser);
const manifestPath = join(manifestDir, `${HOST_NAME}.json`);

await mkdir(binDirectory, { recursive: true, mode: 0o700 });
await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(hostScript)}\n`, { mode: 0o755 });
await chmod(wrapper, 0o755);
await mkdir(manifestDir, { recursive: true });
await writeFile(manifestPath, `${JSON.stringify({
  name: HOST_NAME,
  description: "Greenways OS loopback RESP bridge",
  path: wrapper,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2)}\n`, { mode: 0o600 });

console.log(`Installed ${HOST_NAME}`);
console.log(`Manifest: ${manifestPath}`);
console.log(`Allowed extension: chrome-extension://${extensionId}/`);
