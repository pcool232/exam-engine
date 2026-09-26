'use strict';
/**
 * A minimal SMTP client, built on node:net/node:tls only -- see AGENTS.md:
 * `pg` is the one dependency this app carries on purpose, so this doesn't
 * reach for nodemailer. Enough to send one plain-text/HTML email through a
 * normal SMTP relay (Gmail with an app password, Office 365, Zoho, a
 * school's own mail server, ...): implicit TLS or STARTTLS, then AUTH LOGIN.
 * Not a general-purpose mail library -- this app only ever sends one kind of
 * email, the "forgot your password?" link (see routes/auth.js).
 */

const net = require('node:net');
const tls = require('node:tls');
const config = require('../config');

const CRLF = '\r\n';
// Same philosophy as the database pool (see db.js): fail fast and visibly
// rather than let a misconfigured or unreachable relay hang a request until
// the platform's own timeout kills it.
const SOCKET_TIMEOUT_MS = 15000;

/** Resolves once a final SMTP reply line has arrived (the line whose 4th
 *  character is a space rather than '-', e.g. "250 OK" after any "250-..."
 *  continuation lines). */
function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(CRLF).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: lines.join('\n') });
      }
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('SMTP connection closed unexpectedly')); };
    const onTimeout = () => { cleanup(); socket.destroy(); reject(new Error('SMTP server did not respond in time')); };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('timeout', onTimeout);
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('timeout', onTimeout);
  });
}

async function command(socket, line) {
  socket.write(line + CRLF);
  return readReply(socket);
}

function expect(reply, codes, step) {
  const ok = Array.isArray(codes) ? codes.includes(reply.code) : reply.code === codes;
  if (!ok) throw new Error(`SMTP ${step} failed: ${reply.text}`);
  return reply;
}

// Subject/from/to here are always values this app itself builds (never raw
// user input passed straight through) -- this just guards against a stray
// CR/LF injecting extra headers.
function encodeHeader(value) {
  return String(value).replace(/[\r\n]/g, ' ');
}

function buildMessage({ from, to, subject, text, html }) {
  const boundary = `----revision-engine-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${encodeHeader(from)}`,
    `To: ${encodeHeader(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join(CRLF);
  // Dot-stuffing: a line that is *only* a dot would otherwise be read by the
  // server as the end of the DATA phase.
  const stuffed = body.split(CRLF).map((line) => (line.startsWith('.') ? `.${line}` : line)).join(CRLF);
  return `${headers.join(CRLF)}${CRLF}${CRLF}${stuffed}`;
}

function waitForConnect(socket, eventName) {
  return new Promise((resolve, reject) => {
    const onConnect = () => { cleanup(); resolve(); };
    const onError = (err) => { cleanup(); reject(err); };
    function cleanup() {
      socket.removeListener(eventName, onConnect);
      socket.removeListener('error', onError);
    }
    socket.once(eventName, onConnect);
    socket.once('error', onError);
  });
}

/**
 * Sends one email through config.smtp*. Resolves to `true` once the server
 * has accepted it, or `false` if no SMTP server is configured at all (the
 * message is logged to the console instead -- fine for local dev, not for
 * production). Throws if a server *is* configured but the send fails, so
 * callers can decide how to surface that.
 */
async function sendMail({ to, subject, text, html }) {
  const { smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, smtpSecure } = config;

  if (!smtpHost) {
    console.log(`[mailer] SMTP is not configured -- would have sent to ${to}:\n${subject}\n\n${text}`);
    return false;
  }

  const useImplicitTls = smtpSecure || smtpPort === 465;
  const rawSocket = useImplicitTls
    ? tls.connect({ host: smtpHost, port: smtpPort, servername: smtpHost })
    : net.connect({ host: smtpHost, port: smtpPort });
  rawSocket.setTimeout(SOCKET_TIMEOUT_MS);

  try {
    await waitForConnect(rawSocket, useImplicitTls ? 'secureConnect' : 'connect');

    let socket = rawSocket;
    expect(await readReply(socket), 220, 'greeting');
    expect(await command(socket, `EHLO ${smtpHost}`), 250, 'EHLO');

    if (!useImplicitTls) {
      expect(await command(socket, 'STARTTLS'), 220, 'STARTTLS');
      const upgraded = tls.connect({ socket, host: smtpHost, servername: smtpHost });
      upgraded.setTimeout(SOCKET_TIMEOUT_MS);
      await waitForConnect(upgraded, 'secureConnect');
      socket = upgraded;
      expect(await command(socket, `EHLO ${smtpHost}`), 250, 'EHLO (after STARTTLS)');
    }

    if (smtpUser) {
      expect(await command(socket, 'AUTH LOGIN'), 334, 'AUTH LOGIN');
      expect(await command(socket, Buffer.from(smtpUser).toString('base64')), 334, 'AUTH LOGIN (username)');
      expect(await command(socket, Buffer.from(smtpPass).toString('base64')), 235, 'AUTH LOGIN (password)');
    }

    const from = smtpFrom || smtpUser;
    expect(await command(socket, `MAIL FROM:<${from}>`), 250, 'MAIL FROM');
    expect(await command(socket, `RCPT TO:<${to}>`), [250, 251], 'RCPT TO');
    expect(await command(socket, 'DATA'), 354, 'DATA');

    const message = buildMessage({ from, to, subject, text, html });
    expect(await command(socket, `${message}${CRLF}.`), 250, 'message body');

    await command(socket, 'QUIT').catch(() => {});
    socket.end();
    return true;
  } finally {
    rawSocket.destroy();
  }
}

module.exports = { sendMail };
