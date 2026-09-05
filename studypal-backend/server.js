/**
 * Process entrypoint.
 *
 * Bootstrap only: open the database, build the app, listen, and shut down
 * cleanly. All request handling lives under src/ — see docs/current-architecture.md
 * for the layering and src/app.js for how the app is composed.
 */

import { createApp } from "./src/app.js";
import { closeDatabase, getDatabase } from "./src/config/database.js";
import { config, configWarnings } from "./src/config/env.js";
import { logger } from "./src/utils/logger.js";

for (const warning of configWarnings()) {
  logger.warn(warning);
}

// Opened eagerly so a bad DATABASE_PATH fails at startup rather than on the
// first request. better-sqlite3 is synchronous, so there is nothing to await.
getDatabase();

const server = createApp().listen(config.port, () => {
  logger.info(`StudyPal backend running on http://localhost:${config.port}`);
});

/**
 * Stop accepting connections, let in-flight requests finish, then close the
 * database. Without this, SIGTERM from a container runtime would drop live
 * requests and leave the WAL file unchecked.
 */
function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);

  server.close((err) => {
    if (err) {
      logger.error("error while closing server", err);
    }
    closeDatabase();
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
