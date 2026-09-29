// Signed "manage this event" link tokens.
//
// Same shape as the magic links in aindaco1/pool (worker/src/token.js): a
// base64url JSON payload plus an HMAC-SHA256 signature over it, so a token
// is self-verifying and nothing extra has to be stored per link. A valid
// token only ever authorizes its own event, and every use still checks the
// real event exists -- deleting the event is what "revokes" its links.
// Rotating MANAGE_LINK_SECRET invalidates every outstanding link at once.

const crypto = require('crypto');

const DEFAULT_TTL_DAYS = 90;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(secret, payloadB64) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function createManageToken(secret, eventId, ttlDays = DEFAULT_TTL_DAYS) {
  if (!secret) throw new Error('missing manage-link secret');
  const payload = { e: eventId, x: Math.floor(Date.now() / 1000) + ttlDays * 86400 };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}

// Returns the event id the token is for, or null if it's malformed,
// tampered with, or expired.
function verifyManageToken(secret, token) {
  if (!secret || typeof token !== 'string' || token.length > 512) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = Buffer.from(sign(secret, payloadB64));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (typeof payload.e !== 'string' || !payload.e) return null;
    if (typeof payload.x !== 'number' || payload.x < Math.floor(Date.now() / 1000)) return null;
    return payload.e;
  } catch (e) {
    return null;
  }
}

module.exports = { createManageToken, verifyManageToken, DEFAULT_TTL_DAYS };
