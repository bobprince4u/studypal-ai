/** Operator-only provisioning. Never claim legacy data through a public API.
 * Supply {username,password} via stdin from a secret manager; no argv secrets.
 */
import { hashPassword } from '../src/auth/password.js';
import { withTransaction, closeDatabase } from '../src/config/database.js';
let input='';
try {
  for await(const chunk of process.stdin) {input+=chunk;if(input.length>4096) throw new Error('Input too large');}
  const {username,password}=JSON.parse(input);
  input='';
  if(typeof username!=='string' || !username.trim() || typeof password!=='string' || password.length<15 || password.length>128) throw new Error('Invalid account details');
  const passwordHash=await hashPassword(password);
  await withTransaction(async client=>{
    const result=await client.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE username=$2 RETURNING id',[passwordHash,username]);
    if(result.rowCount!==1) throw new Error('Account not found');
    await client.query('DELETE FROM auth_sessions WHERE user_id=$1',[result.rows[0].id]);
  });
  console.log('Credentials provisioned; all previous sessions revoked.');
} catch {console.error('Provisioning failed. Verify input and database availability.');process.exitCode=1;}
finally {await closeDatabase();}
