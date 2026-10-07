import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { startServer } from '../helpers/server-harness.mjs';
let server, pool, alice, bob;
const password='a sufficiently long test password';
const headers={'x-studypal-request':'1'};
const cookie = res => res.headers.get('set-cookie').split(';')[0];
const register = username => server.request('POST','/api/auth/register',{json:{username,password},headers});
before(async()=>{server=await startServer({label:'auth'});pool=new pg.Pool({connectionString:server.databaseUrl});});
after(async()=>{await pool?.end();await server?.stop();});
describe('SP-V2-008 authentication boundary',()=>{
 it('requires authentication for every feature family before validation or upload',async()=>{
  for(const path of ['/api/session','/api/ask','/api/materials','/api/materials/chat','/api/study-plans','/api/exams','/api/exam-attempts','/api/analytics','/api/history/alice','/api/progress/alice']) {
   const method=['/api/session','/api/ask','/api/materials/chat'].includes(path)?'POST':'GET';
   assert.equal((await server.request(method,path,{headers})).status,401,path);
  }
 });
 it('keeps health public',async()=>assert.equal((await server.request('GET','/health')).status,200));
 it('rejects credential requests without the CSRF header',async()=>assert.equal((await server.request('POST','/api/auth/register',{json:{username:'alice',password}})).status,403));
 it('rejects untrusted browser origins even with the custom header',async()=>assert.equal((await server.request('POST','/api/auth/register',{json:{username:'alice',password},headers:{...headers,origin:'https://evil.example'}})).status,403));
 it('rejects short passwords',async()=>assert.equal((await server.request('POST','/api/auth/register',{json:{username:'alice',password:'short'},headers})).status,400));
 it('registers with a private cookie and no credentials in the response',async()=>{
  const result=await register('alice');assert.equal(result.status,201);alice=cookie(result);
  assert.deepEqual(Object.keys(result.body).sort(),['created_at','id','username']);
  assert.match(result.headers.get('set-cookie'),/HttpOnly/);assert.match(result.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal(result.headers.get('cache-control'),'no-store');
  const user=(await pool.query("SELECT password_hash FROM users WHERE username='alice'")).rows[0];
  assert.match(user.password_hash,/^scrypt\$/);assert.ok(!user.password_hash.includes(password));
  const tokens=(await pool.query('SELECT token_hash FROM auth_sessions')).rows;
  assert.equal(tokens.length,1);assert.notEqual(tokens[0].token_hash,alice.split('=')[1]);
 });
 it('cannot register an existing account or claim legacy data',async()=>{
  assert.equal((await register('alice')).status,409);
  await pool.query("INSERT INTO users(username) VALUES('legacy')");
  assert.equal((await register('legacy')).status,409);
  assert.equal((await server.request('POST','/api/auth/login',{json:{username:'legacy',password},headers})).status,401);
 });
 it('uses the same error for unknown accounts and incorrect passwords',async()=>{
  const a=await server.request('POST','/api/auth/login',{json:{username:'unknown',password},headers});
  const b=await server.request('POST','/api/auth/login',{json:{username:'alice',password:'wrong'},headers});
  assert.equal(a.status,401);assert.deepEqual(a.body,b.body);
 });
 it('authenticates me using only the cookie',async()=>{
  const res=await server.request('GET','/api/auth/me',{headers:{cookie:alice}});assert.equal(res.status,200);assert.equal(res.body.username,'alice');
 });
 it('rejects a forged or duplicate cookie',async()=>{
  for(const value of ['studypal_session='+ 'a'.repeat(64),alice+'; '+alice,'studypal_session=garbage']) assert.equal((await server.request('GET','/api/auth/me',{headers:{cookie:value}})).status,401);
 });
 it('supports identity-free feature calls and rejects conflicting identity claims',async()=>{
  bob=cookie(await register('bob'));
  for(const path of ['/api/materials','/api/study-plans','/api/exam-attempts','/api/analytics']) {
   assert.equal((await server.request('GET',path,{headers:{cookie:alice}})).status,200,path);
   assert.equal((await server.request('GET',path+'?username=bob',{headers:{cookie:alice}})).status,403,path);
  }
  assert.equal((await server.request('GET','/api/history/bob',{headers:{cookie:alice}})).status,403);
  assert.equal((await server.request('POST','/api/session',{json:{username:'bob'},headers:{...headers,cookie:alice}})).status,403);
 });
 it('enforces persisted ownership when guessing another material id',async()=>{
  const form=new FormData();form.append('file',new Blob(['A useful study document about mathematics.'],{type:'text/plain'}),'math.txt');
  const upload=await server.request('POST','/api/materials',{form,headers:{...headers,cookie:alice}});
  assert.equal(upload.status,201,upload.text);
  const id=upload.body.id;
  for(const method of ['GET','DELETE']) assert.equal((await server.request(method,`/api/materials/${id}`,{headers:{...headers,cookie:bob}})).status,404);
 });
 it('rotates sessions on login and invalidates the replaced token',async()=>{
  const res=await server.request('POST','/api/auth/login',{json:{username:'alice',password},headers:{...headers,cookie:alice}});
  assert.equal(res.status,200);const old=alice;alice=cookie(res);assert.notEqual(old,alice);
  assert.equal((await server.request('GET','/api/auth/me',{headers:{cookie:old}})).status,401);
 });
 it('revokes logout sessions immediately and clears the cookie',async()=>{
  const res=await server.request('POST','/api/auth/logout',{headers:{...headers,cookie:bob}});assert.equal(res.status,204);assert.match(res.headers.get('set-cookie'),/Expires=Thu, 01 Jan 1970/);
  assert.equal((await server.request('GET','/api/auth/me',{headers:{cookie:bob}})).status,401);
 });
 it('changes the password only after verification and revokes every session',async()=>{
  const second=await server.request('POST','/api/auth/login',{json:{username:'alice',password},headers});
  const other=cookie(second);
  const bad=await server.request('POST','/api/auth/password',{json:{currentPassword:'wrong',newPassword:'a different long test password'},headers:{...headers,cookie:alice}});
  assert.equal(bad.status,401);
  const result=await server.request('POST','/api/auth/password',{json:{currentPassword:password,newPassword:'a different long test password'},headers:{...headers,cookie:alice}});
  assert.equal(result.status,204);
  for(const value of [alice,other]) assert.equal((await server.request('GET','/api/auth/me',{headers:{cookie:value}})).status,401);
  assert.equal((await server.request('POST','/api/auth/login',{json:{username:'alice',password},headers})).status,401);
  const login=await server.request('POST','/api/auth/login',{json:{username:'alice',password:'a different long test password'},headers});
  assert.equal(login.status,200);alice=cookie(login);
 });
 it('sets Secure host-prefixed cookies in production and serves health',async()=>{
  const production=await startServer({env:{NODE_ENV:'production',DATABASE_URL:server.databaseUrl,STUDYPAL_TEST_DATABASE_URL:server.databaseUrl,FRONTEND_URL:'https://study.example',CORS_ORIGINS:''}});
  try {
   assert.equal((await production.request('GET','/health')).status,200);
   const result=await production.request('POST','/api/auth/register',{json:{username:'production_test',password},headers:{...headers,origin:'https://study.example'}});
   assert.equal(result.status,201,result.text);
   const value=result.headers.get('set-cookie');assert.match(value,/^__Host-studypal_session=/);assert.match(value,/; Secure/);assert.match(value,/; HttpOnly/);assert.match(value,/; Path=\//);assert.ok(!value.includes('Domain='));
   assert.equal(result.headers.get('access-control-allow-origin'),'https://study.example');
   assert.equal(result.headers.get('access-control-allow-credentials'),'true');
  } finally {await production.stop();}
 });
 it('rejects expired persisted sessions',async()=>{
  // Move both dates, preserving the schema expiry-after-creation constraint.
  await pool.query("UPDATE auth_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE token_hash=$1",[createHash('sha256').update(alice.split('=')[1]).digest('hex')]);
  assert.equal((await server.request('GET','/api/auth/me',{headers:{cookie:alice}})).status,401);
 });
 it('rate limits unknown-account attempts across persisted requests',async()=>{
  // Seed the threshold so this security assertion does not waste 20 password derivations.
  const key=createHash('sha256').update('auth:login:account:limited').digest('hex');
  await pool.query("INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES($1,20,now()+interval '15 minutes')",[key]);
  const result=await server.request('POST','/api/auth/login',{json:{username:'limited',password},headers});
  assert.equal(result.status,429);assert.equal(result.headers.get('retry-after'),'900');
 });
});
