function effectKey(service, method) {
  return `${service}/${method}`;
}

export class EffectRuntime {
  constructor() {
    this.handlers = new Map();
  }

  register(service, method, handler) {
    if (typeof handler !== "function") throw new TypeError("Effect handler must be a function");
    this.handlers.set(effectKey(service, method), handler);
    return this;
  }

  async run(effects = [], context = {}) {
    for (const effect of effects) {
      const handler = this.handlers.get(effectKey(effect.effect, effect.method));
      if (!handler) throw new Error(`No host handler for ${effect.effect}/${effect.method}`);
      await handler(effect.args ?? [], { ...context, effect });
    }
  }
}

export class HaraWorldSession {
  constructor({ invoke, effects = new EffectRuntime() }) {
    if (typeof invoke !== "function") throw new TypeError("Hara session requires an invoke function");
    this.invoke = invoke;
    this.effects = effects;
    this.listeners = new Set();
    this.state = invoke("app/bootstrap", []);
    this.destroyed = false;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Session listener must be a function");
    this.listeners.add(listener);
    listener(this.state, { method: "app/bootstrap" });
    return () => this.listeners.delete(listener);
  }

  async dispatch(method, args = []) {
    if (this.destroyed) throw new Error("Hara session was destroyed");
    const result = this.invoke(method, [this.state, ...args]);
    if (!result || typeof result !== "object" || !("state" in result)) {
      throw new Error(`Hara method ${method} did not return session state`);
    }
    this.state = result.state;
    await this.effects.run(result.effects ?? [], { session: this, method, result });
    for (const listener of this.listeners) listener(this.state, { method, result });
    return result;
  }

  destroy() {
    this.destroyed = true;
    this.listeners.clear();
  }
}
