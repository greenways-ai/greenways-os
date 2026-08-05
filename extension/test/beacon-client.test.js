import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BEACON_PROTOCOL,
  SPACE_PROTOCOL,
  BeaconClient,
  beaconPermissionPattern,
  normalizeBeaconDescriptor,
  normalizeBeaconOrigin,
  normalizeSpaceDescriptor,
  privateSpaceCapabilitiesEnabled,
} from "../src/beacon-client.js";

function beaconDescriptor(overrides = {}) {
  return {
    protocol: BEACON_PROTOCOL,
    id: "greenways.beacon",
    name: "Greenways Beacon",
    role: "local-gateway",
    runtime: {
      applicationServer: "Hoplite",
      language: "Hara",
      namespace: "gw.beacon",
      edge: "Nginx",
    },
    space: {
      origin: "https://greenways.space",
      protocol: SPACE_PROTOCOL,
      localPrefix: "/space/",
      discovery: "/space/discovery.json",
    },
    boundaries: {
      browserKernel: "Greenways OS",
      serviceAuthority: "Greenways Space",
      privateOffice: "Hestia",
      agentService: "Ignatius",
    },
    capabilities: ["space.discovery", "space.transport", "local.health"],
    legacy: {
      protocol: "greenways-home/1",
      status: "compatibility-only",
    },
    ...overrides,
  };
}

function spaceDescriptor(overrides = {}) {
  return {
    protocol: SPACE_PROTOCOL,
    id: "greenways.space",
    name: "Greenways Space",
    revision: 1,
    status: "development",
    beacon: {
      protocol: "greenways-beacon-space/1",
      basePath: "/beacon/v1/",
      discovery: "/beacon/v1/discovery.json",
    },
    services: [
      {
        id: "hestia",
        name: "Hestia",
        role: "private-office",
        authority: "participant-controlled-keys",
        status: "development",
        capabilities: ["office.rooms", "receipt.present"],
      },
      {
        id: "ignatius",
        name: "Ignatius",
        role: "agent-service",
        authority: "capability-grant",
        status: "development",
        capabilities: ["agent.dispatch", "job.receipt"],
      },
    ],
    execution: {
      remoteCode: false,
      descriptorKind: "inert-data",
      browserKernelAuthority: false,
    },
    signing: {
      status: "not-yet-signed",
      requiredForPrivateCapabilities: true,
    },
    ...overrides,
  };
}

test("accepts loopback Beacon HTTP and remote Beacon HTTPS only", () => {
  assert.equal(normalizeBeaconOrigin("http://127.0.0.1:58100"), "http://127.0.0.1:58100");
  assert.equal(normalizeBeaconOrigin("http://localhost:58100"), "http://localhost:58100");
  assert.equal(normalizeBeaconOrigin("https://beacon.example"), "https://beacon.example");
  assert.equal(beaconPermissionPattern("http://127.0.0.1:58100"), "http://127.0.0.1:58100/*");
  assert.equal(beaconPermissionPattern("https://beacon.example:8443"), "https://beacon.example:8443/*");
  assert.throws(() => normalizeBeaconOrigin("http://192.168.1.20:58100"), /must use HTTPS/);
  assert.throws(() => normalizeBeaconOrigin("https://beacon.example/private"), /without a path/);
  assert.throws(() => normalizeBeaconOrigin("https://user@beacon.example"), /credentials/);
});

test("validates the Hoplite Beacon identity and fixed Space route", () => {
  const descriptor = normalizeBeaconDescriptor(beaconDescriptor());
  assert.equal(descriptor.id, "greenways.beacon");
  assert.equal(descriptor.runtime.applicationServer, "Hoplite");
  assert.equal(descriptor.runtime.namespace, "gw.beacon");
  assert.equal(descriptor.space.origin, "https://greenways.space");
  assert.equal(descriptor.space.discovery, "/space/discovery.json");
  assert.equal(descriptor.boundaries.privateOffice, "Hestia");
  assert.equal(descriptor.boundaries.agentService, "Ignatius");
});

test("rejects executable material or a request-selected Space origin", () => {
  assert.throws(
    () => normalizeBeaconDescriptor({
      ...beaconDescriptor(),
      script: "https://greenways.space/beacon.js",
    }),
    /executable field script/,
  );
  assert.throws(
    () => normalizeBeaconDescriptor(beaconDescriptor({
      space: {
        ...beaconDescriptor().space,
        origin: "https://attacker.example",
      },
    })),
    /must be https:\/\/greenways\.space/,
  );
});

test("keeps unsigned Space discovery descriptive and private capabilities disabled", () => {
  const space = normalizeSpaceDescriptor(spaceDescriptor());
  assert.equal(space.services[0].id, "hestia");
  assert.equal(space.services[1].id, "ignatius");
  assert.equal(space.execution.remoteCode, false);
  assert.equal(privateSpaceCapabilitiesEnabled(space), false);

  const signed = normalizeSpaceDescriptor(spaceDescriptor({
    signing: {
      status: "signed",
      requiredForPrivateCapabilities: true,
    },
  }));
  assert.equal(privateSpaceCapabilitiesEnabled(signed), true);
});

test("rejects executable Space fields and browser-kernel authority", () => {
  assert.throws(
    () => normalizeSpaceDescriptor(spaceDescriptor({
      services: [{
        ...spaceDescriptor().services[0],
        module: "remote-hestia-adapter",
      }],
    })),
    /executable field module/,
  );
  assert.throws(
    () => normalizeSpaceDescriptor(spaceDescriptor({
      execution: {
        remoteCode: false,
        descriptorKind: "inert-data",
        browserKernelAuthority: true,
      },
    })),
    /must be false/,
  );
  assert.throws(
    () => normalizeSpaceDescriptor(spaceDescriptor({
      execution: {
        remoteCode: true,
        descriptorKind: "inert-data",
        browserKernelAuthority: false,
      },
    })),
    /must be false/,
  );
});

test("discovers Space only through the selected local Beacon origin", async () => {
  const calls = [];
  const client = new BeaconClient({
    origin: "http://127.0.0.1:58100",
    request: async (url) => {
      calls.push(url);
      const body = url.endsWith("/.well-known/greenways-beacon")
        ? beaconDescriptor()
        : spaceDescriptor();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const { descriptor, space } = await client.inspect();
  assert.equal(descriptor.protocol, BEACON_PROTOCOL);
  assert.equal(space.protocol, SPACE_PROTOCOL);
  assert.deepEqual(calls, [
    "http://127.0.0.1:58100/.well-known/greenways-beacon",
    "http://127.0.0.1:58100/space/discovery.json",
  ]);
});

test("launcher packages the Beacon visual and discovery surfaces locally", async () => {
  const [html, surface, css] = await Promise.all([
    readFile(new URL("../src/launcher.html", import.meta.url), "utf8"),
    readFile(new URL("../src/beacon-surface.js", import.meta.url), "utf8"),
    readFile(new URL("../src/beacon.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /href="beacon\.css"/);
  assert.match(html, /src="beacon-surface\.js"/);
  assert.match(surface, /Greenways Beacon/);
  assert.match(surface, /Private capabilities remain disabled/);
  assert.match(surface, /requestBeaconOriginAccess/);
  assert.doesNotMatch(surface, /innerHTML\s*=\s*await\s+fetch/);
  assert.match(css, /var\(--gw-surface\)/);
});
