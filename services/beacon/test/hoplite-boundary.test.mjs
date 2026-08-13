import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Beacon consumes generic Hoplite without transferring Greenways authority", async () => {
  const [project, application, protocol] = await Promise.all([
    read("project.edn"),
    read("src/gw/beacon.hal"),
    read("../../protocol/beacon.md"),
  ]);
  assert.match(project, /:profile\/language :hoplite/);
  assert.match(application, /\[hoplite\.core :as h\]/);
  for (const retired of [
    ":hoplite/authentication",
    ":route/auth",
    "hoplite.auth",
    "hoplite.value",
    "Hoplite-owned application authentication",
    "local management realm",
  ]) {
    assert.equal(`${project}\n${application}\n${protocol}`.includes(retired), false, retired);
  }
  assert.match(protocol, /Greenways OS owns local application\s+approval and credentials/);
});
