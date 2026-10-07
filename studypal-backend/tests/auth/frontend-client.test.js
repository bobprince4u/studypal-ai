import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import fs from 'node:fs/promises';
const source=await fs.readFile(new URL('../../../studypal-frontend/app/auth-client.js',import.meta.url),'utf8');
const { apiFetch }=await import(`data:text/javascript,${encodeURIComponent(source)}`);
let originalFetch,originalWindow;
before(()=>{originalFetch=globalThis.fetch;originalWindow=globalThis.window;globalThis.window=new EventTarget();});
after(()=>{globalThis.fetch=originalFetch;if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;});
describe('SP-V2-008 centralized browser API client',()=>{
 it('always includes session credentials and preserves caller headers',async()=>{
  globalThis.fetch=async(url,options)=>{assert.equal(options.credentials,'include');assert.equal(options.headers.get('content-type'),'application/json');assert.equal(options.headers.get('x-studypal-request'),'1');return new Response('{}');};
  await apiFetch('https://study.example/api/ask',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:'{}'});
 });
 it('adds the CSRF header to every mutation method',async()=>{
  globalThis.fetch=async(url,options)=>{assert.equal(options.headers.get('x-studypal-request'),'1');return new Response('{}');};
  for(const method of ['POST','PUT','PATCH','DELETE'])await apiFetch('/api/materials',{method});
 });
 it('does not add a mutation header to GET requests',async()=>{
  globalThis.fetch=async(url,options)=>{assert.equal(options.headers.get('x-studypal-request'),null);assert.equal(options.credentials,'include');return new Response('{}');};await apiFetch('/api/analytics');
 });
 it('announces expired protected sessions without consuming the error response',async()=>{
  let events=0;const listener=()=>events++;window.addEventListener('studypal-session-expired',listener);
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Authentication required.'}),{status:401});
  const response=await apiFetch('/api/materials');assert.equal(events,1);assert.equal((await response.json()).error,'Authentication required.');window.removeEventListener('studypal-session-expired',listener);
 });
 it('preserves login failures and forbidden responses for their calling view',async()=>{
  let events=0;const listener=()=>events++;window.addEventListener('studypal-session-expired',listener);
  globalThis.fetch=async()=>new Response('{}',{status:401});assert.equal((await apiFetch('/api/auth/login',{method:'POST'})).status,401);
  globalThis.fetch=async()=>new Response('{}',{status:403});assert.equal((await apiFetch('/api/materials/1')).status,403);assert.equal(events,0);window.removeEventListener('studypal-session-expired',listener);
 });
});
