import { Router } from "express";
import { config } from "../config/env.js";
import { AppError } from "../utils/app-error.js";
import * as service from "./auth.service.js";
import { cookieName, sessionToken, requireAuthentication } from "./auth.middleware.js";
import { authenticationLimit } from "./rate-limit.middleware.js";
export const authRoutes = Router();
const cookieOptions = { httpOnly:true, secure:config.isProduction, sameSite:"strict", path:"/" };
const view = user => ({ id:user.id, username:user.username, created_at:user.created_at });
authRoutes.use((_req,res,next) => { res.set("Cache-Control","no-store"); next(); });
function credentials(req,registration) {
  const { username,password } = req.body ?? {};
  if (typeof username !== "string" || (registration ? !/^[a-zA-Z0-9_.-]{1,100}$/.test(username) : !username.trim() || username.length > config.limits.usernameLength || username.includes("\0")) || typeof password !== "string" || password.length > 128 || password.length < (registration ? 15 : 1)) {
    throw new AppError(400, registration ? "Use a username of 1–100 letters, digits, dots, underscores or hyphens and a password of 15–128 characters." : "Username and password required.");
  }
  return {username,password};
}
async function establish(req,res,user,status=200) {
  const token = await service.establish(user,sessionToken(req));
  res.cookie(cookieName,token,{...cookieOptions,maxAge:12*60*60*1000});
  res.status(status).json(view(user));
}
authRoutes.post("/register",authenticationLimit("register"),async(req,res) => {
  const {username,password} = credentials(req,true);
  const user = await service.register(username,password);
  await establish(req,res,user,201);
});
authRoutes.post("/login",authenticationLimit("login"),async(req,res) => {
  const {username,password} = credentials(req,false);
  const user = await service.login(username,password);
  await establish(req,res,user);
});
authRoutes.get("/me",requireAuthentication,(req,res) => res.json(view(req.auth)));
authRoutes.post("/logout",async(req,res) => {
  const token=sessionToken(req);
  await service.revoke(token);
  res.clearCookie(cookieName,cookieOptions).status(204).end();
});

authRoutes.post("/password",requireAuthentication,authenticationLimit("password"),async(req,res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== "string" || currentPassword.length > 128 || typeof newPassword !== "string" || newPassword.length < 15 || newPassword.length > 128) throw new AppError(400,"Current password and a new password of 15–128 characters required.");
  await service.changePassword(req.user.id,currentPassword,newPassword);
  res.clearCookie(cookieName,cookieOptions).status(204).end();
});
