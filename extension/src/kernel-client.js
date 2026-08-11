export const KERNEL_PROTOCOL = "greenways-kernel/0-alpha";

export const KERNEL_MESSAGE_TYPES = Object.freeze({
  ATTACH: "greenways/kernel/attach",
  CALL: "greenways/kernel/call",
  DISPATCH: "greenways/kernel/dispatch",
  EFFECT: "greenways/kernel/effect",
  UPDATE: "greenways/kernel/update",
});

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function defaultRandomId(prefix) {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return `${prefix}/${webCrypto.randomUUID()}`;
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error("Web Crypto is required to create kernel request identifiers");
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  return `${prefix}/${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isKernelHostSender(sender, runtime) {
  return sender?.id === runtime?.id
    && sender.documentId === undefined
    && sender.tab === undefined;
}

export function validateKernelResponse(response, operation = "Kernel request") {
  if (!plainObject(response)) throw new Error(`${operation} returned no response`);
  if (response.protocol !== KERNEL_PROTOCOL) throw new Error(`${operation} returned an unsupported protocol`);
  if (response.ok !== true) {
    const error = new Error(response.error || `${operation} failed`);
    if (typeof response.code === "string") error.code = response.code;
    throw error;
  }
  return response;
}

function responseSnapshot(response) {
  const snapshot = response.snapshot ?? response;
  if (!plainObject(snapshot) || !("state" in snapshot)) {
    throw new Error("Kernel response did not include state");
  }
  return snapshot;
}

function responseResult(response) {
  if ("result" in response) return response.result;
  const snapshot = responseSnapshot(response);
  return { state: snapshot.state, effects: response.effects ?? [] };
}

export class KernelClient {
  constructor({
    runtime = globalThis.chrome?.runtime,
    effects,
    clientKind = "page",
    contextId,
    randomId = defaultRandomId,
  } = {}) {
    if (!runtime?.sendMessage || !runtime?.onMessage?.addListener || !runtime?.onMessage?.removeListener) {
      throw new TypeError("Kernel client requires the Chrome extension runtime messaging API");
    }
    if (!effects || typeof effects.run !== "function") {
      throw new TypeError("Kernel client requires an injected effect runtime");
    }
    if (typeof randomId !== "function") throw new TypeError("Kernel client random id provider must be a function");

    this.runtime = runtime;
    this.effects = effects;
    this.clientKind = nonEmptyString(clientKind, "Kernel client kind");
    this.randomId = randomId;
    this.contextId = contextId === undefined
      ? nonEmptyString(randomId("context"), "Kernel context id")
      : nonEmptyString(contextId, "Kernel context id");
    this.state = undefined;
    this.globalRevision = -1;
    this.contextRevision = -1;
    this.listeners = new Set();
    this.started = false;
    this.destroyed = false;
    this.startPending = null;
    this.handleRuntimeMessage = this.handleRuntimeMessage.bind(this);
  }

  baseMessage(type) {
    return {
      protocol: KERNEL_PROTOCOL,
      type,
      contextId: this.contextId,
      clientKind: this.clientKind,
    };
  }

  send(message, operation) {
    if (this.destroyed) return Promise.reject(new Error("Kernel client was destroyed"));
    return new Promise((resolve, reject) => {
      try {
        // Use callbacks instead of relying on promise-returning listeners so this
        // remains compatible with Chrome 116's runtime.onMessage semantics.
        this.runtime.sendMessage(message, (response) => {
          const lastError = this.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message || String(lastError)));
            return;
          }
          try {
            resolve(validateKernelResponse(response, operation));
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  start() {
    if (this.destroyed) return Promise.reject(new Error("Kernel client was destroyed"));
    if (this.started) return Promise.resolve(this);
    if (this.startPending) return this.startPending;

    this.runtime.onMessage.addListener(this.handleRuntimeMessage);
    this.startPending = this.send(this.baseMessage(KERNEL_MESSAGE_TYPES.ATTACH), "Kernel attach")
      .then((response) => {
        if (this.destroyed) throw new Error("Kernel client was destroyed");
        const snapshot = responseSnapshot(response);
        this.contextId = nonEmptyString(snapshot.contextId, "Kernel snapshot context id");
        this.acceptSnapshot(snapshot, {
          method: "app/bootstrap",
          source: "attach",
        }, { authoritative: true });
        this.started = true;
        return this;
      })
      .catch((error) => {
        this.runtime.onMessage.removeListener(this.handleRuntimeMessage);
        throw error;
      })
      .finally(() => {
        this.startPending = null;
      });
    return this.startPending;
  }

  async refresh() {
    await this.start();
    const response = await this.send(this.baseMessage(KERNEL_MESSAGE_TYPES.ATTACH), "Kernel refresh");
    const snapshot = responseSnapshot(response);
    if (snapshot.contextId !== this.contextId) {
      throw new Error("Kernel refresh returned another browser document context");
    }
    this.acceptSnapshot(snapshot, {
      method: "app/restore",
      source: "refresh",
    }, { authoritative: true });
    return this.state;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Session listener must be a function");
    if (this.destroyed) throw new Error("Kernel client was destroyed");
    this.listeners.add(listener);
    if (this.state !== undefined) {
      listener(this.state, {
        method: "app/bootstrap",
        source: "snapshot",
        globalRevision: this.globalRevision,
        contextRevision: this.contextRevision,
      });
    }
    return () => this.listeners.delete(listener);
  }

  async call(method, args = []) {
    nonEmptyString(method, "Kernel method");
    if (!Array.isArray(args)) throw new TypeError("Kernel arguments must be an array");
    await this.start();
    const response = await this.send({
      ...this.baseMessage(KERNEL_MESSAGE_TYPES.CALL),
      method,
      args,
    }, `Kernel call ${method}`);
    if ("result" in response) return response.result;
    if ("value" in response) return response.value;
    throw new Error(`Kernel call ${method} returned no result`);
  }

  async dispatch(method, args = []) {
    nonEmptyString(method, "Kernel method");
    if (!Array.isArray(args)) throw new TypeError("Kernel arguments must be an array");
    await this.start();
    const requestId = nonEmptyString(this.randomId("request"), "Kernel request id");
    const response = await this.send({
      ...this.baseMessage(KERNEL_MESSAGE_TYPES.DISPATCH),
      requestId,
      method,
      args,
    }, `Kernel dispatch ${method}`);
    if (this.destroyed) throw new Error("Kernel client was destroyed");

    const result = responseResult(response);
    const accepted = this.acceptSnapshot(responseSnapshot(response), {
      method,
      source: "dispatch",
      requestId,
      result,
    }, { notify: false });
    const effects = response.effects ?? result?.effects ?? [];
    let effectError;
    try {
      await this.effects.run(effects, {
        session: this,
        method,
        requestId,
        result,
      });
    } catch (error) {
      effectError = error;
    }
    if (accepted) {
      this.notify({
        method,
        source: "dispatch",
        requestId,
        result,
        effectError,
      });
    }
    if (effectError) throw effectError;
    return result;
  }

  acceptSnapshot(snapshot, metadata = {}, { notify = true, authoritative = false } = {}) {
    if (!plainObject(snapshot) || !("state" in snapshot)) throw new Error("Kernel snapshot did not include state");
    if (snapshot.contextId !== this.contextId) {
      throw new Error("Kernel snapshot belongs to another browser document context");
    }
    const globalRevision = revision(snapshot.globalRevision, "Kernel global revision");
    const contextRevision = revision(snapshot.contextRevision, "Kernel context revision");

    if (globalRevision < this.globalRevision || contextRevision < this.contextRevision) return false;
    if (
      this.state !== undefined
      && globalRevision === this.globalRevision
      && contextRevision === this.contextRevision
      && !authoritative
    ) return false;

    this.state = snapshot.state;
    this.globalRevision = globalRevision;
    this.contextRevision = contextRevision;
    if (notify) this.notify(metadata);
    return true;
  }

  notify(metadata = {}) {
    const event = {
      ...metadata,
      globalRevision: this.globalRevision,
      contextRevision: this.contextRevision,
    };
    for (const listener of this.listeners) listener(this.state, event);
  }

  handleRuntimeMessage(message, sender, sendResponse) {
    if (this.destroyed
      || !plainObject(message)
      || message.protocol !== KERNEL_PROTOCOL
      || !isKernelHostSender(sender, this.runtime)) return false;

    if (message.type === KERNEL_MESSAGE_TYPES.UPDATE) {
      try {
        if (message.contextId === this.contextId && "state" in message) {
          const metadata = {
            method: message.method || "kernel/update",
            source: message.rollback ? "rollback" : "broadcast",
            requestId: message.requestId,
          };
          if (message.rollback) {
            const snapshot = responseSnapshot(message);
            this.state = snapshot.state;
            this.globalRevision = revision(snapshot.globalRevision, "Kernel global revision");
            this.contextRevision = revision(snapshot.contextRevision, "Kernel context revision");
            this.notify(metadata);
          } else {
            this.acceptSnapshot(responseSnapshot(message), metadata);
          }
        } else if (
          Array.isArray(message.globalInstalled)
          && Number.isSafeInteger(message.globalRevision)
          && message.globalRevision > this.globalRevision
          && this.state
        ) {
          const installedIds = new Set(message.globalInstalled.map(({ id }) => id));
          const activeAppId = this.state.apps?.active;
          const activeAppRemoved = typeof activeAppId === "string"
            && activeAppId
            && !installedIds.has(activeAppId);
          const packagedSurfaceRemoved = activeAppRemoved
            && this.state.surface?.payload?.appId === activeAppId;
          this.state = {
            ...this.state,
            apps: {
              ...(this.state.apps ?? {}),
              installed: message.globalInstalled,
              ...(activeAppRemoved ? { active: null } : {}),
            },
            ...(packagedSurfaceRemoved ? { surface: { active: null, payload: null } } : {}),
          };
          this.globalRevision = message.globalRevision;
          this.notify({
            method: message.method || "kernel/global-update",
            source: "broadcast",
            requestId: message.requestId,
          });
        }
      } catch (error) {
        // A malformed or stale broadcast must not break other runtime listeners.
        console.error("Greenways kernel update was rejected", error);
      }
      return false;
    }

    if (message.type !== KERNEL_MESSAGE_TYPES.EFFECT) return false;
    if (message.contextId !== this.contextId) return false;
    Promise.resolve()
      .then(async () => {
        const previousState = this.state;
        if (message.tentativeState !== undefined) this.state = message.tentativeState;
        try {
          await this.effects.run(message.effects ?? [], {
            session: this,
            method: message.method || "kernel/effect",
            requestId: message.requestId,
            result: message.result,
          });
        } catch (error) {
          this.state = previousState;
          throw error;
        }
        return { protocol: KERNEL_PROTOCOL, ok: true, requestId: message.requestId };
      })
      .then(sendResponse)
      .catch((error) => sendResponse({
        protocol: KERNEL_PROTOCOL,
        ok: false,
        requestId: message.requestId,
        error: error?.message || String(error),
      }));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.started = false;
    this.runtime.onMessage.removeListener(this.handleRuntimeMessage);
    this.listeners.clear();
  }
}
