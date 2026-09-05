/**
 * Process entrypoint.
 *
 * Bootstrap only: check the database, build the app, listen, and shut down
 * cleanly. All request handling lives under src/ — see docs/current-architecture.md
 * for the layering and src/app.js for how the app is composed.
 */

import { createApp } from "./src/app.js";
import { checkDatabaseHealth, closeDatabase } from "./src/config/database.js";
import { config, configWarnings } from "./src/config/env.js";
import { logger } from "./src/utils/logger.js";
import { migrationStatus } from "./src/db/migrator.js";

for (const warning of configWarnings()) {
  logger.warn(warning);
}

/**
 * Probe the database once at startup, and report rather than exit.
 *
 * The alternative — refuse to start unless PostgreSQL answers — sounds safer but
 * behaves worse: a container that exits on a database blip enters a restart
 * loop, and an orchestrator sees a crashing image instead of a service telling it
 * what is wrong. So a missing DATABASE_URL is fatal (that is a deployment
 * mistake, caught in src/config/env.js before this runs) while an unreachable
 * database is reported: GET /health returns 503 `degraded` until it recovers,
 * and pg reconnects on its own.
 *
 * There is no SQLite fallback of any kind. If PostgreSQL is down, the data
 * endpoints fail.
 */
async function checkDatabaseAtStartup() {
  const health = await checkDatabaseHealth();
  if (!health.ok) {
    logger.error(
      `database unreachable at startup: ${health.error} — ` +
        `GET /health will report 503 and data endpoints will fail until it ` +
        `recovers. Is PostgreSQL running? (npm run db:up)`,
    );
    return;
  }

  // A schema that is behind the repository is the likeliest cause of a
  // mystifying "column does not exist" on the first request, so say so up front
  // rather than letting it surface as a 500.
  try {
    const { pending, changed } = await migrationStatus();
    if (pending.length > 0) {
      logger.warn(
        `${pending.length} migration(s) not applied: ${pending.join(", ")} — ` +
          `run \`npm run migrate\`.`,
      );
    }
    if (changed.length > 0) {
      logger.error(
        `migration file(s) modified after being applied: ${changed.join(", ")}`,
      );
    }
  } catch (err) {
    logger.warn(`could not check migration status: ${err.message}`);
  }
}

await checkDatabaseAtStartup();

const server = createApp().listen(config.port, () => {
  logger.info(`StudyPal backend running on http://localhost:${config.port}`);
});

/**
 * Stop accepting connections, let in-flight requests finish, then close the
 * connection pool. Without this, SIGTERM from a container runtime would drop
 * live requests and leave PostgreSQL to time out the abandoned backends.
 */
function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);

  server.close(async (err) => {
    if (err) {
      logger.error("error while closing server", err);
    }
    try {
      // Awaited: pool.end() waits for checked-out clients to be released, so
      // exiting before it settles is what leaks connections.
      await closeDatabase();
    } catch (closeErr) {
      logger.error(`error while closing database pool: ${closeErr.message}`);
    }
    process.exit(err ? 1 : 0);
  });

  // Do not hang forever on a stuck connection.
  setTimeout(() => {
    logger.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
