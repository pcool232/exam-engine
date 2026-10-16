'use strict';
/**
 * Tells students a new exam is live, on every channel the deployment has:
 *   - an inbox message (always -- see models/inbox.js),
 *   - an email (when SMTP is configured -- see lib/mailer.js),
 *   - an SMS (when Twilio is configured and the student has a phone number --
 *     see lib/sms.js).
 * Email and SMS are best-effort: a failure for one student is counted and
 * logged, never thrown, so publishing an exam can't fail because a mailbox
 * bounced or a number was wrong.
 */

const config = require('../config');
const users = require('../models/users');
const inbox = require('../models/inbox');
const { sendMail } = require('./mailer');
const { sendSms, isConfigured: smsConfigured } = require('./sms');
const { escapeHtml } = require('../core/template');

// Each email opens its own SMTP connection, so a handful at a time keeps the
// whole announcement well inside a serverless function's time limit without
// tripping a relay's connection limits.
const CONCURRENCY = 5;

async function inBatches(items, worker) {
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane));
}

function examUrl(exam) {
  return `${config.appUrl}/exams/${exam.id}`;
}

/** The SMS text. Kept to plain ASCII so it fits single-message (GSM-7)
 *  limits where it can, and trimmed so long titles don't spill into a second
 *  billed message. */
function smsBody(exam) {
  const tail = ` is now on ${config.appName}. Practise it: ${examUrl(exam)}`;
  const head = `New ${exam.category} exam: `;
  let title = String(exam.title).replace(/[^\x20-\x7E]/g, '-');
  const room = 160 - head.length - tail.length;
  if (title.length > room) title = `${title.slice(0, Math.max(room - 3, 10)).trimEnd()}...`;
  return `${head}${title}${tail}`;
}

function emailFor(exam, student) {
  const url = examUrl(exam);
  const name = escapeHtml(student.full_name);
  const title = escapeHtml(exam.title);
  const appName = escapeHtml(config.appName);
  return {
    to: student.email,
    subject: `New exam on ${config.appName}: ${exam.title}`,
    text: `Hi ${student.full_name},\n\n`
      + `A new ${exam.category} exam, "${exam.title}", has just been published on ${config.appName}.\n\n`
      + `Practise it here: ${url}\n\n`
      + `Good luck with your revision.`,
    html: `<p>Hi ${name},</p>`
      + `<p>A new ${escapeHtml(exam.category)} exam, <strong>${title}</strong>, has just been published on ${appName}.</p>`
      + `<p><a href="${url}">Practise it now</a></p>`
      + `<p>Good luck with your revision.</p>`,
  };
}

/**
 * Announces a just-published exam to every active student at its level.
 * `channels` picks which of inbox/email/sms to use (all by default) -- the
 * admin's "Notify students" button uses it to send email or SMS for a paper
 * whose inbox notice already went out. Returns counts for the admin.
 */
async function announceExamPublished(exam, channels = {}) {
  const use = { inbox: true, email: true, sms: true, ...channels };
  const result = {
    students: 0, inbox: 0, emailed: 0, emailFailed: 0, texted: 0, smsFailed: 0,
    emailOn: Boolean(config.smtpHost), smsOn: smsConfigured(), use,
  };
  if (!exam || !exam.category) return result;

  const recipients = await users.listStudentsByCategory(exam.category);
  result.students = recipients.length;
  if (!recipients.length) return result;

  if (use.inbox) try {
    result.inbox = await inbox.sendToMany(recipients.map((r) => r.id), {
      kind: 'exam',
      title: `New exam available: ${exam.title}`,
      body: `A new ${exam.category} exam, "${exam.title}", has just been published. `
        + `Head to your dashboard to give it a go.`,
      examId: exam.id,
    });
  } catch (err) {
    console.error('[notify] failed to send exam-published inbox messages:', err);
  }

  if (use.email && result.emailOn) {
    await inBatches(recipients.filter((r) => r.email), async (student) => {
      try {
        if (await sendMail(emailFor(exam, student))) result.emailed++;
      } catch (err) {
        result.emailFailed++;
        console.error(`[notify] email to student #${student.id} failed:`, err.message);
      }
    });
  }

  if (use.sms && result.smsOn) {
    const body = smsBody(exam);
    await inBatches(recipients.filter((r) => r.phone), async (student) => {
      try {
        if (await sendSms({ to: student.phone, body })) result.texted++;
      } catch (err) {
        result.smsFailed++;
        console.error(`[notify] SMS to student #${student.id} failed:`, err.message);
      }
    });
  }

  return result;
}

/** One line for the admin, e.g. "Students notified: 7 inbox, 7 emails, 4 texts." */
function summarise(r) {
  if (!r || !r.students) return 'No students at this level to notify yet.';
  const use = r.use || { inbox: true, email: true, sms: true };
  const parts = [];
  if (use.inbox) parts.push(`${r.inbox} inbox`);
  if (use.email) parts.push(r.emailOn ? `${r.emailed} email${r.emailed === 1 ? '' : 's'}` : 'email not set up');
  if (use.sms) parts.push(r.smsOn ? `${r.texted} text${r.texted === 1 ? '' : 's'}` : 'SMS not set up');
  if (!parts.length) return 'Nothing was sent -- no channel was chosen.';
  const failed = r.emailFailed + r.smsFailed;
  return `Students notified: ${parts.join(', ')}.` + (failed ? ` ${failed} could not be delivered (see the server log).` : '');
}

module.exports = { announceExamPublished, summarise, smsBody, emailFor };
