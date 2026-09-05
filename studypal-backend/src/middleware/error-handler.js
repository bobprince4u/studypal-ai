/**
 * Centralised error handling.
 *
 * Two rules govern this file:
 *
 *  1. Every error response is JSON with an `error` string. The frontend's
 *     /api/ask handler pushes the parsed body straight into the message list
 *     without checking status, so an HTML error page from Express's default
 *     handler renders as a blank assistant bubble. JSON keeps failures visible.
 *
 *  2. Nothing internal leaves the process. Stack traces, upstream provider
 *     messages, SQLite errors and file paths are logged and replaced with a
 *     fixed client-safe message. The pre-refactor server did the opposite on
 *     /api/ask, forwarding `err.message` from Gemini verbatim.
 */

import { AppError } from "../utils/app-error.js";
import { logger } from "../utils/logger.js";

/**
 * Terminal 404 for unmatched routes — JSON, not Express's HTML page.
 *
 * The message is fixed rather than echoing the requested path back: reflecting
 * client input into a response body is a habit worth not having, and the method
 * and path are already in the request log.
 */
export function notFoundHandler(_req, res) {
  res.status(404).json({ error: "Not found" });
}

/**
 * Map body-parser's errors onto client-safe equivalents.
 * @returns {{status: number, message: string} | null}
 */
function bodyParserFailure(err) {
  if (err?.type === "entity.parse.failed") {
    return { status: 400, message: "Invalid JSON body" };
  }
  if (err?.type === "entity.too.large") {
    return { status: 413, message: "Request body too large" };
  }
  return null;
}

/**
 * Express error middleware. Must keep all four parameters — Express identifies
 * error handlers by arity.
 */
export function errorHandler(err, req, res, _next) {
  let status = 500;
  let message = "Internal server error";

  if (err instanceof AppError) {
    status = err.statusCode;
    message = err.message;
  } else {
    const parseFailure = bodyParserFailure(err);
    if (parseFailure) {
      ({ status, message } = parseFailure);
    }
  }

  // 5xx means we broke; log the full error including cause and stack. 4xx is
  // the client's problem and only worth a one-liner.
  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${status}`, err);
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${status}: ${message}`);
  }

  if (res.headersSent) {
    return res.end();
  }

  res.status(status).json({ error: message });
}

/**
 * Wrap an async handler so a rejected promise reaches `errorHandler`.
 *
 * Express 5 forwards rejections from async middleware automatically, so this is
 * belt-and-braces — it makes the intent explicit at each call site and keeps the
 * controllers working if the app is ever mounted under Express 4.
 */
export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
