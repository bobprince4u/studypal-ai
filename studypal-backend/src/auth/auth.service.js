import { randomBytes } from "node:crypto";
import { AppError } from "../utils/app-error.js";
import { hashPassword, verifyPassword } from "./password.js";
import * as repository from "./auth.repository.js";
import { digest } from "./auth.middleware.js";
export async function register(username,password) {
  const user=await repository.register(username,await hashPassword(password));
  if(!user) throw new AppError(409,"Account cannot be registered with these details.");
  return user;
}
export async function login(username,password) {
  const user=await repository.findUser(username);
  if(!await verifyPassword(password,user?.password_hash)) throw new AppError(401,"Invalid username or password.");
  return user;
}
export async function establish(user,previousToken) {
  const token=randomBytes(32).toString("hex");
  if(!await repository.issueSession(user.id,digest(token),previousToken ? digest(previousToken) : null,user.password_hash)) throw new AppError(401,"Account changed. Please sign in again.");
  return token;
}
export async function changePassword(userId,currentPassword,newPassword) {
  const user=await repository.findUserById(userId);
  if(!user || !await verifyPassword(currentPassword,user.password_hash)) throw new AppError(401,"Invalid username or password.");
  if(!await repository.replacePassword(user.id,user.password_hash,await hashPassword(newPassword))) throw new AppError(409,"Account changed. Please sign in again.");
}
export async function revoke(token) {if(token) await repository.revoke(digest(token));}
export const consumeLimit=repository.consumeLimit;
