import json
from pathlib import Path


def replace_once(path, old, new):
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"Missing exact anchor in {path}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


# Closed capability vocabulary.
replace_once(
    "extension/src/core-services.js",
    '''  capability("model/provide", "surfaces", "critical", {
    grantable: true,
    trustedPublishers: ["greenways-ai"],
    description: "Project one foreground model request into a reviewed AI web application and return an explicitly selected response.",
  }),
''',
    '''  capability("model/provide", "surfaces", "critical", {
    grantable: true,
    trustedPublishers: ["greenways-ai"],
    description: "Project one foreground model request into a reviewed AI web application and return an explicitly selected response.",
  }),
  capability("mcp/pair", "keyring", "critical", {
    grantable: true,
    trustedPublishers: ["greenways-ai"],
    description: "Approve and sign one exact remote MCP read connection without exporting controller key material.",
  }),
''',
)

# Narrow Keyring signer: no arbitrary key/sign entry point.
replace_once(
    "extension/src/keyring.js",
    'import { createIdentity } from "./protocol.js";\n',
    '''import {
  bytesToBase64Url,
  canonical,
  createIdentity,
  sha256,
} from "./protocol.js";
import {
  MCP_PAIRING_ALGORITHM,
  MCP_PAIRING_ASSERTION_PROTOCOL,
  normalizeMcpPairingChallenge,
  normalizeMcpPairingDevice,
  normalizeMcpPublicKey,
} from "./mcp-access-protocol.js";
''',
)
replace_once(
    "extension/src/keyring.js",
    '''    identityFactory = createIdentity,
    now = () => new Date().toISOString(),
  } = {}) {
''',
    '''    identityFactory = createIdentity,
    cryptoProvider = globalThis.crypto,
    now = () => new Date().toISOString(),
  } = {}) {
''',
)
replace_once(
    "extension/src/keyring.js",
    '''    if (typeof identityFactory !== "function") throw new TypeError("Identity factory must be a function");
    if (typeof now !== "function") throw new TypeError("Keyring clock must be a function");
    this.identityStore = identityStore;
    this.identityFactory = identityFactory;
    this.now = now;
''',
    '''    if (typeof identityFactory !== "function") throw new TypeError("Identity factory must be a function");
    if (!cryptoProvider?.subtle) throw new TypeError("Greenways Keyring requires Web Crypto");
    if (typeof now !== "function") throw new TypeError("Keyring clock must be a function");
    this.identityStore = identityStore;
    this.identityFactory = identityFactory;
    this.cryptoProvider = cryptoProvider;
    this.now = now;
''',
)
replace_once(
    "extension/src/keyring.js",
    '''  async addProviderProfile({ id, provider, label, secret }) {
''',
    '''  async signMcpPairingChallenge(challengeValue, {
    device,
    now = () => new Date(this.now()),
  } = {}) {
    const challenge = await normalizeMcpPairingChallenge(challengeValue, { now });
    const identityRecord = await this.identityStore.get("identity", "owner");
    const identity = identityRecord?.identity;
    if (!identity?.identityId || !identity?.keyId || !identity?.publicKey || !identityRecord?.privateKey) {
      const error = new Error("Create a Greenways controller identity before approving MCP access");
      error.code = "CONTROLLER_REQUIRED";
      throw error;
    }
    if (identity.algorithm !== MCP_PAIRING_ALGORITHM || identityRecord.privateKey.extractable !== false) {
      throw new Error("The stored Greenways controller key is not an approved non-extractable P-256 signer");
    }
    const publicKey = normalizeMcpPublicKey(identity.publicKey);
    if (identity.keyId !== await sha256(canonical(publicKey))) {
      throw new Error("The stored Greenways controller public key does not match its key ID");
    }
    const pairingDevice = normalizeMcpPairingDevice(device);
    const issued = now();
    if (!(issued instanceof Date) || !Number.isFinite(issued.getTime())) {
      throw new Error("The Greenways pairing clock is unavailable");
    }
    const expiresAt = new Date(Math.min(
      issued.getTime() + 2 * 60 * 1000,
      Date.parse(challenge.expiresAt),
    )).toISOString();
    const body = Object.freeze({
      protocol: MCP_PAIRING_ASSERTION_PROTOCOL,
      challengeId: challenge.id,
      challengeRoot: challenge.root,
      identity: Object.freeze({
        id: identity.identityId,
        handle: identity.handle ?? null,
        keyId: identity.keyId,
        algorithm: MCP_PAIRING_ALGORITHM,
        publicKey,
      }),
      device: pairingDevice,
      issuedAt: issued.toISOString(),
      expiresAt,
    });
    const signature = new Uint8Array(await this.cryptoProvider.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identityRecord.privateKey,
      new TextEncoder().encode(canonical(body)),
    ));
    return Object.freeze({ ...body, signature: bytesToBase64Url(signature) });
  }

  async addProviderProfile({ id, provider, label, secret }) {
''',
)

# Bundled application catalogue and packaged surface binding.
replace_once(
    "extension/src/app-catalog.js",
    'import chatgptProviderProject from "../apps/chatgpt-provider/project.edn";\n',
    'import chatgptProviderProject from "../apps/chatgpt-provider/project.edn";\nimport mcpAccessProject from "../apps/mcp-access/project.edn";\n',
)
replace_once(
    "extension/src/app-catalog.js",
    '''  "chatgpt-provider",
  "userscripts",
''',
    '''  "chatgpt-provider",
  "mcp-access",
  "userscripts",
''',
)
replace_once(
    "extension/src/app-catalog.js",
    '''  userscripts: Object.freeze({
''',
    '''  "mcp-access": Object.freeze({
    appId: "mcp-access",
    publisherId: "greenways-ai",
    capabilities: Object.freeze([
      "mcp/pair",
    ]),
  }),
  userscripts: Object.freeze({
''',
)
replace_once(
    "extension/src/app-catalog.js",
    '''      applicationDescriptorWithDigest(chatgptProviderProject),
      applicationDescriptorWithDigest(userscriptsProject),
    ]).then(([chats, chatgptProvider, userscripts]) => {
''',
    '''      applicationDescriptorWithDigest(chatgptProviderProject),
      applicationDescriptorWithDigest(mcpAccessProject),
      applicationDescriptorWithDigest(userscriptsProject),
    ]).then(([chats, chatgptProvider, mcpAccess, userscripts]) => {
''',
)
replace_once(
    "extension/src/app-catalog.js",
    '''        chatgptProvider,
        userscripts,
''',
    '''        chatgptProvider,
        mcpAccess,
        userscripts,
''',
)

# Browser kernel host: separate page bridge and exact app authority.
replace_once(
    "extension/src/kernel-host.js",
    '''import {
  CHATGPT_PROVIDER_APP_ID,
  CHATGPT_PROVIDER_CAPABILITY,
} from "./chatgpt-provider-runtime.js";
''',
    '''import {
  CHATGPT_PROVIDER_APP_ID,
  CHATGPT_PROVIDER_CAPABILITY,
} from "./chatgpt-provider-runtime.js";
import {
  MCP_ACCESS_APP_ID,
  MCP_ACCESS_CAPABILITY,
} from "./mcp-access-runtime.js";
''',
)
replace_once(
    "extension/src/kernel-host.js",
    '''      "chatgpt-provider/set-enabled",
      "applications/call",
''',
    '''      "chatgpt-provider/set-enabled",
      "mcp-access/status",
      "mcp-access/set-enabled",
      "applications/call",
''',
)
replace_once(
    "extension/src/kernel-host.js",
    '''    chatgptProvider,
    applicationServices,
''',
    '''    chatgptProvider,
    mcpAccess,
    applicationServices,
''',
)
replace_once(
    "extension/src/kernel-host.js",
    '''    if (applicationServices !== undefined && typeof applicationServices?.call !== "function") {
''',
    '''    if (mcpAccess !== undefined
        && (typeof mcpAccess?.call !== "function"
          || typeof mcpAccess?.handlePageMessage !== "function")) {
      throw new TypeError("Kernel host MCP access runtime must expose call() and handlePageMessage()");
    }
    if (applicationServices !== undefined && typeof applicationServices?.call !== "function") {
''',
)
replace_once(
    "extension/src/kernel-host.js",
    '''    this.applicationServices = applicationServices ?? Object.freeze({
''',
    '''    this.mcpAccess = mcpAccess ?? Object.freeze({
      async call() {
        throw errorWithCode("MCP access runtime is unavailable", "MCP_ACCESS_UNAVAILABLE");
      },
      async handlePageMessage() {
        throw errorWithCode("MCP authorization page bridge is unavailable", "MCP_ACCESS_UNAVAILABLE");
      },
    });
    this.applicationServices = applicationServices ?? Object.freeze({
''',
)
replace_once(
    "extension/src/kernel-host.js",
    '''  async initialCheckpoint() {
''',
    '''  async assertMcpAccessAuthority() {
    const global = await this.globalState();
    const installed = global.installed ?? [];
    const manifest = installed.find(({ id }) => id === MCP_ACCESS_APP_ID);
    if (!manifest) throw errorWithCode("Greenways MCP Access is not installed", "APP_NOT_INSTALLED");
    await this.capabilityAuthority.assert({
      appId: MCP_ACCESS_APP_ID,
      capability: MCP_ACCESS_CAPABILITY,
    }, { installed });
    if (!activeCapabilityGrant(
      global.grants ?? [],
      manifest,
      MCP_ACCESS_CAPABILITY,
      { now: this.now },
    )) {
      throw errorWithCode("MCP pairing requires an active mcp/pair grant", "CAPABILITY_DENIED");
    }
  }

  handleMcpAccessPageMessage(message, sender) {
    return this.mcpAccess.handlePageMessage(message, sender);
  }

  async initialCheckpoint() {
''',
)
replace_once(
    "extension/src/kernel-host.js",
    '''              : method.startsWith("chatgpt-provider/")
                ? await this.chatgptProvider.call(method, invokeArgs)
            : await this.invoke(method, invokeArgs),
''',
    '''              : method.startsWith("chatgpt-provider/")
                ? await this.chatgptProvider.call(method, invokeArgs)
                : method.startsWith("mcp-access/")
                  ? await this.mcpAccess.call(method, invokeArgs)
            : await this.invoke(method, invokeArgs),
''',
)

# Service-worker composition and page-message routing.
replace_once(
    "extension/src/background.js",
    '''import {
  CHATGPT_PROVIDER_MESSAGE_TYPE,
  createChatgptProviderRuntime,
} from "./chatgpt-provider-runtime.js";
''',
    '''import {
  CHATGPT_PROVIDER_MESSAGE_TYPE,
  createChatgptProviderRuntime,
} from "./chatgpt-provider-runtime.js";
import {
  MCP_ACCESS_MESSAGE_TYPE,
  createMcpAccessRuntime,
} from "./mcp-access-runtime.js";
''',
)
replace_once(
    "extension/src/background.js",
    '''      const chatgptProvider = createChatgptProviderRuntime({
        runtime,
        scripting,
        tabs,
        assertAuthority: () => host.assertChatgptProviderAuthority(),
      });
''',
    '''      const chatgptProvider = createChatgptProviderRuntime({
        runtime,
        scripting,
        tabs,
        assertAuthority: () => host.assertChatgptProviderAuthority(),
      });
      const mcpAccess = createMcpAccessRuntime({
        runtime,
        scripting,
        assertAuthority: () => host.assertMcpAccessAuthority(),
      });
''',
)
replace_once(
    "extension/src/background.js",
    '''        chatgptProvider,
        applicationServices,
''',
    '''        chatgptProvider,
        mcpAccess,
        applicationServices,
''',
)
replace_once(
    "extension/src/background.js",
    '''    const chatgptProviderMessage = message?.type === CHATGPT_PROVIDER_MESSAGE_TYPE;
    const legacyNavigation = LEGACY_APP_PATHS.has(message?.type) || message?.type === "greenways/open-app";
''',
    '''    const chatgptProviderMessage = message?.type === CHATGPT_PROVIDER_MESSAGE_TYPE;
    const mcpAccessMessage = message?.type === MCP_ACCESS_MESSAGE_TYPE;
    const legacyNavigation = LEGACY_APP_PATHS.has(message?.type) || message?.type === "greenways/open-app";
''',
)
replace_once(
    "extension/src/background.js",
    '''        && !chatObservation
        && !chatgptProviderMessage) return false;
''',
    '''        && !chatObservation
        && !chatgptProviderMessage
        && !mcpAccessMessage) return false;
''',
)
replace_once(
    "extension/src/background.js",
    '''        if (chatgptProviderMessage) {
          return (await getKernelHost()).handleChatgptProviderPageMessage(message, sender);
        }
''',
    '''        if (mcpAccessMessage) {
          return (await getKernelHost()).handleMcpAccessPageMessage(message, sender);
        }
        if (chatgptProviderMessage) {
          return (await getKernelHost()).handleChatgptProviderPageMessage(message, sender);
        }
''',
)

# Launcher app management surface.
replace_once(
    "extension/src/launcher.js",
    'import { createChatgptProviderSurface } from "./chatgpt-provider-surface.js";\n',
    'import { createChatgptProviderSurface } from "./chatgpt-provider-surface.js";\nimport { createMcpAccessSurface } from "./mcp-access-surface.js";\n',
)
replace_once(
    "extension/src/launcher.js",
    '''    "chatgpt-provider": "✦",
    userscripts: "⌁",
''',
    '''    "chatgpt-provider": "✦",
    "mcp-access": "⇄",
    userscripts: "⌁",
''',
)
replace_once(
    "extension/src/launcher.js",
    '''  surfaceHost.register("chatgpt-provider", createChatgptProviderSurface);
  surfaceHost.register("userscripts", createUserscriptsSurface);
''',
    '''  surfaceHost.register("chatgpt-provider", createChatgptProviderSurface);
  surfaceHost.register("mcp-access", createMcpAccessSurface);
  surfaceHost.register("userscripts", createUserscriptsSurface);
''',
)

# Build and release projections.
replace_once(
    "extension/scripts/build-extension.mjs",
    '''    "chatgpt-provider-bridge": "src/chatgpt-provider-bridge.js",
''',
    '''    "chatgpt-provider-bridge": "src/chatgpt-provider-bridge.js",
    "mcp-authorization-bridge": "src/mcp-authorization-bridge.js",
''',
)
replace_once(
    "extension/scripts/build-extension.mjs",
    '''  chatgptProviderBridgeBundle,
] = await Promise.all([
''',
    '''  chatgptProviderBridgeBundle,
  mcpAuthorizationBridgeBundle,
] = await Promise.all([
''',
)
replace_once(
    "extension/scripts/build-extension.mjs",
    '''  readFile(new URL("../dist/chatgpt-provider-bridge.js", import.meta.url), "utf8"),
]);
''',
    '''  readFile(new URL("../dist/chatgpt-provider-bridge.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/mcp-authorization-bridge.js", import.meta.url), "utf8"),
]);
''',
)
replace_once(
    "extension/scripts/build-extension.mjs",
    '''  ["chatgpt-provider-bridge", chatgptProviderBridgeBundle],
]) {
''',
    '''  ["chatgpt-provider-bridge", chatgptProviderBridgeBundle],
  ["mcp-authorization-bridge", mcpAuthorizationBridgeBundle],
]) {
''',
)
replace_once(
    "extension/scripts/package-extension.mjs",
    '''  await stat(join(extensionRoot, "dist", "chatgpt-provider-bridge.js"));
''',
    '''  await stat(join(extensionRoot, "dist", "chatgpt-provider-bridge.js"));
  await stat(join(extensionRoot, "dist", "mcp-authorization-bridge.js"));
''',
)
replace_once(
    "extension/scripts/package-extension.mjs",
    '''      compatibility: ["greenways-playground-ai/1", "greenways-chatgpt-provider/1"],
''',
    '''      compatibility: [
        "greenways-playground-ai/1",
        "greenways-chatgpt-provider/1",
        "greenways-mcp-access/1",
      ],
''',
)

# Exact optional host permission only.
manifest_path = Path("extension/manifest.json")
manifest = json.loads(manifest_path.read_text())
origin = "https://mcp.greenways.ai/*"
optional = manifest.setdefault("optional_host_permissions", [])
if origin not in optional:
    optional.append(origin)
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

print("Applied Greenways MCP authorization adapter integration")
