#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "ai.greenways.browser_bridge";
const EXTENSION_ID = /^[a-p]{32}$/;

function argumentsMap(args) {
  const output = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    if (index + 1 >= args.length) throw new Error(`${key} requires a value`);
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
  throw new Error("The browser bridge installer currently supports macOS and Linux");
}

function shellQuote(value) {
  if (String(value).includes("\n") || String(value).includes("\r")) {
    throw new Error("Native host paths cannot contain newlines");
  }
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const options = argumentsMap(process.argv.slice(2));
const extensionId = String(options["extension-id"] || "").trim();
const browser = String(options.browser || "chrome").trim();
if (!EXTENSION_ID.test(extensionId)) {
  throw new Error("--extension-id must be the exact 32-character packaged Chrome extension id");
}

const home = resolve(options["greenways-home"] || join(homedir(), ".greenways"));
const credential = resolve(
  options.credential || join(home, "clients", "browser-bridge.json"),
);
if (!isAbsolute(home) || !isAbsolute(credential)) {
  throw new Error("Greenways home and credential paths must resolve to absolute paths");
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostScript = join(packageRoot, "bin", "greenways-browser-bridge-host.mjs");
const binDirectory = join(home, "bin");
const wrapper = join(binDirectory, "greenways-browser-bridge-host");
const manifestDir = manifestDirectory(browser);
const manifestPath = join(manifestDir, `${HOST_NAME}.json`);
const wrapperSource = `#!/bin/sh\nexport GREENWAYS_HOME=${shellQuote(home)}\nexport GREENWAYS_BROWSER_CREDENTIAL=${shellQuote(credential)}\nexec ${shellQuote(process.execPath)} ${shellQuote(hostScript)}\n`;

await mkdir(binDirectory, { recursive: true, mode: 0o700 });
await writeFile(wrapper, wrapperSource, { mode: 0o755 });
await chmod(wrapper, 0o755);
await mkdir(manifestDir, { recursive: true });
await writeFile(manifestPath, `${JSON.stringify({
  name: HOST_NAME,
  description: "Greenways OS authenticated local daemon browser bridge",
  path: wrapper,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2)}\n`, { mode: 0o600 });

console.log(`Installed ${HOST_NAME}`);
console.log(`Manifest: ${manifestPath}`);
console.log(`Greenways home: ${home}`);
console.log(`Credential: ${credential}`);
console.log(`Allowed extension: chrome-extension://${extensionId}/`);
