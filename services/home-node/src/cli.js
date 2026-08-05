import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { runPersistentHomeNode } from "./daemon.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 58100;
const REQUEST_TIMEOUT_MS = 5_000;
const PACKAGE_URL = new URL("../package.json", import.meta.url);

export class HomeNodeCliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "HomeNodeCliError";
    this.exitCode = exitCode;
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HomeNodeCliError(`${label} cannot be empty`);
  }
  return value.trim();
}

function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HomeNodeCliError("Port must be an integer from 1 to 65535");
  }
  return port;
}

function optionValue(argv, index, inline, name) {
  if (inline !== undefined) return [inline, index];
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new HomeNodeCliError(`${name} requires a value`);
  }
  return [value, index + 1];
}

export function parseHomeNodeArguments(argv) {
  const options = {
    json: false,
    help: false,
    version: false,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith("-") || argument === "-") {
      positionals.push(argument);
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--version" || argument === "-V") {
      options.version = true;
      continue;
    }

    const match = argument.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!match) throw new HomeNodeCliError(`Unknown option: ${argument}`);
    const [, name, inline] = match;
    if (!["origin", "host", "port", "state-path", "name", "id"].includes(name)) {
      throw new HomeNodeCliError(`Unknown option: --${name}`);
    }
    const [value, consumedIndex] = optionValue(argv, index, inline, `--${name}`);
    index = consumedIndex;
    options[name.replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = value;
  }

  const command = options.version
    ? "version"
    : (options.help && positionals.length === 0 ? "help" : (positionals.shift() ?? "help"));
  return Object.freeze({ command, options: Object.freeze(options), operands: Object.freeze(positionals) });
}

function hostForOrigin(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function normalizeHomeNodeAdminOrigin(value) {
  let url;
  try {
    url = new URL(nonEmpty(value, "Home Node origin"));
  } catch (error) {
    if (error instanceof HomeNodeCliError) throw error;
    throw new HomeNodeCliError("Home Node origin must be a valid URL");
  }
  if (url.protocol !== "http:") {
    throw new HomeNodeCliError("The local Home Node control plane must use loopback HTTP");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new HomeNodeCliError("The Home Node control plane is available on loopback only");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new HomeNodeCliError("Enter only the loopback Home Node origin, without credentials or a path");
  }
  return url.origin;
}

export function resolveHomeNodeOrigin(options = {}, env = process.env) {
  if (options.origin || env.GREENWAYS_HOME_ORIGIN) {
    return normalizeHomeNodeAdminOrigin(options.origin || env.GREENWAYS_HOME_ORIGIN);
  }
  const host = nonEmpty(options.host || env.HOST || DEFAULT_HOST, "Host");
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new HomeNodeCliError("Home Node administration requires a loopback host");
  }
  const port = portNumber(options.port || env.PORT || DEFAULT_PORT);
  return normalizeHomeNodeAdminOrigin(`http://${hostForOrigin(host)}:${port}`);
}

function timeoutSignal() {
  return globalThis.AbortSignal?.timeout
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HomeNodeCliError(
      body.message || `Home Node request failed with HTTP ${response.status}`,
      response.status === 401 || response.status === 403 ? 4 : 3,
    );
  }
  return body;
}

function firstCookie(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  return values[0]?.split(";", 1)[0] ?? null;
}

export class HomeNodeAdminClient {
  constructor({ origin, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("Home Node CLI requires fetch");
    this.origin = normalizeHomeNodeAdminOrigin(origin);
    this.fetchImpl = fetchImpl;
    this.cookie = null;
    this.csrf = null;
  }

  async openSession() {
    if (this.cookie && this.csrf) return;
    let response;
    try {
      response = await this.fetchImpl(`${this.origin}/admin`, {
        method: "GET",
        headers: { accept: "text/html" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: timeoutSignal(),
      });
    } catch (error) {
      throw new HomeNodeCliError(`Home Node is not reachable at ${this.origin}: ${error.message}`, 3);
    }
    if (!response.ok) {
      throw new HomeNodeCliError(`Home Node control plane returned HTTP ${response.status}`, 3);
    }
    const html = await response.text();
    const cookie = firstCookie(response.headers);
    const csrf = html.match(/<meta name="gw-csrf" content="([^"]+)"/)?.[1];
    if (!cookie || !csrf) {
      throw new HomeNodeCliError("Home Node did not establish a local administrator session", 4);
    }
    this.cookie = cookie;
    this.csrf = csrf;
  }

  async request(path, { method = "GET" } = {}) {
    await this.openSession();
    const headers = {
      accept: "application/json",
      cookie: this.cookie,
      "sec-fetch-site": "same-origin",
      "x-greenways-csrf": this.csrf,
    };
    if (method !== "GET") headers.origin = this.origin;
    let response;
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: timeoutSignal(),
      });
    } catch (error) {
      throw new HomeNodeCliError(`Home Node request failed: ${error.message}`, 3);
    }
    return responseJson(response);
  }

  status() {
    return this.request("/greenways/admin/v1/status");
  }

  issuePairingCode() {
    return this.request("/greenways/admin/v1/pairing", { method: "POST" });
  }

  revoke(deviceId) {
    return this.request(`/greenways/admin/v1/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST",
    });
  }
}

function write(stream, value = "") {
  stream.write(`${value}\n`);
}

function jsonOutput(stream, value) {
  write(stream, JSON.stringify(value, null, 2));
}

function pairingLabel(pairing) {
  return pairing?.available
    ? `open until ${new Date(pairing.expiresAt).toLocaleString()}`
    : "closed";
}

function humanStatus(status, origin) {
  return [
    `${status.node.name}`,
    `  Status: running`,
    `  Origin: ${origin}`,
    `  Identity: ${status.node.keyId}`,
    `  State: ${status.durability}`,
    `  Pairing: ${pairingLabel(status.pairing)}`,
    `  Browsers: ${status.browsers.length}`,
    `  Services: ${status.services.length}`,
  ].join("\n");
}

function humanDevices(browsers) {
  if (!browsers.length) return "No browsers are paired.";
  return browsers.map((browser) => [
    `${browser.name}`,
    `  ID: ${browser.id}`,
    `  Paired: ${new Date(browser.pairedAt).toLocaleString()}`,
    `  Last seen: ${new Date(browser.lastSeenAt).toLocaleString()}`,
  ].join("\n")).join("\n\n");
}

function humanServices(services) {
  if (!services.length) return "No local services are advertised.";
  return services.map((service) => {
    const version = service.version ? ` v${service.version}` : "";
    const capabilities = service.capabilities?.length
      ? service.capabilities.join(", ")
      : "no capabilities";
    return `${service.name}${version}\n  ${service.kind} · ${service.status} · ${capabilities}`;
  }).join("\n\n");
}

function helpText() {
  return `Greenways Home Node

Usage:
  greenways-home run [options]
  greenways-home status [--json] [connection options]
  greenways-home open [connection options]
  greenways-home pair [--json] [connection options]
  greenways-home devices [--json] [connection options]
  greenways-home services [--json] [connection options]
  greenways-home revoke <browser-id> [--json] [connection options]

Connection options:
  --origin <url>       Loopback origin, default http://127.0.0.1:58100
  --host <host>        Loopback host used when --origin is omitted
  --port <port>        Home Node port, default 58100

Run options:
  --state-path <path>  Durable state-file path
  --name <name>        Name for a newly created Home Node
  --id <id>            Identifier for a newly created Home Node

Other:
  --json               Emit machine-readable output
  -h, --help           Show this help
  -V, --version        Show the service package version

Homebrew owns background lifecycle when installed as a service. The command
manages the running node without exposing its local control plane to the LAN.`;
}

async function packageVersion() {
  const packageRecord = JSON.parse(await readFile(PACKAGE_URL, "utf8"));
  return packageRecord.version;
}

export function launchHomeNodeAdmin(url, {
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  const command = platform === "darwin"
    ? ["open", [url]]
    : platform === "linux"
      ? ["xdg-open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : null;
  if (!command) throw new HomeNodeCliError(`Opening a browser is not supported on ${platform}`);
  const child = spawnImpl(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();
}

function runEnvironment(options, env) {
  const next = { ...env };
  if (options.host) next.HOST = nonEmpty(options.host, "Host");
  if (options.port) next.PORT = String(portNumber(options.port));
  if (options.statePath) next.GREENWAYS_HOME_STATE_PATH = nonEmpty(options.statePath, "State path");
  if (options.name) next.GREENWAYS_HOME_NAME = nonEmpty(options.name, "Home Node name");
  if (options.id) next.GREENWAYS_HOME_ID = nonEmpty(options.id, "Home Node ID");
  return next;
}

export async function runHomeNodeCli(argv, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
  stderr = process.stderr,
  runNode = runPersistentHomeNode,
  openExternal = launchHomeNodeAdmin,
} = {}) {
  const { command, options, operands } = parseHomeNodeArguments(argv);
  if (options.help && command !== "help") {
    write(stdout, helpText());
    return 0;
  }

  if (command === "help") {
    write(stdout, helpText());
    return 0;
  }
  if (command === "version") {
    write(stdout, await packageVersion());
    return 0;
  }
  if (command === "run") {
    if (operands.length) throw new HomeNodeCliError("The run command does not accept positional arguments");
    await runNode({ env: runEnvironment(options, env) });
    return 0;
  }

  const origin = resolveHomeNodeOrigin(options, env);
  if (command === "open") {
    if (operands.length) throw new HomeNodeCliError("The open command does not accept positional arguments");
    await openExternal(`${origin}/admin`);
    write(stdout, `Opened ${origin}/admin`);
    return 0;
  }

  const client = new HomeNodeAdminClient({ origin, fetchImpl });
  if (command === "status") {
    if (operands.length) throw new HomeNodeCliError("The status command does not accept positional arguments");
    const status = await client.status();
    if (options.json) jsonOutput(stdout, { origin, ...status });
    else write(stdout, humanStatus(status, origin));
    return 0;
  }
  if (command === "pair") {
    if (operands.length) throw new HomeNodeCliError("The pair command does not accept positional arguments");
    const pairing = await client.issuePairingCode();
    if (options.json) jsonOutput(stdout, pairing);
    else write(stdout, `${pairing.code}\nExpires: ${new Date(pairing.expiresAt).toLocaleString()}`);
    return 0;
  }
  if (command === "devices") {
    if (operands.length) throw new HomeNodeCliError("The devices command does not accept positional arguments");
    const status = await client.status();
    if (options.json) jsonOutput(stdout, status.browsers);
    else write(stdout, humanDevices(status.browsers));
    return 0;
  }
  if (command === "services") {
    if (operands.length) throw new HomeNodeCliError("The services command does not accept positional arguments");
    const status = await client.status();
    if (options.json) jsonOutput(stdout, status.services);
    else write(stdout, humanServices(status.services));
    return 0;
  }
  if (command === "revoke") {
    if (operands.length !== 1) throw new HomeNodeCliError("Usage: greenways-home revoke <browser-id>");
    const result = await client.revoke(operands[0]);
    if (options.json) jsonOutput(stdout, result);
    else write(stdout, `Revoked ${result.deviceName} (${result.deviceId}).`);
    return 0;
  }

  write(stderr, `Unknown command: ${command}`);
  throw new HomeNodeCliError("Run greenways-home --help to see available commands");
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    return await runHomeNodeCli(argv, dependencies);
  } catch (error) {
    const stderr = dependencies.stderr ?? process.stderr;
    const message = error instanceof Error ? error.message : String(error);
    write(stderr, `greenways-home: ${message}`);
    return error instanceof HomeNodeCliError ? error.exitCode : 1;
  }
}
