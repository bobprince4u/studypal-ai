import { randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { AppError } from "../utils/app-error.js";
import { promisify } from "node:util";
const scrypt = promisify(derive);
let active = 0;
const options = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
export async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  if (active >= 2) throw new AppError(503, "Authentication is busy. Try again shortly.");
  active++;
  try {
    const hash = await scrypt(password, salt, 64, options);
    return `scrypt$${salt}$${hash.toString("hex")}`;
  } finally { active--; }
}
export async function verifyPassword(password, stored) {
  const parts = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(stored ?? "");
  // Equal work for unknown users and locked legacy accounts.
  const candidate = await hashPassword(password, parts?.[1] ?? "0".repeat(32));
  return !!parts && timingSafeEqual(Buffer.from(candidate.split("$")[2], "hex"), Buffer.from(parts[2], "hex"));
}
