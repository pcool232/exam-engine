'use strict';
/**
 * Landing page (views/landing.html) — the four small live bits:
 *   1. the hero exam card's countdown timer,
 *   2. the "try a question" demo (instant marking, no server round trip),
 *   3. the "simulate losing signal" toggle for the offline section,
 *   4. the "Download app now" button for the PWA (see #get-app).
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

  /* 4. Install the app (PWA) --------------------------------------------- */
  var installSection = document.querySelector('[data-pwa-install]');
  if (installSection) {
    var installBtn = installSection.querySelector('[data-install-btn]');
    var installHelp = installSection.querySelector('[data-install-help]');
    var iosHelp = installSection.querySelector('[data-install-ios]');
    var genericHelp = installSection.querySelector('[data-install-generic]');
    var deferredPrompt = null;

    // Chrome/Edge/Android fire this when the page qualifies as installable.
    // Capturing it lets us trigger the native install dialog from our own
    // button instead of waiting for the browser's own mini-infobar.
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
    });

    var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    var isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent || '');

    if (isStandalone) {
      // Already installed and running as an app -- nothing to install.
      installBtn.textContent = 'Open app';
      installBtn.addEventListener('click', function () {
        window.location.href = '/app?source=landing-install';
      });
    } else if (installBtn) {
      installBtn.addEventListener('click', function () {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.finally(function () { deferredPrompt = null; });
          return;
        }
        // No native prompt available (iOS Safari, or Chrome hasn't offered
        // it yet) -- show the manual steps instead of doing nothing.
        if (iosHelp) iosHelp.hidden = !isIOS;
        if (genericHelp) genericHelp.hidden = isIOS;
        installHelp.hidden = false;
        installHelp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
  }
})();
