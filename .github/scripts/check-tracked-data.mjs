import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isRuntimeDataPath(path) {
  const parts = path.toLowerCase().split("/");
  const filename = parts.at(-1);
  return parts.slice(0, -1).some((part) => ["data", "auth", "backup", "backups", "user_data"].includes(part))
    || (filename !== ".env.example" && /^\.env(?:\.|$)/.test(filename))
    || /\.(?:db|sqlite|sqlite3)(?:$|[-.])/.test(filename)
    || filename === "creds.json"
    || filename.endsWith(".log");
}

export function forbiddenTrackedFiles(cwd = process.cwd()) {
  const paths = (args) => execFileSync("git", args, { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  const tracked = paths(["ls-files", "--cached", "-z"]);
  const ignored = paths(["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"]);
  return [...new Set([...tracked.filter(isRuntimeDataPath), ...ignored])].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const forbidden = forbiddenTrackedFiles();
    if (forbidden.length) {
      console.error("Tracked runtime data, secret-file paths or ignored files detected:");
      for (const path of forbidden) console.error(`  ${JSON.stringify(path)}`);
      console.error("Remove these files from Git's index while retaining local copies; rotate exposed credentials and assess history separately.");
      process.exitCode = 1;
    } else {
      console.log("No tracked runtime-data paths or ignored files detected.");
    }
  } catch (error) {
    console.error("Could not inspect Git's tracked files:", error.message);
    process.exitCode = 1;
  }
}
