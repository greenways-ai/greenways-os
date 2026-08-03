import assert from "node:assert/strict";
import test from "node:test";
import { FEATURED_WORLDS, featuredWorld } from "../src/featured-worlds.js";
import { parseGitHubRepository } from "../src/github-worlds.js";

test("featured worlds are unique public Greenways Worlds repositories", () => {
  assert.deepEqual(FEATURED_WORLDS.map(({ id }) => id), ["apartment", "playbot", "splat-garden"]);
  assert.equal(new Set(FEATURED_WORLDS.map(({ id }) => id)).size, FEATURED_WORLDS.length);
  for (const world of FEATURED_WORLDS) {
    const repository = parseGitHubRepository(world.repository);
    assert.equal(repository.owner, "greenways-worlds");
    assert.match(world.attribution, /^https:\/\/github\.com\/greenways-worlds\//);
  }
});

test("featured world lookup is bounded to the registry", () => {
  assert.equal(featuredWorld("playbot")?.format, "STREAMED SOG");
  assert.equal(featuredWorld("unknown"), null);
});
