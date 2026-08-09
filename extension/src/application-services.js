import { getAppManifest } from "./app-catalog.js";
import { activeCapabilityGrant } from "./core-services.js";

const SERVICE_POLICY = Object.freeze({
  "tahto.semantic": Object.freeze({
    open: "tahto/read",
    get: "tahto/read",
    query: "tahto/read",
    heads: "tahto/read",
    transact: "tahto/write",
    sync: "tahto/write",
  }),
  "hestia.control": Object.freeze({
    propose: "hestia/propose",
    approve: "hestia/approve",
    execute: "hestia/execute",
    cancel: "hestia/execute",
    status: "hestia/propose",
    receipt: "hestia/propose",
  }),
});

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

function closedRequest(value) {
  const input = plainObject(value, "Application service request");
  for (const key of Object.keys(input)) {
    if (!new Set(["service", "operation", "arguments"]).has(key)) {
      throw new Error(`Application service request contains unsupported field ${key}`);
    }
  }
  if (typeof input.service !== "string" || typeof input.operation !== "string") {
    throw new Error("Application service and operation must be strings");
  }
  if (!Array.isArray(input.arguments)) throw new Error("Application service arguments must be an array");
  return input;
}

function routeFor(request) {
  const operations = SERVICE_POLICY[request.service];
  const capability = operations?.[request.operation];
  if (!capability) throw new Error(`Application service route is not available: ${request.service}/${request.operation}`);
  return { capability, family: request.service === "tahto.semantic" ? "semantic" : "control" };
}

export function createApplicationServiceRouter({ capabilityAuthority, semantic, control }) {
  if (typeof capabilityAuthority?.assert !== "function") {
    throw new TypeError("Application service router requires capability authority");
  }
  if (typeof semantic?.call !== "function" || typeof control?.call !== "function") {
    throw new TypeError("Application service router requires semantic and control ports");
  }

  return Object.freeze({
    async call(appId, request, { installed = [], grants = [] } = {}) {
      const manifest = getAppManifest(appId);
      if (!manifest?.project) throw new Error(`Application is not a HAL project: ${appId}`);
      const approved = installed.find((candidate) => candidate?.id === appId);
      if (!approved?.project || approved.project.digest !== manifest.project.digest) {
        throw new Error(`Application project is not installed at its current digest: ${appId}`);
      }
      const input = closedRequest(request);
      const route = routeFor(input);
      if (!manifest.capabilities.includes(route.capability)) {
        throw new Error(`${appId} does not declare ${route.capability}`);
      }
      await capabilityAuthority.assert(
        { appId, capability: route.capability },
        { installed },
      );
      if (!activeCapabilityGrant(grants, approved, route.capability)) {
        throw new Error(`${appId} has no active ${route.capability} grant`);
      }
      const port = route.family === "semantic" ? semantic : control;
      return port.call(input.operation, input.arguments, {
        appId,
        project: manifest.project,
        capability: route.capability,
      });
    },
  });
}

export { SERVICE_POLICY };
