/* Exam runner: one question at a time, countdown, answer auto-save. */
(function () {
  'use strict';

  var form = document.getElementById('examForm');
  if (!form) return;

  var attemptId = form.dataset.attempt;
  var csrfToken = form.querySelector('input[name="_csrf"]').value;
  var saveState = document.getElementById('saveState');
  var answeredCount = document.getElementById('answeredCount');
  var submitting = false;

  var questions = Array.prototype.slice.call(document.querySelectorAll('.question'));
  var navLinks = {};
  Array.prototype.forEach.call(document.querySelectorAll('#qnav a'), function (link) {
    navLinks[link.dataset.for] = link;
  });

  /* ---------------------------------------------- one question at a time -- */

  var pager = document.getElementById('pager');
  var prevButton = document.getElementById('prevQuestion');
  var nextButton = document.getElementById('nextQuestion');
  var submitButton = document.getElementById('submitButton');
  var pagerCurrent = document.getElementById('pagerCurrent');
  var unansweredCount = document.getElementById('unansweredCount');
  var current = 0;

  // Everything above renders as one long list without JavaScript. Now that the
  // script is running, take over and show a single question.
  if (pager) pager.hidden = false;

  function show(index, options) {
    var focus = options && options.focus;
    current = Math.max(0, Math.min(questions.length - 1, index));

    questions.forEach(function (section, i) {
      section.hidden = i !== current;
    });

    if (pagerCurrent) pagerCurrent.textContent = String(current + 1);

    // "Submit and mark" replaces "Next" on the last question, and only there.
    var last = current === questions.length - 1;
    if (prevButton) prevButton.disabled = current === 0;
    if (nextButton) nextButton.hidden = last;
    if (submitButton) submitButton.hidden = !last;

    Object.keys(navLinks).forEach(function (id) {
      navLinks[id].classList.remove('is-current');
    });
    var link = navLinks[questions[current].dataset.question];
    if (link) link.classList.add('is-current');

    // Keep the question in view without yanking the page on first paint.
    if (focus !== false) {
      var top = questions[current].getBoundingClientRect().top + window.pageYOffset;
      var header = 90;
      if (window.pageYOffset > top - header || options && options.scroll) {
        window.scrollTo(0, Math.max(0, top - header));
      }
    }
  }

  function step(delta) {
    show(current + delta, { scroll: true });
  }

  /** Runs the submit event, so the unanswered warning still applies. */
  function requestSubmit() {
    if (form.requestSubmit) form.requestSubmit();
    else if (form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))) form.submit();
  }

  if (prevButton) prevButton.addEventListener('click', function () { step(-1); });
  if (nextButton) nextButton.addEventListener('click', function () { step(1); });
  if (submitButton) submitButton.addEventListener('click', requestSubmit);

  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowRight' && current < questions.length - 1) {
      event.preventDefault();
      step(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    }
  });

  /* ------------------------------------------------------------ progress -- */

  function selectionFor(questionId) {
    var inputs = form.querySelectorAll('input[name="q_' + questionId + '"]:checked');
    return Array.prototype.map.call(inputs, function (input) { return Number(input.value); });
  }

  function refreshProgress() {
    var answered = 0;
    questions.forEach(function (section) {
      var id = section.dataset.question;
      var has = selectionFor(id).length > 0;
      if (has) answered++;
      if (navLinks[id]) {
        navLinks[id].classList.toggle('is-answered', has);
        navLinks[id].classList.toggle('is-unanswered', !has);
      }
    });
    if (answeredCount) answeredCount.textContent = String(answered);
    if (unansweredCount) unansweredCount.textContent = String(questions.length - answered);
  }

  /* ----------------------------------------------------------- auto-save -- */

  var pending = {};
  var saveTimer = null;

  function setSaveState(text) {
    if (saveState) saveState.textContent = text;
  }

  function flushSaves() {
    var ids = Object.keys(pending);
    if (ids.length === 0) return;

    var queue = ids.map(function (id) { return { id: id, selected: pending[id] }; });
    pending = {};
    setSaveState('saving…');

    var remaining = queue.length;
    var failed = false;

    queue.forEach(function (item) {
      fetch('/attempts/' + attemptId + '/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ questionId: Number(item.id), selected: item.selected }),
        credentials: 'same-origin',
      }).then(function (response) {
        if (!response.ok) failed = true;
      }).catch(function () {
        failed = true;
      }).finally(function () {
        remaining--;
        if (remaining === 0) {
          setSaveState(failed ? 'not saved — your answers are still in this page' : 'up to date');
        }
      });
    });
  }

  function queueSave(questionId) {
    pending[questionId] = selectionFor(questionId);
    setSaveState('saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, 400);
  }

  form.addEventListener('change', function (event) {
    var input = event.target;
    if (!input.name || input.name.indexOf('q_') !== 0) return;
    queueSave(input.name.slice(2));
    refreshProgress();
  });

  /* ---------------------------------------------------------- navigation -- */

  Array.prototype.forEach.call(document.querySelectorAll('#qnav a'), function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      show(Number(link.dataset.index), { scroll: true });
    });
  });

  /* ---------------------------------------------------------- countdown -- */

  var timerElement = document.getElementById('timer');
  var seconds = form.dataset.seconds === '' ? null : Number(form.dataset.seconds);

  function twoDigits(value) { return value < 10 ? '0' + value : String(value); }

  function renderTimer() {
    if (!timerElement || seconds === null) return;

    if (seconds <= 0) {
      timerElement.textContent = '00:00';
      submitNow(true);
      return;
    }

    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secs = seconds % 60;
    timerElement.textContent = (hours > 0 ? hours + ':' : '') + twoDigits(minutes) + ':' + twoDigits(secs);

    timerElement.classList.toggle('is-warning', seconds <= 300 && seconds > 60);
    timerElement.classList.toggle('is-critical', seconds <= 60);

    seconds--;
  }

  if (seconds !== null && timerElement) {
    renderTimer();
    setInterval(renderTimer, 1000);
  }

  /* ------------------------------------------------------------- submit -- */

  function submitNow(auto) {
    if (submitting) return;
    submitting = true;
    if (auto) {
      window.onbeforeunload = null;
      alert('Time is up. Your paper is being submitted.');
    }
    form.submit();
  }

  form.addEventListener('submit', function (event) {
    if (submitting) return;

    var total = questions.length;
    var answered = Number(answeredCount ? answeredCount.textContent : total);

    if (answered < total) {
      var unanswered = total - answered;
      var message = 'You have not answered ' + unanswered + ' question' +
        (unanswered === 1 ? '' : 's') + '. Submit anyway?';
      if (!window.confirm(message)) {
        event.preventDefault();
        // Take them to the first question they have not answered.
        for (var i = 0; i < questions.length; i++) {
          if (selectionFor(questions[i].dataset.question).length === 0) {
            show(i, { scroll: true });
            break;
          }
        }
        return;
      }
    }

    submitting = true;
    window.onbeforeunload = null;
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Marking…'; }
  });

  window.onbeforeunload = function () {
    if (submitting) return undefined;
    return 'Your exam is still in progress. Leave this page?';
  };

  /* ---------------------------------------------------------------- go -- */

  refreshProgress();

  // Resume on the first unanswered question, so coming back mid-paper lands
  // where the student left off rather than at question one.
  var resumeAt = 0;
  for (var i = 0; i < questions.length; i++) {
    if (selectionFor(questions[i].dataset.question).length === 0) { resumeAt = i; break; }
  }
  show(resumeAt, { focus: false });
})();
