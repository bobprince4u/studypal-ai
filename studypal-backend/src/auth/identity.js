import { AppError } from "../utils/app-error.js";

/** Services accept immutable IDs supplied by the authentication boundary. */
export function assertUserId(userId) {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new AppError(401, "Authentication required.");
  }
  return userId;
}
