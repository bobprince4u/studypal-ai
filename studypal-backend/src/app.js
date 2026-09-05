/**
 * Express application assembly.
 *
 * Exports a factory rather than a started server. That single change is what
 * makes the backend testable: the pre-refactor server.js called `app.listen()`
 * as an import side effect and never exported the app, so nothing could load it
 * without binding a port.
 *
 * Middleware order is deliberate — see the comments below.
 */

import express from "express";

import { corsMiddleware } from "./middleware/cors.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { config } from "./config/env.js";
import { routes } from "./routes/index.js";

export function createApp() {
  const app = express();

  // Do not advertise the framework.
  app.disable("x-powered-by");

  // First, so it observes the final status of every request including errors.
  app.use(requestLogger);

  // Before any handler can respond, so headers are present on errors too.
  app.use(securityHeaders);

  app.use(corsMiddleware());

  // Bounded, unlike the pre-refactor `express.json()` which used the 100kb
  // default implicitly. Same default here, now stated and configurable.
  app.use(express.json({ limit: config.limits.jsonBody }));

  app.use(routes);

  // Unmatched routes: JSON 404 rather than Express's default HTML page.
  app.use(notFoundHandler);

  // Last. Express identifies this as an error handler by its four parameters.
  app.use(errorHandler);

  return app;
}
