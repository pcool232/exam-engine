'use strict';
/**
 * Guards a form against being submitted twice in a row -- a slow mobile
 * network (or an impatient double-tap while nothing visible has happened
 * yet) can fire the same POST twice before the first response comes back.
 *
 * That matters more here than on an ordinary form: signing in or resetting
 * a password rotates the session (see core/session.js#regenerateSession),
 * which deletes the old session row outright. A first request that lands
 * first already destroyed it by the time a near-simultaneous duplicate is
 * read -- so the duplicate gets a brand new, unrelated session and its
 * (now-stale) CSRF field no longer matches, which is exactly the "your
 * session expired or the form was stale" error this prevents.
 *
 * Harmless either way it plays out: on success the browser navigates away
 * before the button matters again; on a validation error the server
 * re-renders a full fresh page, button included.
 */
document.querySelectorAll('form[data-guard-submit]').forEach(function (form) {
  var submitted = false;
  form.addEventListener('submit', function (event) {
    if (submitted) {
      event.preventDefault();
      return;
    }
    submitted = true;
    var button = form.querySelector('button[type="submit"]');
    if (button) {
      button.disabled = true;
      if (button.dataset.busyText) button.textContent = button.dataset.busyText;
    }
  });
});
