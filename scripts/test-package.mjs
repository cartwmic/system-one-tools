import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { installConsumer, packPackages, REPO_ROOT } from "./package-utils.mjs";

if (process.platform !== "darwin") {
  throw new Error("The complete package matrix is run from macOS and adds a Node 20 Linux consumer with Docker.");
}

const packageNames = [
  "@cartwmic/system-one-connections",
  "@cartwmic/system-one-cli",
  "@cartwmic/pi-system-one",
];
const root = await mkdtemp(join(tmpdir(), "system-one-package-proof-"));
const artifactDirectory = join(root, "artifacts");

function runProbe(script, consumer, env = {}) {
  execFileSync(process.execPath, [join(REPO_ROOT, "scripts", script), consumer, REPO_ROOT], {
    cwd: consumer,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

function runLinuxNode20(artifacts) {
  const sharedTarball = basename(artifacts.get("@cartwmic/system-one-connections"));
  const cliTarball = basename(artifacts.get("@cartwmic/system-one-cli"));
  const shell = [
    "set -eu",
    "mkdir -p /tmp/system-one-cli-consumer",
    "printf '%s\\n' '{\"private\":true}' > /tmp/system-one-cli-consumer/package.json",
    "cd /tmp/system-one-cli-consumer",
    `npm install --no-save --ignore-scripts /artifacts/${sharedTarball} /artifacts/${cliTarball}`,
    "SYSTEM_ONE_EXPECT_PLATFORM=linux SYSTEM_ONE_EXPECT_NODE_MAJOR=20 node /source/scripts/verify-cli-consumer.mjs /tmp/system-one-cli-consumer /source",
  ].join(" && ");
  execFileSync("docker", [
    "run", "--rm",
    "--volume", `${artifactDirectory}:/artifacts:ro`,
    "--volume", `${REPO_ROOT}:/source:ro`,
    "node:20-bookworm",
    "sh", "-ec", shell,
  ], { cwd: REPO_ROOT, stdio: "inherit", timeout: 300_000 });
}

try {
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  const artifacts = await packPackages(artifactDirectory, packageNames);
  const cliConsumer = join(root, "macos-cli-consumer");
  const piConsumer = join(root, "macos-pi-consumer");

  await installConsumer(cliConsumer, artifacts, [
    "@cartwmic/system-one-connections",
    "@cartwmic/system-one-cli",
  ]);
  runProbe("verify-cli-consumer.mjs", cliConsumer, { SYSTEM_ONE_EXPECT_PLATFORM: "darwin" });

  await installConsumer(piConsumer, artifacts, [
    "@cartwmic/system-one-connections",
    "@cartwmic/pi-system-one",
  ]);
  runProbe("verify-pi-consumer.mjs", piConsumer);
  runLinuxNode20(artifacts);

  console.log("PASS package matrix: independent macOS CLI and Pi consumers plus a Node 20 Linux CLI consumer; no publishing or live provider calls");
} finally {
  await rm(root, { recursive: true, force: true });
}
