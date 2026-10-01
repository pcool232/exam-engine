'use strict';
/**
 * Landing page (views/landing.html) — the three small live bits:
 *   1. the hero exam card's countdown timer,
 *   2. the "try a question" demo (instant marking, no server round trip),
 *   3. the "simulate losing signal" toggle for the offline section.
 * Plain DOM, no dependencies. Everything degrades to the static markup if
 * this script fails to load (e.g. on a very poor connection).
 */
(function () {
  /* 1. Countdown ------------------------------------------------------- */
  var timer = document.querySelector('[data-timer]');
  if (timer) {
    var total = 45 * 60;
    var secs = total - 1;
    setInterval(function () {
      if (document.hidden) return;
      secs = secs > 0 ? secs - 1 : total;
      var mm = String(Math.floor(secs / 60)).padStart(2, '0');
      var ss = String(secs % 60).padStart(2, '0');
      timer.textContent = mm + ':' + ss;
    }, 1000);
  }

  /* 2. Sample question --------------------------------------------------- */
  var quiz = document.querySelector('[data-quiz]');
  if (quiz) {
    var answer = quiz.getAttribute('data-answer');
    var buttons = Array.prototype.slice.call(quiz.querySelectorAll('[data-key]'));
    var right = document.querySelector('[data-verdict="right"]');
    var wrong = document.querySelector('[data-verdict="wrong"]');
    var reset = document.querySelector('[data-reset]');

    var setState = function (picked) {
      buttons.forEach(function (btn) {
        var key = btn.getAttribute('data-key');
        var mark = btn.querySelector('.qmark');
        btn.classList.remove('is-right', 'is-wrong');
        btn.setAttribute('aria-pressed', String(picked === key));
        mark.textContent = '';
        if (!picked) return;
        if (key === answer) { btn.classList.add('is-right'); mark.textContent = '✓'; }
        else if (key === picked) { btn.classList.add('is-wrong'); mark.textContent = '✕'; }
      });
      right.hidden = picked !== answer;
      wrong.hidden = !picked || picked === answer;
      reset.hidden = !picked;
    };

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () { setState(btn.getAttribute('data-key')); });
    });
    reset.addEventListener('click', function () { setState(null); buttons[0].focus(); });
  }

  /* 3. Offline simulation ------------------------------------------------ */
  var demo = document.querySelector('[data-offline-demo]');
  if (demo) {
    var toggle = demo.querySelector('[data-offline-toggle]');
    var banner = demo.querySelector('[data-offline-banner]');
    var status = demo.querySelector('[data-status]');
    toggle.addEventListener('click', function () {
      var off = !demo.classList.contains('is-offline');
      demo.classList.toggle('is-offline', off);
      toggle.setAttribute('aria-pressed', String(off));
      banner.hidden = !off;
      status.textContent = off ? '1 answer waiting to save' : 'All answers saved';
    });
  }
})();
