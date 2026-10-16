'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const users = require('../src/models/users');
const notify = require('../src/lib/notify');
const config = require('../src/config');

test('cleanPhone accepts Botswana numbers in the usual forms', () => {
  for (const v of ['71234567', '071 234 567', '26771234567', '+267 71 234 567', '+267-71-234-567']) {
    assert.equal(users.cleanPhone(v), '+26771234567', v);
  }
});

test('cleanPhone keeps foreign numbers that start with +, and rejects junk', () => {
  assert.equal(users.cleanPhone('+27 82 123 4567'), '+27821234567');
  assert.equal(users.cleanPhone(''), '');
  for (const v of ['12345', 'abc', '+26761234567', '7123456', '+0123456789']) {
    assert.equal(users.cleanPhone(v), null, v);
  }
});

test('the SMS fits one message, is plain ASCII and links to the exam', () => {
  const exam = { id: 14, category: 'JC', title: 'Design and Technology Paper 1 (17/1) - October/November 2021' };
  const body = notify.smsBody(exam);
  assert.ok(body.length <= 160, `${body.length} chars`);
  assert.match(body, /^[\x20-\x7E]+$/);
  assert.ok(body.includes(`${config.appUrl}/exams/14`));

  const long = notify.smsBody({ ...exam, title: 'X'.repeat(300) });
  assert.ok(long.length <= 160, `${long.length} chars`);
  assert.ok(long.includes('...'));
});

test('the email escapes the student name and exam title in HTML', () => {
  const mail = notify.emailFor(
    { id: 3, category: 'JC', title: 'Art <b>2022</b>' },
    { email: 's@example.com', full_name: 'Ana & Bo' }
  );
  assert.equal(mail.to, 's@example.com');
  assert.ok(mail.html.includes('Ana &amp; Bo'));
  assert.ok(mail.html.includes('Art &lt;b&gt;2022&lt;/b&gt;'));
  assert.ok(!mail.html.includes('<b>2022</b>'));
});

test('summarise reports each channel, and says when one is not set up', () => {
  assert.equal(
    notify.summarise({ students: 7, inbox: 7, emailed: 7, emailFailed: 0, texted: 0, smsFailed: 0, emailOn: true, smsOn: false }),
    'Students notified: 7 inbox, 7 emails, SMS not set up.'
  );
  assert.match(
    notify.summarise({ students: 2, inbox: 2, emailed: 1, emailFailed: 1, texted: 2, smsFailed: 0, emailOn: true, smsOn: true }),
    /1 could not be delivered/
  );
  assert.equal(notify.summarise({ students: 0 }), 'No students at this level to notify yet.');
});
