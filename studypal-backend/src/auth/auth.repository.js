import { query, withTransaction } from "../config/database.js";
export async function findUser(username) {
  return (await query("SELECT id, username, created_at, password_hash FROM users WHERE username=$1", [username])).rows[0];
}
export async function findUserById(userId) {
  return (await query("SELECT id, username, created_at, password_hash FROM users WHERE id=$1", [userId])).rows[0];
}
export async function register(username, passwordHash) {
  return (await query("INSERT INTO users(username,password_hash) VALUES($1,$2) ON CONFLICT(username) DO NOTHING RETURNING id,username,created_at,password_hash", [username,passwordHash])).rows[0];
}
export async function issueSession(userId, tokenHash, previousHash, passwordHash) {
  return withTransaction(async client => {
    const locked = await client.query("SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", [userId]);
    if (locked.rows[0]?.password_hash !== passwordHash) return false;
    if (previousHash) await client.query("DELETE FROM auth_sessions WHERE token_hash=$1", [previousHash]);
    await client.query("DELETE FROM auth_sessions WHERE expires_at <= now()");
    await client.query("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [tokenHash,userId]);
    return true;
  });
}
export async function session(tokenHash) {
  return (await query("SELECT u.id,u.username,u.created_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now() AND u.password_hash IS NOT NULL", [tokenHash])).rows[0];
}
export async function revoke(tokenHash) {
  await query("DELETE FROM auth_sessions WHERE token_hash=$1", [tokenHash]);
}
export async function consumeLimit(key, windowSeconds = 900) {
  await query("DELETE FROM auth_rate_limits WHERE expires_at <= now()");
  const { rows } = await query(`INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES($1,1,now()+make_interval(secs => $2))
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE auth_rate_limits.attempts+1 END,
    expires_at=CASE WHEN auth_rate_limits.expires_at <= now() THEN now()+make_interval(secs => $2) ELSE auth_rate_limits.expires_at END RETURNING attempts`, [key,windowSeconds]);
  return rows[0].attempts;
}

export async function replacePassword(userId, oldHash, newHash) {
  return withTransaction(async client => {
    const result = await client.query("UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2 AND password_hash=$3 RETURNING id", [newHash,userId,oldHash]);
    if (!result.rowCount) return false;
    await client.query("DELETE FROM auth_sessions WHERE user_id=$1", [userId]);
    return true;
  });
}
