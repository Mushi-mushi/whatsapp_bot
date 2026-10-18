import { BackupVerificationError, verifyBackup } from "../state/verify-backup.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: npm run backup:verify -- <standalone-backup.db>\nChecks an isolated temporary copy without migrations, WhatsApp, auth or delivery workers.");
    return;
  }
  if (args.length !== 1 || !args[0].trim() || args[0].startsWith("--")) {
    console.error(JSON.stringify({ ok: false, code: "USAGE", error: "Provide exactly one standalone database backup path. Use --help for usage." }));
    process.exitCode = 2;
    return;
  }
  try {
    console.log(JSON.stringify(await verifyBackup(args[0])));
  } catch (error) {
    const known = error instanceof BackupVerificationError;
    console.error(JSON.stringify({ ok: false, code: known ? error.code : "VERIFICATION_FAILED",
      error: known ? error.message : "Backup verification failed unexpectedly; no successful verification was recorded." }));
    process.exitCode = 1;
  }
}

await main();
