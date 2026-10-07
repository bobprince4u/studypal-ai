import { createHash } from "node:crypto";
import { config } from "../config/env.js";
import { AppError } from "../utils/app-error.js";
import * as repository from "./auth.repository.js";
export const cookieName = config.isProduction ? "__Host-studypal_session" : "studypal_session";
export const digest = token => createHash("sha256").update(token).digest("hex");
export function sessionToken(req) {
  const values = (req.headers.cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${cookieName}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function csrfProtection(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  const allowed = config.cors.origins.includes(origin) || (!config.isProduction && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? ""));
  if (req.headers["x-studypal-request"] !== "1" || (origin && !allowed)) {
    throw new AppError(403, "Request origin verification failed.");
  }
  next();
}
export async function requireAuthentication(req, res, next) {
  res.set("Cache-Control", "no-store");
  const token = sessionToken(req);
  const user = token ? await repository.session(digest(token)) : null;
  if (!user) throw new AppError(401, "Authentication required.");
  req.user = Object.freeze(user);
  req.auth = req.user; // Compatibility alias for the auth/session handlers.
  next();
}
// Runs after multer as well as at the shared API boundary. Client identity is
// never used; reject conflicting claims so stale clients cannot act on another account.
export function authenticatedUsername(req, claimed) {
  if (!req.auth) throw new AppError(401, "Authentication required.");
  if (claimed !== undefined) {
    if (typeof claimed !== "string" || !claimed.trim()) throw new AppError(400, "Username is required.");
    if (claimed.includes("\0")) throw new AppError(400, "Username contains an invalid character.");
    if (claimed.trim().length > config.limits.usernameLength) throw new AppError(400, `Username must be ${config.limits.usernameLength} characters or fewer.`);
    if (claimed !== req.auth.username && claimed.trim() !== req.auth.username) throw new AppError(403, "Identity does not match the authenticated account.");
  }
  return req.auth.username;
}
