/* Exam runner: one question at a time, countdown, answer auto-save. */
(function () {
  'use strict';

  var form = document.getElementById('examForm');
  if (!form) return;

  var attemptId = form.dataset.attempt;
  var csrfToken = form.querySelector('input[name="_csrf"]').value;
  var saveState = document.getElementById('saveState');
  var answeredCount = document.getElementById('answeredCount');
  var connBanner = document.getElementById('connBanner');
  var submitting = false;

  /* -------------------------------------------------- connection status -- */

  function updateConnBanner() {
    if (connBanner) connBanner.hidden = navigator.onLine !== false;
  }
  window.addEventListener('offline', function () {
    updateConnBanner();
    setSaveState('offline — answers stay on this page and will sync once you reconnect');
  });
  window.addEventListener('online', updateConnBanner);
  updateConnBanner();

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
  /*
   * Built for a slow or patchy connection, where the two things that go
   * wrong are: (1) a lot of small requests queue up behind each other or
   * time out one by one, and (2) a request that does fail gets silently
   * dropped instead of retried, so an answer looks saved in the UI but
   * never reaches the server. Both are addressed here:
   *   - every question changed since the last flush goes out in one POST
   *     (see the matching batch support in routes/student.js), so jumping
   *     through several questions costs one round trip, not several;
   *   - a failed or timed-out send leaves its answers in `pending` instead
   *     of discarding them, and is retried with backoff and again
   *     immediately on the browser's `online` event;
   *   - each send is capped at 8s (AbortController) so a stalled request on
   *     a bad connection fails fast into a retry rather than sitting there
   *     with no feedback.
   */

  var pending = {};
  var saveTimer = null;
  var sending = false;
  var backoffMs = 2000;
  var SAVE_TIMEOUT_MS = 8000;

  function setSaveState(text) {
    if (saveState) saveState.textContent = text;
  }

  function scheduleFlush(delay) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, delay);
  }

  function flushSaves() {
    if (sending) return;
    var ids = Object.keys(pending);
    if (ids.length === 0) return;

    if (navigator.onLine === false) {
      setSaveState('offline — answers stay on this page and will sync once you reconnect');
      scheduleFlush(3000);
      return;
    }

    // Snapshot which array each id currently points at. A change that
    // arrives while this request is in flight replaces pending[id] with a
    // new array (see queueSave), so after the response comes back a plain
    // reference check tells us which ids are still exactly what we sent --
    // those are safe to clear -- versus which were edited again in the
    // meantime and must stay queued for the next flush.
    var snapshot = {};
    ids.forEach(function (id) { snapshot[id] = pending[id]; });

    sending = true;
    setSaveState('saving…');

    var hasAbort = typeof AbortController !== 'undefined';
    var controller = hasAbort ? new AbortController() : null;
    var timeoutId = hasAbort ? setTimeout(function () { controller.abort(); }, SAVE_TIMEOUT_MS) : null;

    fetch('/attempts/' + attemptId + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        answers: ids.map(function (id) { return { questionId: Number(id), selected: snapshot[id] }; }),
      }),
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined,
    }).then(function (response) {
      if (timeoutId) clearTimeout(timeoutId);
      if (!response.ok) throw new Error('http ' + response.status);
      return response.json().catch(function () { return {}; });
    }).then(function (data) {
      if (!data || data.ok === false) throw new Error((data && data.reason) || 'save rejected');

      ids.forEach(function (id) {
        if (pending[id] === snapshot[id]) delete pending[id];
      });
      backoffMs = 2000;
      sending = false;

      if (Object.keys(pending).length > 0) {
        scheduleFlush(200); // more was queued while this request was in flight
      } else {
        setSaveState('up to date');
      }
    }).catch(function () {
      if (timeoutId) clearTimeout(timeoutId);
      sending = false;
      setSaveState('not saved yet — retrying…');
      backoffMs = Math.min(backoffMs * 1.5, 15000);
      scheduleFlush(backoffMs);
    });
  }

  function queueSave(questionId) {
    pending[questionId] = selectionFor(questionId);
    setSaveState('saving…');
    scheduleFlush(400);
  }

  // A request that failed while the tab was in the background, or while
  // offline, shouldn't have to wait out a long backoff once things recover.
  window.addEventListener('online', function () {
    backoffMs = 2000;
    flushSaves();
  });

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

    // A manual submit while offline would otherwise hang as a normal page
    // navigation with no feedback until (if ever) the browser gives up --
    // confusing mid-exam. The auto-submit-at-time-up path below bypasses
    // this event (it calls form.submit() directly), so a real deadline
    // still fires the browser's own retry-on-reconnect navigation behaviour
    // rather than silently doing nothing.
    if (navigator.onLine === false) {
      event.preventDefault();
      alert('You appear to be offline. Your answers are saved on this page -- reconnect and press "Submit and mark" again.');
      return;
    }

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
