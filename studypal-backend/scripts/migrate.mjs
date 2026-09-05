#!/usr/bin/env node
/**
 * CLI for the migration runner.
 *
 *   npm run migrate          apply every pending migration
 *   npm run migrate:status   show what has and has not been applied
 *
 * The logic lives in src/db/migrator.js; this file is argument handling, output
 * and the exit code. Anything that goes wrong exits non-zero — a CI step that
 * runs migrations must fail the build, not print a warning and carry on.
 */

import { closeDatabase } from "../src/config/database.js";
import { config } from "../src/config/env.js";
import { migrate, migrationStatus } from "../src/db/migrator.js";

const command = process.argv[2] ?? "up";

/** Safe to print: the password is redacted by config. */
function banner() {
  console.log(`database: ${config.database.safeUrl}`);
}

async function runUp() {
  banner();
  const { applied, skipped } = await migrate();

  if (skipped.length > 0) {
    console.log(`already applied: ${skipped.length}`);
  }
  if (applied.length === 0) {
    console.log("nothing to apply — schema is up to date");
    return;
  }
  console.log(`applied ${applied.length}:`);
  for (const filename of applied) console.log(`  + ${filename}`);
}

async function runStatus() {
  banner();
  const { items, orphaned, pending, changed } = await migrationStatus();

  if (items.length === 0) {
    console.log("no migrations found");
  }
  for (const item of items) {
    const mark = item.changed ? "!" : item.applied ? "✓" : " ";
    const when = item.appliedAt ? ` ${item.appliedAt}` : "";
    console.log(`  [${mark}] ${item.filename}${when}`);
  }

  console.log(`\n${items.length - pending.length}/${items.length} applied`);

  if (changed.length > 0) {
    console.error(
      `\nMODIFIED AFTER APPLYING: ${changed.join(", ")}\n` +
        "This database has the previous version of those files. Revert them and " +
        "add a new migration instead.",
    );
    process.exitCode = 1;
  }

  if (orphaned.length > 0) {
    console.error(
      `\nRecorded but missing from disk: ${orphaned.join(", ")}\n` +
        "The database was migrated by a different checkout, or a migration file " +
        "was deleted.",
    );
    process.exitCode = 1;
  }
}

try {
  if (command === "up") await runUp();
  else if (command === "status") await runStatus();
  else {
    console.error(`Unknown command: ${command}\nUsage: migrate [up|status]`);
    process.exitCode = 2;
  }
} catch (err) {
  // The message is written for whoever has to fix it: it names the migration
  // and, for a syntax error, the character position within it.
  console.error(`\nmigration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
