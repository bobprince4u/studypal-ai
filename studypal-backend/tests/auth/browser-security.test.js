import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { startServer } from '../helpers/server-harness.mjs';
let server,session;
const headers={'x-studypal-request':'1'};
before(async()=>{
 server=await startServer({label:'csrf'});
 const response=await server.request('POST','/api/auth/register',{json:{username:'csrf_test',password:'a private isolated csrf test passphrase'},headers});
 assert.equal(response.status,201);session=response.headers.get('set-cookie').split(';')[0];
});
after(async()=>await server?.stop());
describe('SP-V2-008 browser CSRF, credentialed CORS and production configuration',()=>{
 for(const method of ['POST','PUT','PATCH','DELETE']) it(`rejects ${method} without the custom header or with a foreign origin`,async()=>{
  const path='/api/materials/123';
  assert.equal((await server.request(method,path,{headers:{cookie:session},json:{}})).status,403);
  assert.equal((await server.request(method,path,{headers:{...headers,cookie:session,origin:'https://foreign.example'},json:{}})).status,403);
 });
 it('allows trusted development preflight with credentials and custom header',async()=>{
  const result=await server.request('OPTIONS','/api/materials',{headers:{origin:'http://localhost:3000','access-control-request-method':'POST','access-control-request-headers':'content-type,x-studypal-request'}});
  assert.equal(result.status,204);assert.equal(result.headers.get('access-control-allow-origin'),'http://localhost:3000');assert.equal(result.headers.get('access-control-allow-credentials'),'true');assert.match(result.headers.get('access-control-allow-headers'),/X-StudyPal-Request/i);
 });
 it('never emits wildcard or credentialed access for a foreign browser origin',async()=>{
  const result=await server.request('GET','/api/auth/me',{headers:{cookie:session,origin:'https://foreign.example'}});
  assert.equal(result.headers.get('access-control-allow-origin'),null);assert.equal(result.headers.get('access-control-allow-credentials'),null);
 });
 for(const origin of ['', 'http://frontend.example', 'https://frontend.example/path', 'https://user:password@frontend.example']) it(`fails production startup for an invalid origin configuration (${origin ? 'invalid' : 'missing'})`,async()=>{
  await assert.rejects(startServer({env:{NODE_ENV:'production',DATABASE_URL:server.databaseUrl,STUDYPAL_TEST_DATABASE_URL:server.databaseUrl,FRONTEND_URL:origin,CORS_ORIGINS:''}}),/Production requires explicit HTTPS/);
 });
});
