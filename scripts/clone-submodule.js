#!/usr/bin/env node
// Usage: node scripts/clone-submodule.js --dir=<dir> --url=<url> --sha=<sha> [--sparse=<subdir>]

import { execSync } from "node:child_process";
import { rmSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const flags = {};

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      flags[arg.slice(2)] = true;
    }
  }
}

const { dir, url, sha, sparse: sparseDir = null } = flags;

if (!dir || !url || !sha) {
  console.error(
    "Usage: node scripts/clone-submodule.js --dir=<dir> --url=<url> --sha=<sha> [--sparse=<subdir>]",
  );
  process.exit(1);
}

const absDir = resolve(dir);

function git(...args) {
  const cmd = `git ${args.join(" ")}`;
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function gitIn(cwd, ...args) {
  const cmd = `git ${args.join(" ")}`;
  console.log(`  $ cd ${cwd} && ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

console.log(`\nCloning/updating submodule: ${dir}${sparseDir ? ` (sparse: ${sparseDir})` : ""}`);

// Skip if already at the requested SHA
const shaFile = join(absDir, ".sha");
try {
  const cached = readFileSync(shaFile, "utf8").trim();
  if (cached === sha) {
    console.log(`  ✓ already at ${sha.slice(0, 12)}, skipping\n`);
    process.exit(0);
  }
} catch {
  // no lockfile yet — proceed with clone
}

// Always start fresh
rmSync(absDir, { recursive: true, force: true });
git("init", absDir);

// Add remote
gitIn(absDir, "remote", "add", "origin", url);

// Configure sparse checkout before fetching
if (sparseDir) {
  gitIn(absDir, "sparse-checkout", "set", "--no-cone", sparseDir);
}

// Fetch the exact commit, reset, and clean
gitIn(absDir, "fetch", "--depth=1", "origin", sha);
gitIn(absDir, "reset", "--hard", sha);
gitIn(absDir, "clean", "-f", "-q");

// Hoist sparse subdir contents up to the target root
if (sparseDir) {
  const nested = join(absDir, sparseDir);
  const tmp = `${absDir}__tmp`;
  renameSync(nested, tmp);
  rmSync(absDir, { recursive: true, force: true });
  renameSync(tmp, absDir);
}

// Write SHA lockfile so subsequent runs can skip
writeFileSync(join(absDir, ".sha"), sha);

console.log(`  ✓ ${dir} is at ${sha.slice(0, 12)}\n`);
