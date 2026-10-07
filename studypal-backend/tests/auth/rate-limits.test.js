import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { startServer } from '../helpers/server-harness.mjs';
let server,pool,session,id;
const password='an isolated rate limiting passphrase';
const headers={'x-studypal-request':'1'};
const digest=value=>createHash('sha256').update(value).digest('hex');
before(async()=>{
 server=await startServer({label:'ratelimits',env:{STUDYPAL_RATE_UPLOAD_LIMIT:'1',STUDYPAL_RATE_CHAT_LIMIT:'1',STUDYPAL_RATE_STUDY_PLAN_LIMIT:'1',STUDYPAL_RATE_EXAM_LIMIT:'1',STUDYPAL_RATE_ASK_LIMIT:'1'}});
 pool=new pg.Pool({connectionString:server.databaseUrl});
 const result=await server.request('POST','/api/auth/register',{json:{username:'rate_test',password},headers});assert.equal(result.status,201);id=result.body.id;session=result.headers.get('set-cookie').split(';')[0];
});
after(async()=>{await pool?.end();await server?.stop();});
const call=(path,json={},extra={})=>server.request('POST',path,{json,headers:{...headers,cookie:session,...extra}});
describe('SP-V2-008 separate auth and expensive-operation limits',()=>{
 it('limits uploads before multipart parsing and storage',async()=>{
  const options={body:'not multipart',headers:{...headers,cookie:session,'content-type':'multipart/form-data'}};
  assert.equal((await server.request('POST','/api/materials',options)).status,400);limited(await server.request('POST','/api/materials',options));assert.deepEqual(await server.storedFiles(),[]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM materials')).rows[0].n,0);
 });
 for(const [operation,path] of [['chat','/api/materials/chat'],['studyPlan','/api/study-plans'],['exam','/api/exams'],['ask','/api/ask']]) it(`limits ${operation} before validation and provider calls`,async()=>{
  assert.equal((await call(path)).status,400);limited(await call(path));
  assert.equal((await pool.query('SELECT attempts FROM auth_rate_limits WHERE key=$1',[digest(`expensive:${operation}:user:${id}`)])).rows[0].attempts,2);
 });
 it('shares the study-plan generation and regeneration quota',async()=>limited(await call('/api/study-plans/123/regenerate')));
 it('does not let client IDs or forwarded IPs evade quotas',async()=>limited(await call('/api/exams',{username:'other',userId:123},{'x-forwarded-for':'203.0.113.123'})));
 it('allows a fresh request after expiry',async()=>{
  await pool.query("UPDATE auth_rate_limits SET expires_at=now()-interval '1 second' WHERE key=$1",[digest(`expensive:exam:user:${id}`)]);assert.equal((await call('/api/exams')).status,400);
 });
 it('shares counters across instances while keeping users separate',async()=>{
  const second=await startServer({env:{STUDYPAL_TEST_DATABASE_URL:server.databaseUrl,STUDYPAL_RATE_CHAT_LIMIT:'1'}});
  try {
   limited(await second.request('POST','/api/materials/chat',{json:{},headers:{...headers,cookie:session}}));
   const registered=await server.request('POST','/api/auth/register',{json:{username:'other_rate_user',password},headers});assert.equal(registered.status,201);
   const other=registered.headers.get('set-cookie').split(';')[0];assert.equal((await server.request('POST','/api/materials/chat',{json:{},headers:{...headers,cookie:other}})).status,400);
  }finally{await second.stop();}
 });
 it('has separate login and password-operation quotas',async()=>{
  await pool.query("INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES($1,20,now()+interval '15 minutes')",[digest('auth:login:account:rate_test')]);
  limited(await server.request('POST','/api/auth/login',{json:{username:'rate_test',password},headers}));assert.equal((await server.request('GET','/api/auth/me',{headers:{cookie:session}})).status,200);assert.equal((await call('/api/auth/password')).status,400);
 });
 it('counts concurrent requests atomically',async()=>{
  const results=await Promise.all(Array.from({length:5},()=>call('/api/exams')));assert.ok(results.every(r=>r.status===429));
 });
});
function limited(result){assert.equal(result.status,429,result.text);assert.equal(result.body.code,'RATE_LIMITED');assert.equal(result.headers.get('retry-after'),'900');}
