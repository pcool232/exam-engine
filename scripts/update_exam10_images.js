#!/usr/bin/env node
'use strict';
// Replaces all questions/options for exam #10 (BEC JC Design & Technology 2010 P1)
// with the corrected-image version, keeping the same exam_id.

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const EXAM_ID = 10;
const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node update_exam10_images.js <exam.json>');
  process.exit(1);
}
const resolved = path.resolve(process.cwd(), filePath);
const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
const questions = data.questions;

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function optionText(option) {
  if (typeof option === 'string') return option.trim();
  return String((option && option.text) || '').trim();
}
function optionImage(option) {
  if (typeof option === 'string') return null;
  return option && option.image ? String(option.image).trim() : null;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 20000,
  query_timeout: 90000,
  statement_timeout: 90000,
});

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const examCheck = await client.query('SELECT id, title FROM exams WHERE id = $1', [EXAM_ID]);
    if (examCheck.rows.length === 0) {
      throw new Error(`Exam #${EXAM_ID} not found`);
    }
    console.log('Updating exam:', examCheck.rows[0].title);

    const oldQ = await client.query('SELECT id FROM questions WHERE exam_id = $1', [EXAM_ID]);
    const oldIds = oldQ.rows.map(r => r.id);
    console.log(`Deleting ${oldIds.length} existing questions (and their options/answers)...`);

    if (oldIds.length) {
      await client.query(`DELETE FROM options WHERE question_id = ANY($1::int[])`, [oldIds]);
      // remove any attempt answers referencing these questions, if such a table exists
      await client.query(`DELETE FROM answers WHERE question_id = ANY($1::int[])`, [oldIds]);
      await client.query(`DELETE FROM questions WHERE exam_id = $1`, [EXAM_ID]);
    }

    const BATCH = 5;
    let position = 1;
    let saved = 0;

    for (let i = 0; i < questions.length; i += BATCH) {
      const batch = questions.slice(i, i + BATCH);

      const qPlaceholders = [];
      const qParams = [];
      let p = 1;
      for (const question of batch) {
        qPlaceholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        qParams.push(
          EXAM_ID,
          String(question.question).trim(),
          question.type === 'multiple' ? 'multiple' : 'single',
          question.image ? String(question.image).trim() : null,
          question.explanation ? String(question.explanation).trim() : null,
          Number(question.marks) > 0 ? Number(question.marks) : 1,
          position++,
        );
      }
      const qRes = await client.query(
        `INSERT INTO questions (exam_id, question_text, question_type, image, explanation, marks, position)
         VALUES ${qPlaceholders.join(', ')}
         RETURNING id`,
        qParams
      );

      const oPlaceholders = [];
      const oParams = [];
      let op = 1;
      let missingTextCount = 0;
      batch.forEach((question, qi) => {
        const questionId = qRes.rows[qi].id;
        const options = question.options || [];
        options.forEach((option, index) => {
          const label = (typeof option === 'object' && option.label) || LABELS[index] || String(index + 1);
          const text = optionText(option);
          const image = optionImage(option);
          if (!text && !image) missingTextCount++;
          const isCorrect = String(question.correct).trim().toUpperCase() === String(label).trim().toUpperCase();
          oPlaceholders.push(`($${op++}, $${op++}, $${op++}, $${op++}, $${op++}, $${op++})`);
          oParams.push(questionId, label, text, image, isCorrect ? 1 : 0, index + 1);
        });
      });
      if (missingTextCount) {
        throw new Error(`${missingTextCount} option(s) in this batch have neither text nor image -- aborting before writing bad data`);
      }
      if (oPlaceholders.length) {
        await client.query(
          `INSERT INTO options (question_id, label, option_text, image, is_correct, position)
           VALUES ${oPlaceholders.join(', ')}`,
          oParams
        );
      }

      saved += qRes.rows.length;
      console.log(`  inserted ${saved}/${questions.length} questions`);
    }

    await client.query(
      `UPDATE exams SET updated_at = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1`,
      [EXAM_ID]
    );

    await client.query('COMMIT');
    console.log(`Done. Exam #${EXAM_ID} updated with ${saved} corrected questions.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('FAILED, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
