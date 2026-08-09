import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const defaultExtensionRoot = resolve(scriptDirectory, "..");
const packageRoots = ["manifest.json", "dist", "src"];

async function listFiles(root, localPath = "") {
  const entries = await readdir(join(root, localPath), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(localPath, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, entryPath));
    else if (entry.isFile()) files.push(entryPath);
    else throw new Error(`Release input must not contain links or special files: ${entryPath}`);
  }
  return files;
}

async function gitValue(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout.trim();
}

export async function packageExtension({
  extensionRoot = defaultExtensionRoot,
  outputDirectory = resolve(extensionRoot, "release"),
  sourceCommit,
  sourceDateEpoch,
} = {}) {
  const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8"));
  if (manifest.version !== packageJson.version) {
    throw new Error(`Manifest ${manifest.version} does not match package ${packageJson.version}`);
  }
  await stat(join(extensionRoot, "dist", "background.js"));
  await stat(join(extensionRoot, "dist", "playground-bridge.js"));

  const commit = sourceCommit || process.env.GITHUB_SHA
    || await gitValue(extensionRoot, ["rev-parse", "HEAD"]);
  const epochText = sourceDateEpoch || process.env.SOURCE_DATE_EPOCH
    || await gitValue(extensionRoot, ["show", "-s", "--format=%ct", "HEAD"]);
  const epoch = Number.parseInt(epochText, 10);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("SOURCE_DATE_EPOCH must be a positive integer");
  const normalizedTime = new Date(Math.max(epoch * 1000, Date.UTC(1980, 0, 1)));

  await mkdir(outputDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "greenways-extension-release-"));
  const stagingRoot = join(temporaryRoot, "greenways-os");
  const archiveName = `greenways-os-extension-v${manifest.version}.zip`;
  const archivePath = join(outputDirectory, archiveName);
  try {
    await mkdir(stagingRoot, { recursive: true });
    for (const packageRoot of packageRoots) {
      await cp(join(extensionRoot, packageRoot), join(stagingRoot, packageRoot), { recursive: true });
    }
    const files = await listFiles(stagingRoot);
    for (const file of files) {
      const path = join(stagingRoot, file);
      await chmod(path, 0o644);
      await utimes(path, normalizedTime, normalizedTime);
    }
    await rm(archivePath, { force: true });
    await execFileAsync("zip", ["-X", "-q", archivePath, ...files], { cwd: stagingRoot });

    const sha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
    const checksumPath = `${archivePath}.sha256`;
    await writeFile(checksumPath, `${sha256}  ${basename(archivePath)}\n`);
    const metadataPath = join(outputDirectory, `greenways-os-extension-v${manifest.version}.json`);
    await writeFile(metadataPath, `${JSON.stringify({
      artifact: archiveName,
      compatibility: ["greenways-playground-ai/1"],
      manifestVersion: manifest.manifest_version,
      sha256,
      sourceCommit: commit,
      sourceDate: normalizedTime.toISOString(),
      version: manifest.version,
    }, null, 2)}\n`);
    return { archivePath, checksumPath, metadataPath, sha256, version: manifest.version };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--output");
  const outputDirectory = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : undefined;
  const result = await packageExtension({ outputDirectory });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
