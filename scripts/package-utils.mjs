import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function packPackages(directory, packageNames) {
  await mkdir(directory, { recursive: true });
  const tarballs = new Map();
  for (const packageName of packageNames) {
    const packageDirectory = await findPackageDirectory(packageName);
    execFileSync("npm", ["pack", "--workspace", packageName, "--pack-destination", directory], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    const tarballName = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
    tarballs.set(packageName, join(directory, tarballName));
  }
  return tarballs;
}

async function findPackageDirectory(packageName) {
  const packagesRoot = join(REPO_ROOT, "packages");
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDirectory = join(packagesRoot, entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
      if (manifest.name === packageName) return packageDirectory;
    } catch {
      // Ignore non-package directories.
    }
  }
  throw new Error(`No workspace package found for ${packageName}.`);
}

export async function installConsumer(directory, artifacts, packageNames, { offline = true } = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
  const tarballs = packageNames.map((packageName) => {
    const tarball = artifacts.get(packageName);
    if (!tarball) throw new Error(`No packed artifact for ${packageName}.`);
    return tarball;
  });
  execFileSync("npm", ["install", "--no-save", "--ignore-scripts", ...(offline ? ["--offline"] : []), ...tarballs], {
    cwd: directory,
    stdio: "inherit",
  });
}
