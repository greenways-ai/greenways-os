import { resolve } from "node:path";
import { AssetRegistry, ASSET_STATES } from "./asset-registry.js";

const HELP = `Greenways Assets

Usage:
  greenways-assets init [--root PATH]
  greenways-assets import FILE [metadata options]
  greenways-assets show ID_OR_ALIAS [--root PATH]
  greenways-assets list [--state STATE] [--project NAME] [--collection NAME]
  greenways-assets history ID_OR_ALIAS [--root PATH]
  greenways-assets verify ID_OR_ALIAS [--root PATH]
  greenways-assets state ID_OR_ALIAS STATE [--note TEXT]
  greenways-assets curate|approve|publish|deprecate ID_OR_ALIAS [--note TEXT]

Import metadata options:
  --title TEXT
  --project NAME
  --collection NAME       Repeatable
  --alias PATH
  --tag NAME              Repeatable
  --source-kind NAME
  --provider NAME
  --generation-id ID
  --prompt-sha256 DIGEST  Stores only the digest, never prompt text
  --parent ASSET_ID
  --operation NAME
  --instruction TEXT

Global options:
  --root PATH             Defaults to GREENWAYS_ASSETS_ROOT or .greenways-assets
  --help

States: ${ASSET_STATES.join(", ")}
`;

function parseArguments(argv) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const equal = argument.indexOf("=");
    let name;
    let value;
    if (equal !== -1) {
      name = argument.slice(2, equal);
      value = argument.slice(equal + 1);
    } else {
      name = argument.slice(2);
      if (name === "help") {
        value = true;
      } else {
        value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
        index += 1;
      }
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }
  return { positional, options };
}

function one(options, name, fallback = undefined) {
  const values = options.get(name);
  if (!values?.length) return fallback;
  if (values.length > 1) throw new Error(`--${name} may only be supplied once`);
  return values[0];
}

function many(options, name) {
  return options.get(name) ?? [];
}

function ensureKnownOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown option --${name}`);
  }
}

function outputJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCli(argv, {
  stdout = process.stdout,
  registryFactory = (root) => new AssetRegistry(root),
  environment = process.env,
  cwd = process.cwd(),
} = {}) {
  const { positional, options } = parseArguments(argv);
  const command = positional[0];
  if (!command || options.has("help") || command === "help") {
    stdout.write(HELP);
    return { help: true };
  }
  const root = resolve(cwd, one(options, "root", environment.GREENWAYS_ASSETS_ROOT ?? ".greenways-assets"));
  const registry = registryFactory(root);
  const common = new Set(["root"]);

  if (command === "init") {
    ensureKnownOptions(options, common);
    if (positional.length !== 1) throw new Error("init does not accept positional arguments");
    const result = await registry.init();
    outputJson(stdout, result);
    return result;
  }

  if (command === "import") {
    const allowed = new Set([
      ...common,
      "title", "project", "collection", "alias", "tag", "source-kind", "provider",
      "generation-id", "prompt-sha256", "parent", "operation", "instruction",
    ]);
    ensureKnownOptions(options, allowed);
    const file = positional[1];
    if (!file || positional.length !== 2) throw new Error("import requires exactly one file path");
    const result = await registry.importFile(resolve(cwd, file), {
      title: one(options, "title"),
      project: one(options, "project"),
      collections: many(options, "collection"),
      alias: one(options, "alias"),
      tags: many(options, "tag"),
      sourceKind: one(options, "source-kind"),
      provider: one(options, "provider"),
      generationId: one(options, "generation-id"),
      promptSha256: one(options, "prompt-sha256"),
      parent: one(options, "parent"),
      operation: one(options, "operation"),
      instruction: one(options, "instruction"),
    });
    outputJson(stdout, result);
    return result;
  }

  if (command === "show") {
    ensureKnownOptions(options, common);
    if (positional.length !== 2) throw new Error("show requires exactly one asset ID or alias");
    const result = await registry.read(positional[1]);
    outputJson(stdout, result);
    return result;
  }

  if (command === "history") {
    ensureKnownOptions(options, common);
    if (positional.length !== 2) throw new Error("history requires exactly one asset ID or alias");
    const result = await registry.history(positional[1]);
    outputJson(stdout, result);
    return result;
  }

  if (command === "verify") {
    ensureKnownOptions(options, common);
    if (positional.length !== 2) throw new Error("verify requires exactly one asset ID or alias");
    const result = await registry.verify(positional[1]);
    outputJson(stdout, result);
    return result;
  }

  if (command === "list") {
    const allowed = new Set([...common, "state", "project", "collection"]);
    ensureKnownOptions(options, allowed);
    if (positional.length !== 1) throw new Error("list does not accept positional arguments");
    const result = await registry.list({
      state: one(options, "state"),
      project: one(options, "project"),
      collection: one(options, "collection"),
    });
    outputJson(stdout, result);
    return result;
  }

  const shorthand = new Map([
    ["curate", "curated"],
    ["approve", "approved"],
    ["publish", "published"],
    ["deprecate", "deprecated"],
  ]);
  if (command === "state" || shorthand.has(command)) {
    const allowed = new Set([...common, "note"]);
    ensureKnownOptions(options, allowed);
    const reference = positional[1];
    const nextState = command === "state" ? positional[2] : shorthand.get(command);
    const expectedLength = command === "state" ? 3 : 2;
    if (!reference || !nextState || positional.length !== expectedLength) {
      throw new Error(command === "state"
        ? "state requires an asset ID or alias and a target state"
        : `${command} requires exactly one asset ID or alias`);
    }
    const result = await registry.transition(reference, nextState, { note: one(options, "note") });
    outputJson(stdout, result);
    return result;
  }

  throw new Error(`unknown command ${JSON.stringify(command)}`);
}

export { HELP };
