'use strict';
/**
 * Sends text messages through Twilio's REST API, using Node's built-in fetch
 * -- no Twilio SDK, for the same reason lib/mailer.js has no nodemailer:
 * `pg` is the one dependency this app carries (see AGENTS.md).
 *
 * Switched on by setting TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and either
 * TWILIO_FROM (a Twilio number or approved sender ID) or
 * TWILIO_MESSAGING_SERVICE_SID. Without them, sendSms() logs what it would
 * have sent and returns false -- fine for local dev.
 */

const config = require('../config');

const REQUEST_TIMEOUT_MS = 10000;

function isConfigured() {
  return Boolean(config.twilioAccountSid && config.twilioAuthToken
    && (config.twilioFrom || config.twilioMessagingServiceSid));
}

/**
 * Sends one SMS. Resolves to true once Twilio has accepted it, or false when
 * SMS isn't configured. Throws when Twilio refuses it, so callers can count
 * failures.
 */
async function sendSms({ to, body }) {
  if (!isConfigured()) {
    console.log(`[sms] Twilio is not configured -- would have texted ${to}: ${body}`);
    return false;
  }

  const params = new URLSearchParams({ To: to, Body: body });
  if (config.twilioMessagingServiceSid) params.set('MessagingServiceSid', config.twilioMessagingServiceSid);
  else params.set('From', config.twilioFrom);

  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data && data.message ? `: ${data.message}` : '';
    } catch (_) { /* not JSON */ }
    throw new Error(`Twilio refused the SMS (HTTP ${response.status})${detail}`);
  }
  return true;
}

module.exports = { sendSms, isConfigured };
