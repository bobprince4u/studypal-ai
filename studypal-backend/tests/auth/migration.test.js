import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createIsolatedDatabase, resetSchema } from '../helpers/test-database.mjs';
import { migrate, MIGRATIONS_DIR } from '../../src/db/migrator.js';
import { seedOwnedResources, snapshotLearningData, learningTables } from '../helpers/owned-resources.mjs';
let database,pool,directory;
after(async()=>{await pool?.end();await database?.drop();if(directory) await fs.rm(directory,{recursive:true,force:true});});
describe('SP-V2-008 migration over populated legacy data',()=>{
 it('preserves all user-owned data and composite foreign keys',async()=>{
  database=await createIsolatedDatabase({label:'authupgrade'});pool=new pg.Pool({connectionString:database.url});await resetSchema(pool);
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'studypal-auth-old-schema-'));
  for(const filename of await fs.readdir(MIGRATIONS_DIR)) if(/^00[1-5]_/.test(filename)) await fs.copyFile(path.join(MIGRATIONS_DIR,filename),path.join(directory,filename));
  assert.equal((await migrate({pool,dir:directory,quiet:true})).applied.length,5);
  for(const username of ['legacy_a',' legacy_a ','legacy_b']) {
   const user=(await pool.query('INSERT INTO users(username,email,display_name) VALUES($1,$2,$1) RETURNING id',[username,`legacy-${username.length}-${username.trim()}@example.test`])).rows[0];
   await seedOwnedResources(pool,user.id,`legacy-${user.id}`);
  }
  const before=await snapshotLearningData(pool,{credentials:false}),constraints=await foreignKeys();
  assert.deepEqual((await migrate({pool,quiet:true})).applied,['006_authentication.sql']);
  assert.deepEqual(await snapshotLearningData(pool,{credentials:false}),before);assert.deepEqual(await foreignKeys(),constraints);
  const users=(await pool.query('SELECT password_hash FROM users')).rows;assert.equal(users.length,3);assert.ok(users.every(u=>u.password_hash===null));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_sessions')).rows[0].n,0);
 });
 it('has no orphans and all foreign keys remain validated',async()=>{
  for(const table of ['materials','study_plans','exams','questions']) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} t LEFT JOIN users u ON u.id=t.user_id WHERE u.id IS NULL`)).rows[0].n,0,table);
  for(const [table,parent,key] of [['material_chunks','materials','material_id'],['study_plan_tasks','study_plans','study_plan_id'],['exam_questions','exams','exam_id'],['exam_attempts','exams','exam_id'],['attempt_answers','exam_attempts','attempt_id']]) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} t LEFT JOIN ${parent} p ON p.id=t.${key} WHERE p.id IS NULL`)).rows[0].n,0,table);
  assert.ok((await foreignKeys()).every(k=>k.convalidated));
 });
 it('repeated migration is a no-op and cross-owner inserts still fail',async()=>{
  assert.deepEqual((await migrate({pool,quiet:true})).applied,[]);
  const users=(await pool.query('SELECT id FROM users ORDER BY id')).rows;
  const plan=(await pool.query('SELECT id FROM study_plans WHERE user_id=$1',[users[0].id])).rows[0];
  await assert.rejects(pool.query(`INSERT INTO study_plan_tasks(study_plan_id,user_id,scheduled_date,position,title,task_type,duration_minutes) VALUES($1,$2,CURRENT_DATE,5,'Forbidden','study',30)`,[plan.id,users[1].id]),{code:'23503'});
  const exam=(await pool.query('SELECT id FROM exams WHERE user_id=$1',[users[0].id])).rows[0];
  await assert.rejects(pool.query('INSERT INTO exam_attempts(exam_id,user_id) VALUES($1,$2)',[exam.id,users[1].id]),{code:'23503'});
 });
});
async function foreignKeys(){return (await pool.query(`SELECT conname,pg_get_constraintdef(oid) AS definition,convalidated FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text=ANY($1::text[]) ORDER BY conname`,[learningTables])).rows;}
