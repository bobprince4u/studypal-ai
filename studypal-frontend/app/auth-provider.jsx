"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { apiFetch } from "./auth-client";
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);
export default function AuthProvider({ children }) {
  const [user,setUser] = useState(null);
  const [loading,setLoading] = useState(true);
  const [register,setRegister] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  useEffect(() => {
    let active=true;
    apiFetch(`${API}/api/auth/me`).then(async res => {
      if(res.ok) { const account=await res.json(); if(active) setUser(account); }
      else if(res.status!==401) throw new Error("Account service is unavailable.");
    }).catch(err => { if(active) setError(err.message); }).finally(() => { if(active) setLoading(false); });
    const expire=() => {setUser(null);setError("Your session expired. Please sign in again.");};
    window.addEventListener("studypal-session-expired",expire);
    return () => {active=false;window.removeEventListener("studypal-session-expired",expire);};
  },[]);
  async function submit(event) {
    event.preventDefault();setBusy(true);setError("");
    const fields=new FormData(event.currentTarget);
    try {
      const res=await apiFetch(`${API}/api/auth/${register ? "register" : "login"}`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:fields.get("username"),password:fields.get("password")})});
      const body=await res.json();if(!res.ok) throw new Error(body.error || "Sign in failed.");
      setRegister(false);setUser(body);
    } catch(err) {setError(err.message);} finally {setBusy(false);}
  }
  async function logout() {
    setBusy(true);setError("");
    try { const res=await apiFetch(`${API}/api/auth/logout`,{method:"POST"});if(!res.ok) throw new Error("Sign out failed. Please try again.");setUser(null); }
    catch(err){setError(err.message);} finally{setBusy(false);}
  }
  async function changePassword(event) {
    event.preventDefault();setBusy(true);setError("");
    const form=event.currentTarget;
    const fields=new FormData(form);
    try {
      const res=await apiFetch(`${API}/api/auth/password`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword:fields.get("currentPassword"),newPassword:fields.get("newPassword")})});
      if(!res.ok) {const body=await res.json();if(body.error === "Authentication required.") setUser(null);throw new Error(body.error || "Password change failed.");}
      form.reset();setUser(null);setError("Password changed. Sign in with your new password.");
    } catch(err){setError(err.message);} finally{setBusy(false);}
  }
  if(loading) return <main style={{padding:40}}>Loading your account…</main>;
  if(!user) return <main style={{maxWidth:440,margin:"80px auto",padding:24}}>
    <h1>StudyPal</h1><h2>{register ? "Create your account" : "Sign in"}</h2>
    <form onSubmit={submit} style={{display:"grid",gap:16}}>
      <label>Username<input name="username" autoComplete="username" required maxLength={register ? 100 : 200} pattern={register ? "[a-zA-Z0-9_.-]+" : undefined} style={{display:"block",width:"100%"}} /></label>
      <label>Password<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={register ? 15 : 1} maxLength={128} style={{display:"block",width:"100%"}} /></label>
      {register && <p>Use 15 or more characters. Existing StudyPal accounts need credentials provisioned by your administrator.</p>}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>{busy ? "Please wait…" : register ? "Create account" : "Sign in"}</button>
    </form>
    <button disabled={busy} onClick={() => {setRegister(!register);setError("");}} style={{marginTop:16}}>{register ? "Already have an account? Sign in" : "Create an account"}</button>
  </main>;
  return <AuthContext.Provider value={user}>
    <div style={{padding:"12px 24px",display:"flex",gap:16,alignItems:"center"}}><span>Signed in as {user.username}</span><button onClick={logout} disabled={busy}>Sign out</button>{error && <span role="alert">{error}</span>}</div>
    <details style={{margin:"0 24px 12px"}}><summary>Change password</summary>
      <form onSubmit={changePassword} style={{display:"flex",gap:12,flexWrap:"wrap",paddingTop:12}}>
        <label>Current password <input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label>
        <label>New password <input name="newPassword" type="password" autoComplete="new-password" required minLength={15} maxLength={128} /></label>
        <button disabled={busy}>Change password and sign out everywhere</button>
      </form>
    </details>
    {children}
  </AuthContext.Provider>;
}
