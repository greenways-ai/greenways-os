const DEVTOOLS_NAMESPACE = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const KERNEL_METHOD = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_ARGUMENT_BYTES = 1024 * 1024;

function requiredString(value, label, maximum = 4096) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function boundedJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_ARGUMENT_BYTES) {
    throw new Error(`${label} exceeds the 1 MB DevTools limit`);
  }
  return value;
}

function boundedText(value, label) {
  const output = String(value);
  if (new TextEncoder().encode(output).byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`${label} exceeds the 1 MB DevTools limit`);
  }
  return output;
}

function publicModule(descriptor) {
  return Object.freeze({
    id: descriptor.id,
    generation: descriptor.generation,
    root: descriptor.root,
    lockDigest: descriptor.lockDigest,
    entry: descriptor.entry,
  });
}

export function createDevtoolsRuntime({ runtime, modules, invoke }) {
  for (const method of ["currentNamespace", "evalInNamespace"]) {
    if (typeof runtime?.[method] !== "function") {
      throw new TypeError(`DevTools runtime requires ${method}()`);
    }
  }
  if (!modules || typeof modules.list !== "function") {
    throw new TypeError("DevTools runtime requires the HAL module runtime");
  }
  if (typeof invoke !== "function") throw new TypeError("DevTools runtime requires the kernel invoker");

  function namespace(value = "gw.devtools") {
    const output = requiredString(value, "DevTools namespace", 180);
    if (!DEVTOOLS_NAMESPACE.test(output)) throw new Error("DevTools namespace is invalid");
    return output;
  }

  async function evaluate(request = {}) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("DevTools eval request must be an object");
    }
    for (const key of Object.keys(request)) {
      if (key !== "namespace" && key !== "source") {
        throw new Error(`DevTools eval request contains unsupported field ${key}`);
      }
    }
    const target = namespace(request.namespace ?? "gw.devtools");
    const source = requiredString(request.source, "DevTools source", MAX_SOURCE_BYTES);
    if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
      throw new Error("DevTools source exceeds the 1 MB limit");
    }
    const previous = runtime.currentNamespace();
    try {
      const output = runtime.evalInNamespace(target, source);
      return Object.freeze({ namespace: target, output: boundedText(output, "DevTools eval output") });
    } finally {
      runtime.evalInNamespace(previous, "nil");
    }
  }

  return Object.freeze({
    async call(method, args = []) {
      if (method === "devtools/status") {
        return Object.freeze({
          protocol: "greenways-devtools/0-alpha",
          currentNamespace: runtime.currentNamespace(),
          modules: Object.freeze(modules.list().map(publicModule)),
        });
      }
      if (method === "devtools/modules") {
        return Object.freeze(modules.list().map(publicModule));
      }
      if (method === "devtools/eval") {
        if (!Array.isArray(args) || args.length !== 1) throw new Error("devtools/eval requires one request object");
        return evaluate(args[0]);
      }
      if (method === "devtools/call") {
        if (!Array.isArray(args) || args.length < 1 || args.length > 2) {
          throw new Error("devtools/call requires a kernel method and optional argument array");
        }
        const target = requiredString(args[0], "DevTools kernel method", 120);
        if (!KERNEL_METHOD.test(target) || target.startsWith("devtools/")) {
          throw new Error("DevTools kernel method is invalid");
        }
        const callArgs = args[1] ?? [];
        if (!Array.isArray(callArgs)) throw new TypeError("DevTools kernel arguments must be an array");
        boundedJson(callArgs, "DevTools kernel arguments");
        return boundedJson(await invoke(target, callArgs), "DevTools kernel result");
      }
      throw new Error(`Unknown DevTools method: ${method}`);
    },
  });
}
