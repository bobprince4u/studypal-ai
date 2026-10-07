/** Read-only environment/count/FK inventory. Never prints credentials or profiles. */
process.env.LOG_LEVEL = "silent";
const { config } = await import("../src/config/env.js");
const { getPool, closeDatabase } = await import("../src/config/database.js");
const { readMigrations } = await import("../src/db/migrator.js");
const quote = value => `"${value.replaceAll('"', '""')}"`;
let client;
try {
  client = await getPool().connect();
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const url = new URL(config.database.url);
  const metadata = (await client.query("SELECT current_database() AS database,current_user AS database_user,current_setting('server_version') AS postgres_version")).rows[0];
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
  const counts = {};
  const owners = {};
  for (const table of tables) {
    counts[table] = Number((await client.query(`SELECT count(*) AS count FROM public.${quote(table)}`)).rows[0].count);
    const hasOwner = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='user_id'", [table])).rowCount;
    if (hasOwner) owners[table] = (await client.query(`SELECT user_id,count(*)::integer AS count FROM public.${quote(table)} GROUP BY user_id ORDER BY user_id`)).rows;
  }
  const foreignKeys = (await client.query(`
    SELECT c.conname,c.convalidated,child.relname AS child,parent.relname AS parent,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS child_columns,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.pos) AS parent_columns
    FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
    WHERE c.contype='f' AND c.connamespace='public'::regnamespace ORDER BY c.conname
  `)).rows;
  const violations = [];
  for (const fk of foreignKeys) {
    const matches = fk.child_columns.map((column,i) => `child.${quote(column)}=parent.${quote(fk.parent_columns[i])}`).join(" AND ");
    // MATCH SIMPLE permits a nullable optional relation, including composite FKs.
    const present = fk.child_columns.map(column => `child.${quote(column)} IS NOT NULL`).join(" AND ");
    const count = Number((await client.query(`SELECT count(*) AS count FROM public.${quote(fk.child)} child LEFT JOIN public.${quote(fk.parent)} parent ON ${matches} WHERE ${present} AND parent.${quote(fk.parent_columns[0])} IS NULL`)).rows[0].count);
    if (count) violations.push({constraint:fk.conname,count});
  }
  const semanticChecks = {};
  if (tables.includes("attempt_answers")) semanticChecks.answerExamOwnership = Number((await client.query("SELECT count(*) AS count FROM attempt_answers a JOIN exam_attempts t ON t.id=a.attempt_id JOIN exam_questions q ON q.id=a.exam_question_id WHERE a.user_id<>q.user_id OR t.exam_id<>q.exam_id")).rows[0].count);
  if (tables.includes("exam_questions")) semanticChecks.sourceChunkMaterial = Number((await client.query("SELECT count(*) AS count FROM exam_questions q JOIN material_chunks c ON c.id=q.source_chunk_id WHERE q.source_material_id IS NOT NULL AND c.material_id<>q.source_material_id")).rows[0].count);
  const hasPassword = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='password_hash'")).rowCount;
  const credentials = hasPassword ? (await client.query("SELECT count(*) FILTER (WHERE password_hash IS NULL)::integer AS locked,count(*) FILTER (WHERE password_hash IS NOT NULL)::integer AS credentialed,count(*) FILTER (WHERE password_hash IS NOT NULL AND password_hash !~ '^scrypt\\$[a-f0-9]{32}\\$[a-f0-9]{128}$')::integer AS invalid_hash_format FROM users")).rows[0] : null;
  const applied = tables.includes("schema_migrations") ? (await client.query("SELECT filename,checksum,applied_at FROM schema_migrations ORDER BY filename")).rows : [];
  const disk = await readMigrations();
  const migrations = disk.map(file => {
    const record = applied.find(item => item.filename === file.filename);
    return {filename:file.filename,applied:!!record,changed:!!record && record.checksum !== file.checksum,appliedAt:record?.applied_at ?? null};
  });
  await client.query("COMMIT");
  const invalid = foreignKeys.filter(fk => !fk.convalidated).length;
  console.log(JSON.stringify({timestamp:new Date().toISOString(),environment:process.env.NODE_ENV || "development",host:url.hostname,port:url.port || "5432",...metadata,counts,owners,credentials,migrations,foreignKeys:foreignKeys.length,unvalidatedForeignKeys:invalid,orphanedRelationships:violations.reduce((sum,item) => sum+item.count,0),violations,semanticChecks},null,2));
  if (invalid || violations.length || Object.values(semanticChecks).some(Boolean) || credentials?.invalid_hash_format || migrations.some(item => !item.applied || item.changed)) process.exitCode = 1;
} catch (error) {
  // PostgreSQL errors can include connection details; never serialize the error.
  console.error(JSON.stringify({status:"VERIFICATION_FAILED",code:error.code || "UNKNOWN"}));
  process.exitCode = 1;
} finally {
  if (client) {await client.query("ROLLBACK").catch(() => {});client.release();}
  await closeDatabase();
}
