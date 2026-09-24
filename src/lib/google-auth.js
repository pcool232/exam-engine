'use strict';
/**
 * Verifies a Google "Sign in with Google" ID token server-side.
 *
 * No dependency needed: Google publishes a tokeninfo endpoint that checks
 * the token's signature, issuer and expiry for us and hands back the
 * decoded claims as JSON. It's the same approach Google's own quickstart
 * docs suggest for low/medium-traffic sites that would rather not carry a
 * JWT/JWKS library just for this one check.
 *
 * https://developers.google.com/identity/sign-in/web/backend-auth
 */

const ALLOWED_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * @param {string} idToken - the `credential` field posted by Google's sign-in button.
 * @param {string} clientId - this app's OAuth client id (the expected audience).
 * @returns {Promise<{sub: string, email: string, name: string, picture: string} | null>}
 */
async function verifyGoogleIdToken(idToken, clientId) {
  if (!idToken || !clientId) return null;

  let response;
  try {
    response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    );
  } catch {
    return null; // network problem talking to Google -- treat as "could not verify"
  }
  if (!response.ok) return null;

  let claims;
  try {
    claims = await response.json();
  } catch {
    return null;
  }

  if (!ALLOWED_ISSUERS.has(claims.iss)) return null;
  if (claims.aud !== clientId) return null;
  if (claims.email_verified !== 'true' && claims.email_verified !== true) return null;
  if (!claims.sub || !claims.email) return null;
  const expSeconds = Number(claims.exp);
  if (!expSeconds || expSeconds * 1000 < Date.now()) return null;

  return {
    sub: String(claims.sub),
    email: String(claims.email).toLowerCase(),
    name: claims.name ? String(claims.name) : '',
    picture: claims.picture ? String(claims.picture) : '',
  };
}

module.exports = { verifyGoogleIdToken };
