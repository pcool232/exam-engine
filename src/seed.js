'use strict';
/**
 * Creates the administrator account and (on a fresh database) a demo exam.
 *   npm run seed            - create the admin if it does not exist
 *   npm run reset-db        - delete everything and start again
 */

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.warn(warning.stack || warning.message);
});

const fs = require('node:fs');
const config = require('./config');

const reset = process.argv.includes('--reset') || process.argv.includes('--force');

if (reset && fs.existsSync(config.databaseFile)) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${config.databaseFile}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  console.log('Existing database removed.');
}

const { getDb, closeDb } = require('./db');
const users = require('./models/users');
const exams = require('./models/exams');
const { parseQuestions } = require('./lib/parsers');

getDb();

/* ------------------------------------------------------------- admin -- */

let admin = users.findByEmail(config.seedAdminEmail);

if (admin) {
  console.log(`Administrator already exists: ${admin.email}`);
} else {
  admin = users.create({
    fullName: config.seedAdminName,
    email: config.seedAdminEmail,
    password: config.seedAdminPassword,
    role: 'admin',
  });
  console.log('\nAdministrator account created');
  console.log(`   email:    ${admin.email}`);
  console.log(`   password: ${config.seedAdminPassword}`);
  console.log('   Change this password after your first sign-in.\n');
}

/* -------------------------------------------------------- demo exam -- */

const DEMO_PAPER = `
1. Which planet in our solar system is known as the Red Planet?
A. Venus
B. Mars
C. Jupiter
D. Mercury
Answer: B
Explanation: Iron oxide (rust) on the surface gives Mars its reddish colour.

2. What is 15% of 200?
A. 15
B. 20
C. 30
D. 35
Answer: C
Explanation: 10% of 200 is 20, and 5% is 10, so 15% is 30.

3. Which TWO of the following are renewable sources of energy? (Choose two)
A. Coal
B. Wind
C. Natural gas
D. Solar
Correct Answers: B, D
Explanation: Wind and sunlight replenish naturally; coal and gas do not.

4. In which year did South Africa hold its first democratic election?
A. 1990
B. 1992
C. 1994
D. 1996
Answer: C
Explanation: The first non-racial general election was held in April 1994.

5. What is the chemical symbol for water?
A. WA
B. H2O
C. HO2
D. O2H
Answer: B
Explanation: Two hydrogen atoms bonded to one oxygen atom.

6. A train travels 240 km in 3 hours. What is its average speed?
A. 60 km/h
B. 70 km/h
C. 80 km/h
D. 90 km/h
Answer: C
Explanation: 240 divided by 3 equals 80.

7. Which of these is a prime number?
A. 21
B. 27
C. 29
D. 33
Answer: C
Explanation: 29 has no divisors other than 1 and itself.

8. What does CPU stand for in computing?
A. Central Processing Unit
B. Computer Personal Unit
C. Central Power Utility
D. Core Program Unit
Answer: A
Explanation: The CPU carries out the instructions of a computer program.
`;

const existingDemo = exams.listExams().find((exam) => exam.title === 'General Knowledge - Sample Paper');

if (existingDemo) {
  console.log('Sample exam already present - leaving it alone.');
} else {
  const exam = exams.createExam({
    title: 'General Knowledge - Sample Paper',
    examCode: 'DEMO-101',
    subject: 'General Knowledge',
    year: 'Sample',
    description: 'A short demonstration paper so you can see how the exam runner and marking work.',
    durationMinutes: 10,
    passMark: 50,
    questionsPerAttempt: 0,
    shuffleQuestions: true,
    shuffleOptions: true,
    showAnswers: true,
    isPublished: true,
  }, admin.id);

  const { questions, issues } = parseQuestions(DEMO_PAPER, { format: 'text' });
  const saved = exams.addQuestionsBulk(exam.id, questions);

  console.log(`Sample exam created with ${saved} questions.`);
  if (issues.length > 0) console.log('   (parser notes:', issues.length, 'skipped blocks)');
}

closeDb();
console.log('\nDone. Start the server with:  npm start\n');
