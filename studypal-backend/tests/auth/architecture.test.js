import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import { assertUserId } from '../../src/auth/identity.js';
const source=new URL('../../src/',import.meta.url);
const read=async path=>(await fs.readFile(new URL(path,source),'utf8')).replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
describe('SP-V2-008 immutable identity and authorization architecture',()=>{
 it('guards all current and future feature API mounts at a shared authentication boundary',async()=>{
  const routes=await read('routes/index.js');const gate=routes.indexOf('routes.use("/api", requireAuthentication)');assert.ok(gate>=0);
  for(const name of ['sessionRoutes','questionRoutes','materialRoutes','studyPlanRoutes','examRoutes','analyticsRoutes']) assert.ok(routes.indexOf(`routes.use("/api", ${name})`)>gate,name);
 });
 it('every user-owned feature controller forwards the trusted immutable ID',async()=>{
  for(const file of ['controllers/questions.controller.js','materials/material.controller.js','materials/material-chat.controller.js','study-plans/study-plan.controller.js','exams/exam.controller.js','analytics/analytics.controller.js']) {
   const text=await read(file);assert.match(text,/req\.user\.id/,file);assert.doesNotMatch(text,/req\.(?:query|body|params)\.(?:userId|user_id|username)|req\.validated\.username/,file);
  }
 });
 it('services never resolve ownership through usernames or implicitly create accounts',async()=>{
  for(const file of ['services/question.service.js','materials/material.service.js','materials/material-chat.service.js','study-plans/study-plan.service.js','exams/exam.service.js','analytics/analytics.service.js']) {
   const text=await read(file);assert.match(text,/assertUserId/,file);assert.doesNotMatch(text,/user\.repository|findIdByUsername|users\.upsert|\busername\b/,file);
  }
 });
 it('rejects missing, profile-string, malformed or unsafe user IDs at the service boundary',()=>{
  for(const id of [undefined,null,'alice','1',0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>assertUserId(id),{statusCode:401});assert.equal(assertUserId(1),1);
 });
 it('limits uploads before multer and other expensive operations before controllers',async()=>{
  const materials=await read('materials/material.routes.js');assert.ok(materials.indexOf('expensiveOperationLimit("upload")')<materials.indexOf('  acceptMaterialFile,'));
  assert.ok(materials.indexOf('expensiveOperationLimit("chat")')<materials.lastIndexOf('  validateChatBody,'));
  for(const file of ['exams/exam.routes.js','study-plans/study-plan.routes.js','routes/questions.routes.js']) assert.match(await read(file),/expensiveOperationLimit/);
 });
 it('frontend sends cookies centrally without browser token storage or username ownership payloads',async()=>{
  const client=await fs.readFile(new URL('../../../studypal-frontend/app/auth-client.js',import.meta.url),'utf8');assert.match(client,/credentials:\s*"include"/);
  for(const file of ['page.jsx','exam/page.jsx','analytics/page.jsx','auth-provider.jsx']) {
   const text=await fs.readFile(new URL(`../../../studypal-frontend/app/${file}`,import.meta.url),'utf8');assert.doesNotMatch(text,/localStorage|sessionStorage/);
   if(file!=='auth-provider.jsx') assert.doesNotMatch(text,/\?username=|append\("username"|JSON\.stringify\(\{\s*username/);
  }
 });
});
