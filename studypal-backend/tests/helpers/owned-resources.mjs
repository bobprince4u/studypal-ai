/** Real persisted ownership graph usable both before and after auth migration. */
export async function seedOwnedResources(pool, userId, label) {
  const insert = async (sql, values) => (await pool.query(sql, values)).rows[0].id;
  const material = await insert(`INSERT INTO materials(user_id,original_filename,storage_key,mime_type,file_size,status,indexing_status)
    VALUES($1,$2,$3,'text/plain',64,'ready','indexed') RETURNING id`, [userId,`${label}.txt`,`${label}-document.txt`]);
  const chunk = await insert(`INSERT INTO material_chunks(material_id,chunk_index,content,char_count)
    VALUES($1,0,$2,char_length($2)) RETURNING id`, [material,`Private source text for ${label}`]);
  const plan = await insert(`INSERT INTO study_plans(user_id,title,subject,goal,start_date,end_date,exam_date,daily_minutes,difficulty_level,study_days,topics,material_ids)
    VALUES($1,$2,'Biology','Learn biology',CURRENT_DATE,CURRENT_DATE,CURRENT_DATE+7,30,'beginner',ARRAY['monday'],ARRAY['Cells'],ARRAY[$3]::bigint[]) RETURNING id`, [userId,`${label} plan`,material]);
  const task = await insert(`INSERT INTO study_plan_tasks(study_plan_id,user_id,scheduled_date,position,title,task_type,duration_minutes,material_id)
    VALUES($1,$2,CURRENT_DATE,0,'Review cells','study',30,$3) RETURNING id`,[plan,userId,material]);
  const exam = await insert(`INSERT INTO exams(user_id,title,subject,difficulty,question_count,source_type,topics,material_ids)
    VALUES($1,$2,'Biology','medium',1,'material',ARRAY['Cells'],ARRAY[$3]::bigint[]) RETURNING id`, [userId,`${label} exam`,material]);
  const question = await insert(`INSERT INTO exam_questions(exam_id,user_id,question_order,question_type,question_text,options,correct_answer,explanation,source_material_id,source_chunk_id)
    VALUES($1,$2,1,'true_false','Cells are living units.',$3::jsonb,'true','Cells are fundamental units of life.',$4,$5) RETURNING id`,
    [exam,userId,JSON.stringify([{id:'true',text:'True'},{id:'false',text:'False'}]),material,chunk]);
  const attempt = await insert('INSERT INTO exam_attempts(exam_id,user_id) VALUES($1,$2) RETURNING id',[exam,userId]);
  const completedAttempt = await insert(`INSERT INTO exam_attempts(exam_id,user_id,status,submitted_at,score,total_questions,correct_answers,percentage,passed)
    VALUES($1,$2,'completed',now(),1,1,1,100,true) RETURNING id`,[exam,userId]);
  const answer = await insert(`INSERT INTO attempt_answers(attempt_id,user_id,exam_question_id,selected_answer,is_correct)
    VALUES($1,$2,$3,'true',true) RETURNING id`,[completedAttempt,userId,question]);
  const chat = await insert(`INSERT INTO questions(user_id,question,answer,topic)
    VALUES($1,$2,$3::jsonb,'Cells') RETURNING id`,[userId,`${label} private question`,JSON.stringify({explanation:`${label} private answer`})]);
  return {userId,material,chunk,plan,task,exam,question,attempt,completedAttempt,answer,chat};
}

export const learningTables = ['users','materials','material_chunks','study_plans','study_plan_tasks','exams','exam_questions','exam_attempts','attempt_answers','questions'];
export async function snapshotLearningData(pool, { credentials = true } = {}) {
  const result = {};
  for (const table of learningTables) {
    const rows = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    if (!credentials && table === 'users') for (const row of rows) delete row.password_hash;
    result[table] = rows;
  }
  return result;
}
