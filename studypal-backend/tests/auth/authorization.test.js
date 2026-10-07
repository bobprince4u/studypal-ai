import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import pg from 'pg';
import { startServer } from '../helpers/server-harness.mjs';
import { seedOwnedResources, snapshotLearningData } from '../helpers/owned-resources.mjs';
let server,pool,A,B,a,b;
const password='isolated test account passphrase';
const headers={'x-studypal-request':'1'};
const cookie=result=>result.headers.get('set-cookie').split(';')[0];
const request=(actor,method,path,json)=>server.request(method,path,{json,headers:{...headers,cookie:actor.cookie}});
before(async()=>{
 server=await startServer({label:'idor'});
 pool=new pg.Pool({connectionString:server.databaseUrl});
 for(const name of ['owner_a','owner_b']) {
  const result=await server.request('POST','/api/auth/register',{json:{username:name,password},headers});
  assert.equal(result.status,201,result.text);
  const actor={...result.body,cookie:cookie(result)};
  const graph=await seedOwnedResources(pool,actor.id,name);
  if(name==='owner_a'){A=actor;a=graph;}else{B=actor;b=graph;}
 }
});
after(async()=>{await pool?.end();await server?.stop();});
describe('SP-V2-008 cross-user and nested IDOR protection with raw sessions',()=>{
 it('does not let B read or delete A material or processing status',async()=>{
  for(const [method,path] of [['GET',`/api/materials/${a.material}`],['GET',`/api/materials/${a.material}/status`],['DELETE',`/api/materials/${a.material}`]]) {
   assert.equal((await request(B,method,path)).status,404,path);
  }
  const own=await request(A,'GET',`/api/materials/${a.material}`);assert.equal(own.status,200);
  assert.equal((await request(B,'GET','/api/materials')).body.length,1);
 });
 it('cannot use another material as chat/RAG scope or generation input',async()=>{
  assert.equal((await request(B,'POST','/api/materials/chat',{question:'Tell me about cells',materialId:a.material})).status,404);
  assert.equal((await request(B,'POST','/api/exams',{subject:'Biology',topics:['Cells'],questionCount:1,materialIds:[a.material]})).status,404);
  const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
  const plan=await request(B,'POST','/api/study-plans',{subject:'Biology',topics:['Cells'],examDate:date,dailyMinutes:30,difficultyLevel:'beginner',studyDays:['monday'],materialIds:[a.material]});
  assert.equal(plan.status,400,plan.text);assert.match(plan.body.error,/materials.*could not be found/i);
 });
 it('does not expose chunks or stored documents through guessed paths',async()=>{
  for(const path of [`/api/materials/${a.material}/chunks`,`/api/material-chunks/${a.chunk}`,`/api/materials/${a.material}/download`,`/api/uploads/owner_a-document.txt`,`/uploads/owner_a-document.txt`]) {
   assert.equal((await request(B,'GET',path)).status,404,path);
  }
 });
 it('does not let B read A plan, change its task or regenerate it',async()=>{
  assert.equal((await request(B,'GET',`/api/study-plans/${a.plan}`)).status,404);
  assert.equal((await request(B,'PATCH',`/api/study-plans/${a.plan}/tasks/${a.task}`,{status:'completed'})).status,404);
  assert.equal((await request(B,'POST',`/api/study-plans/${a.plan}/regenerate`,{})).status,404);
  assert.equal((await request(B,'PATCH',`/api/study-plans/${b.plan}/tasks/${a.task}`,{status:'completed'})).status,404);
  assert.equal((await request(A,'GET',`/api/study-plans/${a.plan}`)).status,200);
 });
 it('does not let B read A exam, create attempts or read/submit A attempts',async()=>{
  for(const [method,path,json] of [
   ['GET',`/api/exams/${a.exam}`],['POST',`/api/exams/${a.exam}/attempts`,{}],
   ['GET',`/api/exams/${a.exam}/attempts/${a.attempt}`],
   ['POST',`/api/exams/${a.exam}/attempts/${a.attempt}/submit`,{answers:[{questionId:a.question,answer:'true'}]}],
   ['GET',`/api/exams/${b.exam}/attempts/${a.attempt}`],
   ['POST',`/api/exams/${b.exam}/attempts/${a.attempt}/submit`,{answers:[{questionId:a.question,answer:'true'}]}],
  ]) assert.equal((await request(B,method,path,json)).status,404,path);
  assert.equal((await request(A,'GET',`/api/exams/${a.exam}`)).status,200);
  assert.equal((await request(B,'GET','/api/exam-attempts')).body.every(row=>row.examId===b.exam),true);
 });
 it('cannot read A analytics, history or profile by changing username claims',async()=>{
  for(const path of ['/api/analytics','/api/analytics/exams','/api/analytics/topics','/api/analytics/weak-areas','/api/analytics/materials','/api/materials','/api/study-plans','/api/exam-attempts']) {
   assert.equal((await request(B,'GET',`${path}?username=${A.username}`)).status,403,path);
  }
  assert.equal((await request(B,'GET',`/api/analytics/study-plans/${a.plan}`)).status,404);
  assert.equal((await request(B,'GET',`/api/history/${A.username}`)).status,403);
  assert.equal((await request(B,'GET',`/api/progress/${A.username}`)).status,403);
  assert.equal((await request(B,'POST','/api/session',{username:A.username})).status,403);
  const history=await request(B,'GET','/api/history');assert.equal(history.status,200);assert.equal(history.body.length,1);assert.match(history.body[0].question,/owner_b/);
  const summary=await request(B,'GET','/api/analytics');assert.equal(summary.status,200);assert.equal(summary.body.studyPlans.total,1);
 });
 it('ignores forged user IDs in JSON and keeps changes within authenticated ownership',async()=>{
  const result=await request(B,'PATCH',`/api/study-plans/${b.plan}/tasks/${b.task}`,{status:'completed',userId:A.id,user_id:A.id,user:{id:A.id}});
  assert.equal(result.status,200,result.text);
  assert.equal((await pool.query('SELECT status FROM study_plan_tasks WHERE id=$1',[a.task])).rows[0].status,'pending');
 });
 it('preserves ownership across username changes and whitespace-distinct legacy profiles',async()=>{
  await pool.query('UPDATE users SET username=$1 WHERE id=$2',['  owner_b renamed  ',B.id]);
  assert.equal((await request(B,'GET',`/api/materials/${b.material}`)).status,200);
  assert.equal((await request(B,'GET',`/api/materials/${a.material}`)).status,404);
  assert.equal((await request(B,'GET','/api/study-plans')).body[0].id,b.plan);
  assert.equal((await request(B,'GET','/api/auth/me')).body.id,B.id);
  await pool.query('UPDATE users SET username=$1 WHERE id=$2',[B.username,B.id]);
 });
 it('rejects cross-owner mutations without changing any learning records',async()=>{
  const before=await snapshotLearningData(pool);
  await request(B,'DELETE',`/api/materials/${a.material}`);
  await request(B,'PATCH',`/api/study-plans/${a.plan}/tasks/${a.task}`,{status:'completed'});
  await request(B,'POST',`/api/exams/${a.exam}/attempts`,{});
  await request(B,'POST',`/api/exams/${a.exam}/attempts/${a.attempt}/submit`,{answers:[]});
  assert.deepEqual(await snapshotLearningData(pool),before);
 });
});
