export class SurfaceHost {
  constructor(root, { onRequestClose } = {}) {
    if (!root) throw new Error("SurfaceHost requires a root element");
    this.root = root;
    this.onRequestClose = onRequestClose || (() => {});
    this.factories = new Map();
    this.controller = null;
    this.overlay = null;
    this.activeId = null;
  }

  register(id, factory) {
    if (!id || typeof factory !== "function") throw new TypeError("Surface registration requires an id and factory");
    this.factories.set(id, factory);
    return this;
  }

  open(id, payload = {}, context = {}) {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Surface is not installed: ${id}`);
    this.close();

    const presentation = payload.presentation || "panel";
    const overlay = document.createElement("div");
    overlay.className = "world-surface-overlay";
    overlay.dataset.presentation = presentation;
    overlay.setAttribute("aria-live", "polite");

    const scrim = document.createElement("button");
    scrim.type = "button";
    scrim.className = "world-surface-scrim";
    scrim.setAttribute("aria-label", "Close interface");
    scrim.addEventListener("click", () => this.requestClose());

    const frame = document.createElement("div");
    frame.className = "world-surface-frame";
    frame.setAttribute("role", "dialog");
    frame.setAttribute("aria-modal", "true");
    frame.setAttribute("aria-label", payload.label || id);

    overlay.append(scrim, frame);
    this.root.append(overlay);
    this.overlay = overlay;
    this.activeId = id;
    this.controller = factory({
      ...context,
      payload,
      root: frame,
      close: () => this.requestClose(),
    });
    this.controller?.update?.(context.session?.state);
    frame.querySelector("button, input, [tabindex]")?.focus();
  }

  requestClose() {
    return this.onRequestClose();
  }

  update(state) {
    this.controller?.update?.(state);
  }

  close() {
    this.controller?.destroy?.();
    this.controller = null;
    this.overlay?.remove();
    this.overlay = null;
    this.activeId = null;
  }

  destroy() {
    this.close();
    this.factories.clear();
  }
}
