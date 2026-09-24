'use strict';

const exams = require('../models/exams');
const attempts = require('../models/attempts');
const { requireStudent, setFlash } = require('../middleware/auth');

function notFound(message = 'Not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

/** Collect "answers for question N" out of a submitted form. */
function collectResponses(body) {
  const responses = new Map();
  for (const [key, value] of Object.entries(body)) {
    const match = key.match(/^q_(\d+)$/);
    if (!match) continue;
    const questionId = Number(match[1]);
    const values = Array.isArray(value) ? value : [value];
    responses.set(
      questionId,
      values.map(Number).filter(Number.isFinite)
    );
  }
  return responses;
}

function register(app) {
  /* --------------------------------------------------------- dashboard -- */

  app.get('/dashboard', requireStudent, async (req, res) => {
    if (req.user.role === 'admin') return res.redirect('/admin');

    const rawAvailable = await exams.listExamsForStudent(req.user.id, req.user.category);
    const available = rawAvailable.map((exam) => ({
      ...exam,
      blurb: exams.describe(exam, exam.question_count),
    }));
    const recent = await attempts.listAttemptsForUser(req.user.id, 5);
    const submitted = await attempts.listAttemptsForUser(req.user.id, 1000);

    const averageScore = submitted.length
      ? Math.round((submitted.reduce((sum, a) => sum + (a.percentage || 0), 0) / submitted.length) * 10) / 10
      : null;

    const subjects = exams.groupBySubject(available);

    // A subject was asked for, or there is only one, in which case sending the
    // student through a list of one would be a pointless extra click.
    const wanted = req.query.subject ? exams.subjectKey(req.query.subject) : null;
    const chosen = wanted
      ? subjects.find((group) => group.key === wanted)
      : (subjects.length === 1 ? subjects[0] : null);

    if (wanted && !chosen) {
      setFlash(req, 'error', 'There are no papers in that subject yet.');
      return res.redirect('/dashboard');
    }

    return res.render('student/dashboard', {
      title: chosen ? chosen.name : 'My revision dashboard',
      subjects,
      chosen,
      // Only show the "all subjects" way back when there is somewhere to go.
      showBackToSubjects: Boolean(chosen) && subjects.length > 1,
      recent,
      stats: {
        available: available.length,
        subjects: subjects.length,
        completed: submitted.length,
        averageScore,
        passed: submitted.filter((a) => a.passed).length,
      },
    });
  });

  /* ------------------------------------------------------- exam intro -- */

  app.get('/exams/:id', requireStudent, async (req, res) => {
    const exam = await exams.findExam(req.params.id);
    if (!exam || !exam.is_published || exam.category !== req.user.category) {
      throw notFound('That exam is not available.');
    }

    const questionCount = await exams.countQuestions(exam.id);
    const open = await attempts.findOpenAttempt(req.user.id, exam.id);
    const historyAll = await attempts.listAttemptsForUser(req.user.id, 1000);
    const history = historyAll.filter((a) => a.exam_id === exam.id);

    return res.render('student/exam-intro', {
      title: exam.title,
      exam,
      blurb: exams.describe(exam, questionCount),
      questionCount,
      servedCount: exam.questions_per_attempt > 0
        ? Math.min(exam.questions_per_attempt, questionCount)
        : questionCount,
      openAttempt: open,
      history,
    });
  });

  /* ------------------------------------------------------ start / take -- */

  app.post('/exams/:id/start', requireStudent, async (req, res) => {
    const exam = await exams.findExam(req.params.id);
    if (!exam || !exam.is_published || exam.category !== req.user.category) {
      throw notFound('That exam is not available.');
    }

    const existing = await attempts.findOpenAttempt(req.user.id, exam.id);
    if (existing) return res.redirect(`/attempts/${existing.id}`);

    if ((await exams.countQuestions(exam.id)) === 0) {
      setFlash(req, 'error', 'That exam does not have any questions yet.');
      return res.redirect('/dashboard');
    }

    const attempt = await attempts.startAttempt(req.user.id, exam);
    return res.redirect(`/attempts/${attempt.id}`);
  });

  app.get('/attempts/:id', requireStudent, async (req, res) => {
    const attempt = await attempts.findAttempt(req.params.id);
    if (!attempt || attempt.user_id !== req.user.id) throw notFound('Attempt not found.');
    if (attempt.status === 'submitted') return res.redirect(`/results/${attempt.id}`);

    const exam = await exams.findExam(attempt.exam_id);
    const questions = await attempts.getAttemptQuestions(attempt);
    const saved = await attempts.getSavedAnswers(attempt.id);

    // Time is up: mark whatever has been saved so far.
    if (attempt.expires_at && Date.now() > attempt.expires_at) {
      const responses = new Map();
      for (const [questionId, selection] of saved.entries()) responses.set(questionId, selection);
      await attempts.submitAttempt(attempt, responses);
      setFlash(req, 'error', 'Your time ran out, so the paper was submitted automatically.');
      return res.redirect(`/results/${attempt.id}`);
    }

    return res.render('student/attempt', {
      title: `${exam.title} - in progress`,
      layoutVariant: 'exam',
      exam,
      attempt,
      questions: questions.map((question, index) => ({
        ...question,
        number: index + 1,
        savedSelection: saved.get(question.id) || [],
      })),
      secondsRemaining: attempt.expires_at
        ? Math.max(0, Math.round((attempt.expires_at - Date.now()) / 1000))
        : null,
    });
  });

  /** Background save of a single answer (called by the browser as you click). */
  app.post('/attempts/:id/answer', requireStudent, async (req, res) => {
    const attempt = await attempts.findAttempt(req.params.id);
    if (!attempt || attempt.user_id !== req.user.id) return res.json({ ok: false }, 404);
    if (attempt.status !== 'in_progress') return res.json({ ok: false, reason: 'submitted' }, 409);

    const questionId = Number(req.body.questionId);
    if (!attempt.questionIds.includes(questionId)) return res.json({ ok: false }, 400);

    const selected = Array.isArray(req.body.selected) ? req.body.selected : [];
    await attempts.saveAnswer(attempt.id, questionId, selected);
    return res.json({ ok: true });
  });

  app.post('/attempts/:id/submit', requireStudent, async (req, res) => {
    const attempt = await attempts.findAttempt(req.params.id);
    if (!attempt || attempt.user_id !== req.user.id) throw notFound('Attempt not found.');
    if (attempt.status === 'submitted') return res.redirect(`/results/${attempt.id}`);

    // Start from what was saved in the background, then overlay the posted form.
    const responses = new Map(await attempts.getSavedAnswers(attempt.id));
    for (const [questionId, selection] of collectResponses(req.body).entries()) {
      responses.set(questionId, selection);
    }

    await attempts.submitAttempt(attempt, responses);
    return res.redirect(`/results/${attempt.id}`);
  });

  app.post('/attempts/:id/abandon', requireStudent, async (req, res) => {
    const attempt = await attempts.findAttempt(req.params.id);
    if (attempt && attempt.user_id === req.user.id && attempt.status === 'in_progress') {
      await attempts.abandonAttempt(attempt.id);
      setFlash(req, 'success', 'That attempt was discarded.');
    }
    return res.redirect('/dashboard');
  });

  /* ---------------------------------------------------------- results -- */

  app.get('/results/:id', requireStudent, async (req, res) => {
    const result = await attempts.getAttemptResult(req.params.id);
    if (!result) throw notFound('Result not found.');

    const isOwner = result.attempt.user_id === req.user.id;
    if (!isOwner && req.user.role !== 'admin') throw notFound('Result not found.');
    if (result.attempt.status !== 'submitted') return res.redirect(`/attempts/${result.attempt.id}`);

    return res.render('student/result', {
      title: `Result - ${result.exam.title}`,
      ...result,
      showAnswers: Boolean(result.exam.show_answers) || req.user.role === 'admin',
      viewingAsAdmin: !isOwner,
    });
  });

  app.get('/history', requireStudent, async (req, res) => {
    return res.render('student/history', {
      title: 'My results',
      attempts: await attempts.listAttemptsForUser(req.user.id, 500),
    });
  });
}

module.exports = { register };
