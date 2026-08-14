import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  extensionIdFromManifestKey,
  readExtensionIdentity,
  verifyManifestIdentity,
} from "../scripts/extension-identity.mjs";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedExtensionId = "iignnnidjioameihobbmbeimdgampooj";

async function withIdentityFixture(mutator, action) {
  const root = await mkdtemp(join(tmpdir(), "greenways-extension-identity-"));
  try {
    const identity = JSON.parse(
      await readFile(join(extensionRoot, "extension-identity.json"), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(join(extensionRoot, "manifest.json"), "utf8"),
    );
    await mutator({ identity, manifest });
    await writeFile(
      join(root, "extension-identity.json"),
      `${JSON.stringify(identity, null, 2)}\n`,
    );
    await action({ root, manifest });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("derives the reviewed Chrome ID from public manifest key bytes", async () => {
  const identity = await readExtensionIdentity(extensionRoot);
  assert.equal(identity.extensionId, expectedExtensionId);
  assert.equal(
    extensionIdFromManifestKey(identity.manifestKey),
    expectedExtensionId,
  );
  assert.equal(identity.origin, `chrome-extension://${expectedExtensionId}/`);
});

test("fails closed when reviewed identity or manifest bytes drift", async () => {
  await withIdentityFixture(
    async ({ identity }) => {
      identity.extensionId = `a${identity.extensionId.slice(1)}`;
      identity.origin = `chrome-extension://${identity.extensionId}/`;
    },
    async ({ root, manifest }) => {
      await assert.rejects(
        readExtensionIdentity(root),
        /identity is inconsistent/,
      );
      await assert.rejects(
        verifyManifestIdentity(root, manifest),
        /identity is inconsistent/,
      );
    },
  );

  await withIdentityFixture(
    async () => {},
    async ({ root, manifest }) => {
      manifest.key = `${manifest.key.slice(0, -1)}A`;
      await assert.rejects(
        verifyManifestIdentity(root, manifest),
        /manifest identity drifted|manifest key is not canonical/,
      );
    },
  );
});
