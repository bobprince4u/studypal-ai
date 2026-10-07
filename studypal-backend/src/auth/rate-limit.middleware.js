import { config } from "../config/env.js";
import { AppError } from "../utils/app-error.js";
import { consumeLimit } from "./auth.repository.js";
import { digest } from "./auth.middleware.js";

/** Atomic PostgreSQL counters shared by every backend instance. */
export function authenticationLimit(operation) {
  return async (req, res, next) => {
    const username = req.user?.username ?? (typeof req.body?.username === "string" ? req.body.username : "");
    // Socket address only: clients cannot spoof a forwarded header to evade limits.
    const keys = [
      `auth:${operation}:ip:${req.socket.remoteAddress}`,
      `auth:${operation}:account:${username.slice(0,config.limits.usernameLength)}`,
    ];
    for (const key of keys) {
      await enforce(key, config.rateLimits[operation], res);
    }
    next();
  };
}

/** Runs after shared authentication and before body buffering/provider work. */
export function expensiveOperationLimit(operation) {
  return async (req, res, next) => {
    if (!req.user) throw new AppError(401, "Authentication required.");
    await enforce(`expensive:${operation}:user:${req.user.id}`, config.rateLimits[operation], res);
    next();
  };
}

async function enforce(key, maximum, res) {
  const windowSeconds = config.rateLimits.windowSeconds;
  if (await consumeLimit(digest(key), windowSeconds) > maximum) {
    res.set("Retry-After", String(windowSeconds));
    throw new AppError(429, "Too many requests. Try again later.", { code: "RATE_LIMITED" });
  }
}
