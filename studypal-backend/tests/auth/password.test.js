import assert from 'node:assert/strict';
import { it } from 'node:test';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';
it('salts identical passwords independently and verifies only the right password',async()=>{
 const password='a long and memorable test passphrase';
 const a=await hashPassword(password),b=await hashPassword(password);
 assert.notEqual(a,b);assert.equal(await verifyPassword(password,a),true);
 assert.equal(await verifyPassword('wrong password',a),false);
 assert.equal(await verifyPassword(password,null),false);
 assert.equal(await verifyPassword(password,'malformed'),false);
});
