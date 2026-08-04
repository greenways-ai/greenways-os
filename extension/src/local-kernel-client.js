import { createGreenwaysInvoker } from "./greenways-runtime.js";
import { HaraWorldSession } from "./world-session.js";

export class LocalKernelClient {
  static async create({ effects } = {}) {
    return new LocalKernelClient({
      effects,
      invoke: await createGreenwaysInvoker(),
    });
  }

  constructor({ invoke, effects }) {
    this.invoke = invoke;
    this.session = new HaraWorldSession({ invoke, effects });
  }

  get state() {
    return this.session.state;
  }

  start() {
    return Promise.resolve(this);
  }

  refresh() {
    return Promise.resolve(this.state);
  }

  subscribe(listener) {
    return this.session.subscribe(listener);
  }

  call(method, args = []) {
    return Promise.resolve(this.invoke(method, args));
  }

  dispatch(method, args = []) {
    return this.session.dispatch(method, args);
  }

  destroy() {
    this.session.destroy();
  }
}
