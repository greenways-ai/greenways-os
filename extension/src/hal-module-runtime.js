const APP_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const HAL_NAMESPACE = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const HAL_VAR = /^[a-zA-Z*+!_?<>=$%&.-][a-zA-Z0-9*+!_?<>=$%&.-]*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_MODULE_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_MODULE_RESOURCES = 256;

const DYNAMIC_NAMESPACE_SYMBOLS = new Set([
  "alias",
  "create-ns",
  "eval",
  "in-ns",
  "intern",
  "load-string",
  "ns-resolve",
  "remove-ns",
  "resolve",
]);

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function appId(value) {
  if (typeof value !== "string" || !APP_ID.test(value)) {
    throw new Error("HAL module id must be a lowercase app identifier");
  }
  return value;
}

function digest(value) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error("HAL module lock digest must be sha256:<64 lowercase hex characters>");
  }
  return value;
}

function namespace(value, label = "HAL namespace") {
  if (typeof value !== "string" || !HAL_NAMESPACE.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function qualifiedVar(value, label = "HAL entry") {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const separator = value.indexOf("/");
  if (separator <= 0 || separator !== value.lastIndexOf("/")) {
    throw new Error(`${label} must be a namespace-qualified symbol`);
  }
  const ns = namespace(value.slice(0, separator), `${label} namespace`);
  const name = value.slice(separator + 1);
  if (!HAL_VAR.test(name)) throw new Error(`${label} var name is invalid`);
  return { namespace: ns, name };
}

function isWhitespace(value) {
  return /\s/u.test(value);
}

function isDelimiter(value) {
  return "()[]{}'`~^@,".includes(value);
}

function scanTokens(source, label) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (isWhitespace(character)) {
      index += 1;
      continue;
    }
    if (character === ";") {
      index += 1;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === '"') {
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error(`${label} contains an unterminated string`);
      continue;
    }
    if (isDelimiter(character)) {
      tokens.push({ start: index, end: index + 1, value: character });
      index += 1;
      continue;
    }
    const start = index;
    while (index < source.length) {
      const next = source[index];
      if (isWhitespace(next) || next === ";" || next === '"' || isDelimiter(next)) break;
      index += 1;
    }
    if (start === index) {
      throw new Error(`${label} contains an unsupported token at character ${index}`);
    }
    tokens.push({ start, end: index, value: source.slice(start, index) });
  }
  return tokens;
}

function tokenNamespace(value) {
  if (!value || value.startsWith(":")) return null;
  const separator = value.indexOf("/");
  return separator > 0 ? value.slice(0, separator) : value;
}

function assertBoundedSource(tokens, expectedNamespace, label) {
  if (tokens.length < 4 || tokens[0].value !== "(" || tokens[1].value !== "ns") {
    throw new Error(`${label} must begin with an ns form`);
  }
  if (tokens[2].value !== expectedNamespace) {
    throw new Error(`${label} declares ${tokens[2].value}; expected ${expectedNamespace}`);
  }
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index].value === "(" && tokens[index + 1].value === "ns") {
      throw new Error(`${label} may contain only its leading ns form`);
    }
  }
  for (const [index, token] of tokens.entries()) {
    if (index === 1) continue;
    const value = token.value;
    const base = value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
    if (DYNAMIC_NAMESPACE_SYMBOLS.has(base)) {
      throw new Error(`${label} uses forbidden dynamic namespace symbol ${value}`);
    }
    const target = tokenNamespace(value);
    if (target?.startsWith("gw.os") || target?.startsWith("app.")) {
      throw new Error(`${label} cannot reference protected namespace ${target}`);
    }
    if (target?.startsWith("std.native")) {
      throw new Error(`${label} cannot call native host namespaces directly`);
    }
  }
}

function rewriteToken(value, mapping) {
  if (!value || value.startsWith(":")) return value;
  const exact = mapping.get(value);
  if (exact) return exact;
  const separator = value.indexOf("/");
  if (separator > 0) {
    const target = mapping.get(value.slice(0, separator));
    if (target) return `${target}${value.slice(separator)}`;
  }
  return value;
}

function applyTokenReplacements(source, tokens, mapping) {
  let output = "";
  let cursor = 0;
  for (const token of tokens) {
    const replacement = rewriteToken(token.value, mapping);
    if (replacement === token.value) continue;
    output += source.slice(cursor, token.start);
    output += replacement;
    cursor = token.end;
  }
  return output + source.slice(cursor);
}

function normalizeResources(value) {
  const input = plainObject(value, "HAL module resources");
  const entries = Object.entries(input);
  if (!entries.length) throw new Error("HAL module resources cannot be empty");
  if (entries.length > MAX_MODULE_RESOURCES) {
    throw new Error(`HAL module cannot contain more than ${MAX_MODULE_RESOURCES} resources`);
  }
  let bytes = 0;
  const output = {};
  for (const [name, source] of entries) {
    namespace(name, `HAL module resource ${name}`);
    if (typeof source !== "string") throw new TypeError(`HAL module resource ${name} must be source text`);
    bytes += new TextEncoder().encode(source).byteLength;
    if (bytes > MAX_MODULE_SOURCE_BYTES) {
      throw new Error("HAL module resources exceed the 4 MB staging limit");
    }
    output[name] = source;
  }
  return output;
}

export function rewriteHalModuleResources(id, generation, resources) {
  const safeId = appId(id);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("HAL module generation must be a positive integer");
  }
  const input = normalizeResources(resources);
  const root = `app.${safeId}.g${generation}`;
  const mapping = new Map(
    Object.keys(input).map((name) => [name, `${root}.${name}`]),
  );
  const rewritten = {};
  for (const [name, source] of Object.entries(input)) {
    const label = `HAL module resource ${name}`;
    const tokens = scanTokens(source, label);
    assertBoundedSource(tokens, name, label);
    rewritten[mapping.get(name)] = applyTokenReplacements(source, tokens, mapping);
  }
  return Object.freeze({
    root,
    mapping,
    resources: Object.freeze(rewritten),
  });
}

function normalizeStagedModule(value) {
  const input = plainObject(value, "Staged HAL module");
  const id = appId(input.id);
  const lockDigest = digest(input.lockDigest);
  const entry = qualifiedVar(input.entry);
  const resources = normalizeResources(input.resources);
  if (!(entry.namespace in resources)) {
    throw new Error(`HAL module entry namespace ${entry.namespace} is not staged`);
  }
  return Object.freeze({
    id,
    lockDigest,
    entry: `${entry.namespace}/${entry.name}`,
    entryNamespace: entry.namespace,
    entryName: entry.name,
    resources: Object.freeze(resources),
  });
}

function requireRuntimeMethod(runtime, method) {
  if (typeof runtime?.[method] !== "function") {
    throw new TypeError(`Hara runtime does not expose ${method}()`);
  }
}

function preparedTransaction(kind, descriptor, commit, rollback = () => {}) {
  let state = "prepared";
  return Object.freeze({
    kind,
    descriptor,
    commit() {
      if (state !== "prepared") throw new Error(`HAL module transaction is already ${state}`);
      const result = commit();
      state = "committed";
      return result;
    },
    rollback() {
      if (state !== "prepared") return false;
      rollback();
      state = "rolled-back";
      return true;
    },
  });
}

export function createHalModuleRuntime(runtime) {
  for (const method of [
    "currentNamespace",
    "evalInNamespace",
    "registerResource",
    "require",
  ]) requireRuntimeMethod(runtime, method);

  const installed = new Map();
  const counters = new Map();

  function nextGeneration(id) {
    const generation = (counters.get(id) ?? 0) + 1;
    counters.set(id, generation);
    return generation;
  }

  function stage(stagedValue) {
    const staged = normalizeStagedModule(stagedValue);
    const generation = nextGeneration(staged.id);
    const rewritten = rewriteHalModuleResources(staged.id, generation, staged.resources);
    const previousNamespace = runtime.currentNamespace();
    try {
      // evalInNamespace delegates to Runtime::use_namespace, which creates the
      // fresh generation root when it does not yet exist. Keeping this adapter
      // on the existing reviewed facade avoids patching the generated Wasm
      // bundle merely to expose aliases for methods it already composes.
      runtime.evalInNamespace(rewritten.root, "nil");
      for (const [name, source] of Object.entries(rewritten.resources)) {
        runtime.registerResource(name, source);
      }
      const entryResource = rewritten.mapping.get(staged.entryNamespace);
      runtime.require(entryResource);
      return Object.freeze({
        id: staged.id,
        generation,
        root: rewritten.root,
        lockDigest: staged.lockDigest,
        entry: `${entryResource}/${staged.entryName}`,
        staged,
      });
    } finally {
      runtime.evalInNamespace(previousNamespace, "nil");
    }
  }

  function prepareInstall(stagedValue) {
    const id = appId(stagedValue?.id);
    if (installed.has(id)) throw new Error(`HAL module is already installed: ${id}`);
    const descriptor = stage(stagedValue);
    return preparedTransaction("install", descriptor, () => {
      installed.set(id, descriptor);
      return descriptor;
    });
  }

  function prepareReload(idValue, stagedValue) {
    const id = appId(idValue);
    const current = installed.get(id);
    if (!current) throw new Error(`HAL module is not installed: ${id}`);
    const descriptor = stage(stagedValue ?? current.staged);
    if (descriptor.id !== id) throw new Error("Reloaded HAL module id does not match the installed app");
    return preparedTransaction("reload", descriptor, () => {
      installed.set(id, descriptor);
      return descriptor;
    });
  }

  function prepareRemove(idValue) {
    const id = appId(idValue);
    const current = installed.get(id);
    if (!current) throw new Error(`HAL module is not installed: ${id}`);
    return preparedTransaction("remove", current, () => {
      installed.delete(id);
      return current;
    });
  }

  function invoke(idValue, encodedArguments = []) {
    const id = appId(idValue);
    const current = installed.get(id);
    if (!current) throw new Error(`HAL module is not installed: ${id}`);
    if (!Array.isArray(encodedArguments) || encodedArguments.some((value) => typeof value !== "string")) {
      throw new TypeError("HAL module invocation arguments must be pre-encoded HAL forms");
    }
    const previousNamespace = runtime.currentNamespace();
    try {
      const suffix = encodedArguments.length ? ` ${encodedArguments.join(" ")}` : "";
      return runtime.evalInNamespace(current.root, `(${current.entry}${suffix})`);
    } finally {
      runtime.evalInNamespace(previousNamespace, "nil");
    }
  }

  return Object.freeze({
    prepareInstall,
    prepareReload,
    prepareRemove,
    installModule(staged) {
      return prepareInstall(staged).commit();
    },
    reloadModule(id, staged) {
      return prepareReload(id, staged).commit();
    },
    removeModule(id) {
      return prepareRemove(id).commit();
    },
    invoke,
    get(id) {
      return installed.get(appId(id)) ?? null;
    },
    list() {
      return [...installed.values()];
    },
  });
}
