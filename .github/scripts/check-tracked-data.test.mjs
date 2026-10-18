import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { forbiddenTrackedFiles, isRuntimeDataPath } from "./check-tracked-data.mjs";

const script = fileURLToPath(new URL("./check-tracked-data.mjs", import.meta.url));

test("recognizes runtime paths independently of ignore rules", () => {
  for (const path of [
    "data/auth/session.json", "bot-core/auth/session.json", "backup/snapshot.zip",
    "nested/backups/manual.txt", "user_data/messages.json", "nested/DATA/export.json",
    "bot.db", "bot.db-wal", "bot.db-shm", "bot.db.partial", "bot.db.partial-journal",
    "bot.sqlite", "bot.sqlite3-shm", ".env", "web/.env.production", "nested/.ENV.local",
    "creds.json", "nested/creds.json", "output.log", "auth/name\nwith-newline.json",
  ]) assert.equal(isRuntimeDataPath(path), true, path);
});

test("allows source, documentation, lockfiles and environment examples", () => {
  for (const path of [
    ".env.example", "nested/.env.example", "bot-core/src/state/db.ts",
    "bot-core/src/state/backups.ts", ".github/scripts/check-tracked-data.test.mjs",
    "README.md", ".gitignore", "web/package-lock.json", "metadata/schema.json",
  ]) assert.equal(isRuntimeDataPath(path), false, path);
});

function withRepository(run) {
  const directory = mkdtempSync(join(tmpdir(), "bot-ci-data-guard-"));
  try {
    execFileSync("git", ["init", "--quiet", directory]);
    const track = (path, content = "synthetic test placeholder") => {
      const file = join(directory, ...path.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      execFileSync("git", ["add", "--force", "--", path], { cwd: directory });
    };
    run({ directory, track });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("checks the index, not ignored local data, and allows a clean repository", () => {
  withRepository(({ directory, track }) => {
    track(".gitignore", "data/\n.env\n");
    track(".env.example", "API_TOKEN=\n");
    mkdirSync(join(directory, "data"));
    writeFileSync(join(directory, "data", "bot.db"), "untracked synthetic placeholder");
    writeFileSync(join(directory, ".env"), "untracked synthetic placeholder");
    assert.deepEqual(forbiddenTrackedFiles(directory), []);
    const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("fails for force-added runtime files and reports paths without reading their contents", () => {
  withRepository(({ directory, track }) => {
    track(".gitignore", "data/\ncustom-private/\n");
    track("data/auth/session.json", "DO_NOT_PRINT_CONTENT");
    track("custom-private/odd name.txt", "DO_NOT_PRINT_CONTENT");
    track("nested/.env.production", "DO_NOT_PRINT_CONTENT");
    assert.deepEqual(forbiddenTrackedFiles(directory), [
      "custom-private/odd name.txt", "data/auth/session.json", "nested/.env.production",
    ]);
    const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /data\/auth\/session\.json/);
    assert.match(result.stderr, /custom-private\/odd name\.txt/);
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT_CONTENT/);
  });
});

test("fails for data paths even if ignore protections are removed", () => {
  withRepository(({ directory, track }) => {
    track("backups/old.db");
    track("auth/creds.json");
    assert.deepEqual(forbiddenTrackedFiles(directory), ["auth/creds.json", "backups/old.db"]);
  });
});

test("fails explicitly when Git cannot inspect a repository", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-ci-no-git-"));
  try {
    const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not inspect Git's tracked files/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
