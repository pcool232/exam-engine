#!/usr/bin/env node
'use strict';
// Standalone importer with a much longer statement timeout than the app's
// shared pool (which is deliberately capped at 10s for production request
// safety). This script opens its own short-lived connection just for this
// one bulk insert of a large, image-heavy exam, in small batches so no
// single statement risks timing out.

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node direct_import.js <exam.json>');
  process.exit(1);
}
const resolved = path.resolve(process.cwd(), filePath);
const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
const examSettings = data.exam;
const questions = data.questions;

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function boolInt(v) {
  return v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0;
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

    const examRes = await client.query(
      `INSERT INTO exams (title, exam_code, subject, category, description, year, duration_minutes, pass_mark,
                          questions_per_attempt, shuffle_questions, shuffle_options, show_answers,
                          is_published, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        String(examSettings.title || '').trim(),
        examSettings.code ? String(examSettings.code).trim() : null,
        examSettings.subject || null,
        String(examSettings.category || '').trim().toUpperCase(),
        examSettings.description || null,
        examSettings.year || null,
        Number(examSettings.durationMinutes) || 60,
        Number(examSettings.passMark) || 50,
        Number(examSettings.questionsPerAttempt) || 0,
        boolInt(examSettings.shuffleQuestions),
        boolInt(examSettings.shuffleOptions),
        boolInt(examSettings.showAnswers),
        1, // publish
        null,
      ]
    );
    const examId = examRes.rows[0].id;
    console.log('created exam id', examId);

    const BATCH = 5; // small batches -- some questions carry big base64 images
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
          examId,
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
      batch.forEach((question, qi) => {
        const questionId = qRes.rows[qi].id;
        const options = question.options || [];
        options.forEach((option, index) => {
          const label = option.label || LABELS[index] || String(index + 1);
          const isCorrect = String(question.correct).trim().toUpperCase() === String(label).trim().toUpperCase();
          oPlaceholders.push(`($${op++}, $${op++}, $${op++}, $${op++}, $${op++}, $${op++})`);
          oParams.push(
            questionId,
            label,
            String(option.text || '').trim(),
            option.image ? String(option.image).trim() : null,
            isCorrect ? 1 : 0,
            index + 1,
          );
        });
      });
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
      [examId]
    );

    await client.query('COMMIT');
    console.log(`Done. Exam #${examId} "${examSettings.title}" created with ${saved} questions, published.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('FAILED, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
