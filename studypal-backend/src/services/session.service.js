/** Compatibility session view; identity must already be authenticated. */
import { AppError } from "../utils/app-error.js";
export async function startSession(user) {
  if (!user?.id || typeof user.username !== "string") throw new AppError(401,"Authentication required.");
  return { username:user.username, created_at:user.created_at };
}
