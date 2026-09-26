'use strict';

const crypto = require('node:crypto');
const exams = require('../models/exams');
const attempts = require('../models/attempts');
const users = require('../models/users');
const inbox = require('../models/inbox');
const { parseQuestions, FORMAT_LABELS } = require('../lib/parsers');
const { requireAdmin, setFlash } = require('../middleware/auth');
const { checkPasswordStrength } = require('../lib/password');
const { sendWelcomeMessage } = require('./auth');

const LABELS = exams.LABELS;

function notFound(message = 'Not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

async function getExamOr404(id) {
  const exam = await exams.findExam(id);
  if (!exam) throw notFound('That exam no longer exists.');
  return exam;
}

/** A query-string id filter: a positive integer, or null (no filter/junk input). */
function parseId(raw) {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Read the repeating option fields from the question editor form. */
function readOptionsFromForm(body) {
  const texts = [].concat(body.optionText || []);
  const correctRaw = [].concat(body.correct || []);
  const correct = new Set(correctRaw.map(String));

  const options = [];
  texts.forEach((text, index) => {
    const value = String(text || '').trim();
    if (!value) return;
    options.push({
      label: LABELS[options.length],
      text: value,
      isCorrect: correct.has(String(index)),
    });
  });
  return options;
}

function examFormValues(body) {
  return {
    title: body.title,
    examCode: body.examCode,
    subject: body.subject,
    category: body.category,
    year: body.year,
    description: body.description,
    durationMinutes: body.durationMinutes,
    passMark: body.passMark,
    questionsPerAttempt: body.questionsPerAttempt,
    shuffleQuestions: body.shuffleQuestions,
    shuffleOptions: body.shuffleOptions,
    showAnswers: body.showAnswers,
    isPublished: body.isPublished,
  };
}

function register(app) {
  /* --------------------------------------------------------- dashboard -- */

  app.get('/admin', requireAdmin, async (req, res) => {
    const [attemptStats, userCounts, recentAttempts, examList] = await Promise.all([
      attempts.statistics(),
      users.countAll(),
      attempts.listAllAttempts({ limit: 10 }),
      exams.listExams(),
    ]);
    return res.render('admin/dashboard', {
      title: 'Administration',
      stats: { ...attemptStats, ...userCounts },
      recentAttempts,
      exams: examList.slice(0, 8),
      autoRefreshSeconds: 30,
    });
  });

  /* ------------------------------------------------------------- exams -- */

  app.get('/admin/exams', requireAdmin, async (req, res) => {
    let all = await exams.listExams({ search: req.query.q || '' });
    const wanted = req.query.subject ? exams.subjectKey(req.query.subject) : null;
    if (wanted) all = all.filter((exam) => exams.subjectKey(exam.subject) === wanted);
    const selectedCategory = users.cleanCategory(req.query.category) || '';
    if (selectedCategory) all = all.filter((exam) => exam.category === selectedCategory);

    return res.render('admin/exams', {
      title: 'Exams',
      exams: all,
      subjects: await exams.subjectsInUse(),
      selectedSubject: req.query.subject || '',
      categories: exams.CATEGORIES,
      selectedCategory,
      search: req.query.q || '',
    });
  });

  app.get('/admin/exams/new', requireAdmin, async (req, res) => {
    return res.render('admin/exam-form', {
      subjects: await exams.subjectsInUse(),
      categories: exams.CATEGORIES,
      title: 'New exam',
      exam: {
        title: '', exam_code: '', subject: '', category: '', year: '', description: '',
        duration_minutes: 60, pass_mark: 50, questions_per_attempt: 0,
        shuffle_questions: 1, shuffle_options: 1, show_answers: 1, is_published: 0,
      },
      isNew: true,
      errors: [],
    });
  });

  app.post('/admin/exams/new', requireAdmin, async (req, res) => {
    const values = examFormValues(req.body);
    const errors = [];
    if (!String(values.title || '').trim()) errors.push('The exam needs a title.');
    if (!users.cleanCategory(values.category)) errors.push('Choose which exam level this paper is for (PSLE, JC or BGCSE).');

    if (errors.length > 0) {
      return res.status(400).render('admin/exam-form', {
        subjects: await exams.subjectsInUse(),
        categories: exams.CATEGORIES,
        title: 'New exam',
        exam: {
          title: values.title, exam_code: values.examCode, subject: values.subject,
          category: values.category, year: values.year, description: values.description,
          duration_minutes: values.durationMinutes, pass_mark: values.passMark,
          questions_per_attempt: values.questionsPerAttempt,
          shuffle_questions: values.shuffleQuestions ? 1 : 0,
          shuffle_options: values.shuffleOptions ? 1 : 0,
          show_answers: values.showAnswers ? 1 : 0,
          is_published: values.isPublished ? 1 : 0,
        },
        isNew: true,
        errors,
      });
    }

    const exam = await exams.createExam(values, req.user.id);
    setFlash(req, 'success', 'Exam created. Now add some questions.');
    return res.redirect(`/admin/exams/${exam.id}`);
  });

  app.get('/admin/exams/:id', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    const [questions, performance, attemptRows, resultCount] = await Promise.all([
      exams.listQuestions(exam.id),
      attempts.questionPerformance(exam.id),
      attempts.listAllAttempts({ examId: exam.id, limit: 1 }),
      attempts.countForExam(exam.id),
    ]);
    return res.render('admin/exam-detail', {
      title: exam.title,
      exam,
      questions,
      performance,
      attemptCount: attemptRows.length,
      resultCount,
    });
  });

  app.get('/admin/exams/:id/edit', requireAdmin, async (req, res) => {
    return res.render('admin/exam-form', {
      subjects: await exams.subjectsInUse(),
      categories: exams.CATEGORIES,
      title: 'Edit exam',
      exam: await getExamOr404(req.params.id),
      isNew: false,
      errors: [],
    });
  });

  app.post('/admin/exams/:id/edit', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    const values = examFormValues(req.body);
    const errors = [];
    if (!String(values.title || '').trim()) errors.push('The exam needs a title.');
    if (!users.cleanCategory(values.category)) errors.push('Choose which exam level this paper is for (PSLE, JC or BGCSE).');
    if (errors.length > 0) {
      return res.status(400).render('admin/exam-form', {
        subjects: await exams.subjectsInUse(),
        categories: exams.CATEGORIES,
        title: 'Edit exam',
        exam: { ...exam, ...values, exam_code: values.examCode, is_published: exam.is_published },
        isNew: false,
        errors,
      });
    }
    await exams.updateExam(exam.id, values);
    setFlash(req, 'success', 'Exam settings saved.');
    return res.redirect(`/admin/exams/${exam.id}`);
  });

  app.post('/admin/exams/:id/publish', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    const publish = String(req.body.publish) === '1';

    if (publish && (await exams.countQuestions(exam.id)) === 0) {
      setFlash(req, 'error', 'Add at least one question before publishing this exam.');
      return res.redirect(`/admin/exams/${exam.id}`);
    }

    const wasPublished = Boolean(exam.is_published);
    await exams.setPublished(exam.id, publish);

    // Announce it in every matching-category student's inbox -- only the
    // moment it actually becomes visible to them (not on every toggle, and
    // not while it's still a draft nobody but the admin can see).
    if (publish && !wasPublished && exam.category) {
      try {
        const recipients = await users.listStudentsByCategory(exam.category);
        if (recipients.length) {
          await inbox.sendToMany(recipients.map((r) => r.id), {
            kind: 'exam',
            title: `New exam available: ${exam.title}`,
            body: `A new ${exam.category} exam, "${exam.title}", has just been published. `
              + `Head to your dashboard to give it a go.`,
            examId: exam.id,
          });
        }
      } catch (err) {
        console.error('[admin] failed to send exam-published inbox messages:', err);
      }
    }

    setFlash(req, 'success', publish
      ? 'The exam is now live for students.'
      : 'The exam has been hidden from students.');
    return res.redirect(req.body.back === 'list' ? '/admin/exams' : `/admin/exams/${exam.id}`);
  });

  app.post('/admin/exams/:id/delete', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    const resultCount = await attempts.countForExam(exam.id);
    await exams.deleteExam(exam.id);
    setFlash(req, 'success', resultCount > 0
      ? `"${exam.title}", its questions, and ${resultCount} student attempt${resultCount === 1 ? '' : 's'}/result${resultCount === 1 ? '' : 's'} for it were deleted.`
      : `"${exam.title}" and all of its questions were deleted.`);
    return res.redirect('/admin/exams');
  });

  /* --------------------------------------------------------- questions -- */

  app.get('/admin/exams/:id/questions/new', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    return res.render('admin/question-form', {
      title: 'Add question',
      exam,
      question: {
        id: null, question_text: '', question_type: 'single', explanation: '', marks: 1,
        options: [
          { option_text: '', is_correct: 0 },
          { option_text: '', is_correct: 0 },
          { option_text: '', is_correct: 0 },
          { option_text: '', is_correct: 0 },
        ],
      },
      errors: [],
    });
  });

  app.post('/admin/exams/:id/questions/new', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    const options = readOptionsFromForm(req.body);
    const text = String(req.body.questionText || '').trim();

    const errors = [];
    if (!text) errors.push('The question needs some text.');
    if (options.length < 2) errors.push('Please provide at least two options.');
    if (!options.some((o) => o.isCorrect)) errors.push('Please tick the correct answer.');

    if (errors.length > 0) {
      return res.status(400).render('admin/question-form', {
        title: 'Add question',
        exam,
        question: {
          id: null,
          question_text: text,
          question_type: req.body.questionType === 'multiple' ? 'multiple' : 'single',
          explanation: req.body.explanation || '',
          marks: req.body.marks || 1,
          options: [].concat(req.body.optionText || []).map((optionText, index) => ({
            option_text: optionText,
            is_correct: [].concat(req.body.correct || []).map(String).includes(String(index)) ? 1 : 0,
          })),
        },
        errors,
      });
    }

    const correctCount = options.filter((o) => o.isCorrect).length;
    await exams.addQuestion(exam.id, {
      text,
      type: correctCount > 1 ? 'multiple' : (req.body.questionType === 'multiple' ? 'multiple' : 'single'),
      image: req.body.image,
      explanation: req.body.explanation,
      marks: req.body.marks,
      options,
    });

    setFlash(req, 'success', 'Question added.');
    return res.redirect(req.body.addAnother
      ? `/admin/exams/${exam.id}/questions/new`
      : `/admin/exams/${exam.id}`);
  });

  app.get('/admin/questions/:qid/edit', requireAdmin, async (req, res) => {
    const question = await exams.findQuestion(req.params.qid);
    if (!question) throw notFound('Question not found.');
    return res.render('admin/question-form', {
      title: 'Edit question',
      exam: await getExamOr404(question.exam_id),
      question,
      errors: [],
    });
  });

  app.post('/admin/questions/:qid/edit', requireAdmin, async (req, res) => {
    const existing = await exams.findQuestion(req.params.qid);
    if (!existing) throw notFound('Question not found.');

    const options = readOptionsFromForm(req.body);
    const text = String(req.body.questionText || '').trim();

    const errors = [];
    if (!text) errors.push('The question needs some text.');
    if (options.length < 2) errors.push('Please provide at least two options.');
    if (!options.some((o) => o.isCorrect)) errors.push('Please tick the correct answer.');

    if (errors.length > 0) {
      return res.status(400).render('admin/question-form', {
        title: 'Edit question',
        exam: await getExamOr404(existing.exam_id),
        question: { ...existing, question_text: text },
        errors,
      });
    }

    const correctCount = options.filter((o) => o.isCorrect).length;
    await exams.updateQuestion(existing.id, {
      text,
      type: correctCount > 1 ? 'multiple' : (req.body.questionType === 'multiple' ? 'multiple' : 'single'),
      image: req.body.image,
      explanation: req.body.explanation,
      marks: req.body.marks,
      options,
    });

    setFlash(req, 'success', 'Question updated.');
    return res.redirect(`/admin/exams/${existing.exam_id}`);
  });

  app.post('/admin/questions/:qid/delete', requireAdmin, async (req, res) => {
    const question = await exams.findQuestion(req.params.qid);
    if (!question) throw notFound('Question not found.');
    await exams.deleteQuestion(question.id);
    setFlash(req, 'success', 'Question deleted.');
    return res.redirect(`/admin/exams/${question.exam_id}`);
  });

  app.post('/admin/questions/:qid/move', requireAdmin, async (req, res) => {
    const question = await exams.findQuestion(req.params.qid);
    if (!question) throw notFound('Question not found.');
    await exams.moveQuestion(question.id, req.body.direction === 'up' ? 'up' : 'down');
    return res.redirect(`/admin/exams/${question.exam_id}#q${question.id}`);
  });

  /* ------------------------------------ import a whole exam from a file -- */

  /** Read the uploaded file or the pasted text, whichever was supplied. */
  function readSubmission(req) {
    const pastedText = String(req.body.pastedText || '');
    const upload = req.files.file;
    const hasUpload = upload && upload.size > 0;
    return {
      source: hasUpload ? upload.buffer : pastedText,
      filename: hasUpload ? upload.filename : '',
      pastedText,
      format: String(req.body.format || 'auto'),
      empty: !hasUpload && !pastedText.trim(),
    };
  }

  app.get('/admin/import', requireAdmin, async (req, res) => {
    return res.render('admin/import', {
      title: 'Import an exam file',
      exam: null,
      errors: [],
      pastedText: '',
    });
  });

  app.post('/admin/import', requireAdmin, async (req, res) => {
    const submission = readSubmission(req);

    const fail = (errors, text) => res.status(400).render('admin/import', {
      title: 'Import an exam file',
      exam: null,
      errors,
      pastedText: text !== undefined ? text : submission.pastedText,
    });

    if (submission.empty) {
      return fail(['Choose a file to upload, or paste the questions below.']);
    }

    let parsed;
    try {
      parsed = parseQuestions(submission.source, {
        filename: submission.filename,
        format: submission.format,
      });
    } catch (err) {
      return fail([err.message]);
    }

    if (parsed.questions.length === 0) {
      return fail([
        'No usable questions were found in that file.',
        ...parsed.issues.slice(0, 10).map((issue) => `${issue.reference}: ${issue.problem}`),
      ], parsed.extractedText || submission.pastedText);
    }

    const token = crypto.randomBytes(12).toString('hex');
    req.session.pendingImport = {
      token,
      examId: null,
      settings: parsed.exam || null,
      questions: parsed.questions,
      issues: parsed.issues,
      format: parsed.format,
      formatLabel: parsed.formatLabel,
      sourceName: submission.filename || 'pasted text',
      createdAt: Date.now(),
    };
    req.session.save();

    return res.redirect(`/admin/import/preview?t=${token}`);
  });

  app.get('/admin/import/preview', requireAdmin, async (req, res) => {
    const pending = req.session.pendingImport;
    if (!pending || pending.token !== req.query.t || pending.examId !== null) {
      setFlash(req, 'error', 'That import has expired. Please upload the file again.');
      return res.redirect('/admin/import');
    }

    const suggested = pending.settings || {};

    // Options worded "Shown at A" point at letters printed inside a picture,
    // so shuffling them would break the question. Warn about it up front.
    const hasPictureOptions = pending.questions.some((question) =>
      question.options.some((option) => /^shown at [a-j]$/i.test(String(option.text).trim())));

    return res.render('admin/import-preview', {
      subjects: await exams.subjectsInUse(),
      categories: exams.CATEGORIES,
      title: 'Review the exam',
      exam: null,
      pending,
      questions: pending.questions,
      issues: pending.issues,
      hasPictureOptions,
      settings: {
        title: suggested.title || '',
        exam_code: suggested.examCode || '',
        subject: suggested.subject || '',
        category: users.cleanCategory(suggested.category) || '',
        year: suggested.year || '',
        description: suggested.description || '',
        duration_minutes: suggested.durationMinutes !== undefined ? suggested.durationMinutes : 60,
        pass_mark: suggested.passMark !== undefined ? suggested.passMark : 50,
        questions_per_attempt: suggested.questionsPerAttempt !== undefined ? suggested.questionsPerAttempt : 0,
        shuffle_questions: suggested.shuffleQuestions === undefined ? 1 : (suggested.shuffleQuestions ? 1 : 0),
        shuffle_options: suggested.shuffleOptions === undefined ? 1 : (suggested.shuffleOptions ? 1 : 0),
        show_answers: suggested.showAnswers === undefined ? 1 : (suggested.showAnswers ? 1 : 0),
      },
      fromFile: Boolean(pending.settings),
    });
  });

  app.post('/admin/import/confirm', requireAdmin, async (req, res) => {
    const pending = req.session.pendingImport;
    if (!pending || pending.token !== req.body.token || pending.examId !== null) {
      setFlash(req, 'error', 'That import has expired. Please upload the file again.');
      return res.redirect('/admin/import');
    }

    const keep = new Set([].concat(req.body.keep || []).map(String));
    const selected = pending.questions.filter((_, index) => keep.has(String(index)));

    if (selected.length === 0) {
      setFlash(req, 'error', 'No questions were selected, so nothing was imported.');
      return res.redirect('/admin/import');
    }
    if (!String(req.body.title || '').trim()) {
      setFlash(req, 'error', 'The exam needs a title.');
      return res.redirect(`/admin/import/preview?t=${pending.token}`);
    }
    if (!users.cleanCategory(req.body.category)) {
      setFlash(req, 'error', 'Choose which exam level this paper is for (PSLE, JC or BGCSE).');
      return res.redirect(`/admin/import/preview?t=${pending.token}`);
    }

    const exam = await exams.createExam(examFormValues(req.body), req.user.id);
    const saved = await exams.addQuestionsBulk(exam.id, selected);

    delete req.session.pendingImport;
    req.session.save();

    setFlash(req, 'success',
      `"${exam.title}" created with ${saved} question${saved === 1 ? '' : 's'}.` +
      (exam.is_published ? '' : ' Publish it when you are ready for students to see it.'));
    return res.redirect(`/admin/exams/${exam.id}`);
  });

  /* ------------------------------ import into an exam that already exists -- */

  app.get('/admin/exams/:id/import', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    return res.render('admin/import', {
      title: `Import questions - ${exam.title}`,
      exam,
      errors: [],
      pastedText: '',
    });
  });

  app.post('/admin/exams/:id/import', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    const submission = readSubmission(req);
    const { pastedText, filename } = submission;

    const fail = (errors, text) => res.status(400).render('admin/import', {
      title: `Import questions - ${exam.title}`,
      exam,
      errors,
      pastedText: text !== undefined ? text : pastedText,
    });

    if (submission.empty) {
      return fail(['Choose a file to upload, or paste the questions below.']);
    }

    let parsed;
    try {
      parsed = parseQuestions(submission.source, { filename, format: submission.format });
    } catch (err) {
      return fail([err.message]);
    }

    if (parsed.questions.length === 0) {
      return fail([
        'No usable questions were found.',
        ...parsed.issues.slice(0, 10).map((issue) => `${issue.reference}: ${issue.problem}`),
      ], parsed.extractedText || pastedText);
    }

    // Park the parsed questions in the session until the admin confirms.
    const token = crypto.randomBytes(12).toString('hex');
    req.session.pendingImport = {
      token,
      examId: exam.id,
      questions: parsed.questions,
      issues: parsed.issues,
      format: parsed.format,
      formatLabel: parsed.formatLabel,
      sourceName: filename || 'pasted text',
      createdAt: Date.now(),
    };
    req.session.save();

    return res.redirect(`/admin/exams/${exam.id}/import/preview?t=${token}`);
  });

  app.get('/admin/exams/:id/import/preview', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    const pending = req.session.pendingImport;

    if (!pending || pending.token !== req.query.t || pending.examId !== exam.id) {
      setFlash(req, 'error', 'That import has expired. Please upload the questions again.');
      return res.redirect(`/admin/exams/${exam.id}/import`);
    }

    return res.render('admin/import-preview', {
      subjects: await exams.subjectsInUse(),
      title: `Review import - ${exam.title}`,
      exam,
      pending,
      questions: pending.questions,
      issues: pending.issues,
      settings: null,
      fromFile: false,
      hasPictureOptions: false,
    });
  });

  app.post('/admin/exams/:id/import/confirm', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    const pending = req.session.pendingImport;

    if (!pending || pending.token !== req.body.token || pending.examId !== exam.id) {
      setFlash(req, 'error', 'That import has expired. Please upload the questions again.');
      return res.redirect(`/admin/exams/${exam.id}/import`);
    }

    // The admin may have unticked some questions on the review screen.
    const keep = new Set([].concat(req.body.keep || []).map(String));
    const selected = pending.questions.filter((_, index) => keep.has(String(index)));

    if (selected.length === 0) {
      setFlash(req, 'error', 'No questions were selected, so nothing was imported.');
      return res.redirect(`/admin/exams/${exam.id}/import`);
    }

    if (String(req.body.replaceExisting) === '1') {
      await exams.deleteAllQuestions(exam.id);
    }

    const saved = await exams.addQuestionsBulk(exam.id, selected);

    delete req.session.pendingImport;
    req.session.save();

    setFlash(req, 'success', `${saved} question${saved === 1 ? '' : 's'} imported into "${exam.title}".`);
    return res.redirect(`/admin/exams/${exam.id}`);
  });

  /* ---------------------------------------------------------- students -- */

  app.get('/admin/students', requireAdmin, async (req, res) => {
    const [students, admins] = await Promise.all([
      users.listStudents({ search: req.query.q || '' }),
      users.listAdmins(),
    ]);
    return res.render('admin/students', {
      title: 'Students',
      students,
      admins,
      search: req.query.q || '',
      errors: [],
    });
  });

  app.post('/admin/students/new', requireAdmin, async (req, res) => {
    const fullName = String(req.body.fullName || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const role = req.body.role === 'admin' ? 'admin' : 'student';

    const errors = [];
    if (fullName.length < 2) errors.push('Please enter a full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push('Please enter a valid email address.');
    const strength = checkPasswordStrength(password);
    if (strength) errors.push(strength);
    if (errors.length === 0 && (await users.findByEmail(email))) errors.push('That email address is already in use.');

    if (errors.length > 0) {
      setFlash(req, 'error', errors.join(' '));
      return res.redirect('/admin/students');
    }

    const created = await users.create({
      fullName, email, password, role,
      studentNumber: String(req.body.studentNumber || '').trim() || null,
    });
    await sendWelcomeMessage(created);
    setFlash(req, 'success', `Account created for ${fullName}.`);
    return res.redirect('/admin/students');
  });

  app.post('/admin/students/:uid/reset-password', requireAdmin, async (req, res) => {
    const user = await users.findById(req.params.uid);
    if (!user) throw notFound('User not found.');

    const password = String(req.body.password || '');
    const strength = checkPasswordStrength(password);
    if (strength) {
      setFlash(req, 'error', strength);
    } else {
      await users.updatePassword(user.id, password);
      setFlash(req, 'success', `Password reset for ${user.full_name}.`);
    }
    return res.redirect('/admin/students');
  });

  app.post('/admin/students/:uid/toggle', requireAdmin, async (req, res) => {
    const user = await users.findById(req.params.uid);
    if (!user) throw notFound('User not found.');
    if (user.id === req.user.id) {
      setFlash(req, 'error', 'You cannot deactivate your own account.');
      return res.redirect('/admin/students');
    }
    await users.setActive(user.id, !user.is_active);
    setFlash(req, 'success', `${user.full_name} was ${user.is_active ? 'deactivated' : 'reactivated'}.`);
    return res.redirect('/admin/students');
  });

  app.post('/admin/students/:uid/delete', requireAdmin, async (req, res) => {
    const user = await users.findById(req.params.uid);
    if (!user) throw notFound('User not found.');
    if (user.id === req.user.id) {
      setFlash(req, 'error', 'You cannot delete your own account.');
      return res.redirect('/admin/students');
    }
    await users.remove(user.id);
    setFlash(req, 'success', `${user.full_name} and their results were removed.`);
    return res.redirect('/admin/students');
  });

  /* ----------------------------------------------------------- results -- */

  app.get('/admin/results', requireAdmin, async (req, res) => {
    const examId = parseId(req.query.exam);
    const userId = parseId(req.query.student);
    const [rows, examList, student] = await Promise.all([
      attempts.listAllAttempts({ examId, userId, limit: 500 }),
      exams.listExams(),
      userId ? users.findById(userId) : null,
    ]);

    const query = new URLSearchParams();
    if (examId) query.set('exam', String(examId));
    if (userId) query.set('student', String(userId));

    return res.render('admin/results', {
      title: 'Results',
      attempts: rows,
      exams: examList,
      selectedExam: examId,
      student,
      csvUrl: `/admin/results.csv${query.size ? `?${query}` : ''}`,
      autoRefreshSeconds: 30,
    });
  });

  app.get('/admin/results.csv', requireAdmin, async (req, res) => {
    const examId = parseId(req.query.exam);
    const userId = parseId(req.query.student);
    const rows = await attempts.listAllAttempts({ examId, userId, limit: 10000 });

    const escape = (value) => {
      let text = value === null || value === undefined ? '' : String(value);
      // Excel/Sheets/LibreOffice treat a cell starting with =, +, -, @, tab
      // or CR as a formula. Student-controlled fields end up in this export
      // (full_name, student_number are free text at registration), so a
      // leading formula character is neutralized with a leading apostrophe
      // -- the standard CSV-injection mitigation -- before the normal
      // comma/quote/newline quoting below.
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [
      ['Student', 'Email', 'Student number', 'Exam', 'Exam code', 'Score', 'Total', 'Percentage', 'Result', 'Submitted'].join(','),
      ...rows.map((row) => [
        row.full_name, row.email, row.student_number, row.exam_title, row.exam_code,
        row.score, row.total_marks, row.percentage, row.passed ? 'Pass' : 'Fail', row.submitted_at,
      ].map(escape).join(',')),
    ];

    res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
    return res.send(lines.join('\n'), 'text/csv; charset=utf-8');
  });

  /* -------------------------------------------------------- export json -- */

  app.get('/admin/exams/:id/export.json', requireAdmin, async (req, res) => {
    const exam = await getExamOr404(req.params.id);
    const rawQuestions = await exams.listQuestions(exam.id);
    const questions = rawQuestions.map((question) => ({
      question: question.question_text,
      type: question.question_type,
      marks: question.marks,
      image: question.image || undefined,
      explanation: question.explanation || undefined,
      options: question.options.map((option) => ({
        label: option.label,
        text: option.option_text,
        correct: Boolean(option.is_correct),
      })),
    }));

    res.setHeader('Content-Disposition',
      `attachment; filename="${exam.title.replace(/[^\w\-]+/g, '_')}.json"`);
    return res.send(JSON.stringify({ exam: exam.title, questions }, null, 2),
      'application/json; charset=utf-8');
  });
}

module.exports = { register, FORMAT_LABELS };
