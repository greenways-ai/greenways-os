#!/usr/bin/env node
import { runCli } from "../src/cli.js";

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  console.error(`greenways-assets: ${error.message}`);
  process.exitCode = 1;
}
