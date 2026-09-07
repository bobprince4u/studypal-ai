/**
 * Application error type.
 *
 * Layers below the HTTP boundary throw these instead of formatting responses
 * themselves; the central error handler turns them into JSON.
 *
 * `message` is always safe to send to a client — that is the invariant. Detail
 * that must not leak (upstream provider messages, stack traces, file paths)
 * goes in `cause`, which is logged server-side and never serialised.
 */

export class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status to respond with
   * @param {string} message    client-safe message
   * @param {object} [options]
   * @param {unknown} [options.cause] underlying error, logged but never sent
   * @param {string} [options.code]   stable internal identifier for logs
   */
  constructor(statusCode, message, { cause, code } = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** 400 — the request itself is not acceptable. */
export const badRequest = (message, options) =>
  new AppError(400, message, options);

/**
 * 404 — no such resource, as far as this caller is concerned.
 *
 * Note the "as far as this caller is concerned". The material endpoints use this
 * for a resource that exists but belongs to someone else, deliberately, rather
 * than a 403: a 403 confirms the id is real, which is information an
 * unauthenticated caller should not be able to enumerate.
 */
export const notFound = (message, options) => new AppError(404, message, options);

/** 413 — the request or an upload exceeded a configured limit. */
export const payloadTooLarge = (message, options) =>
  new AppError(413, message, options);

/** 415 — the upload's type is not supported. */
export const unsupportedMediaType = (message, options) =>
  new AppError(415, message, options);

/** 500 — something downstream of us failed. */
export const internal = (message, options) =>
  new AppError(500, message, options);
