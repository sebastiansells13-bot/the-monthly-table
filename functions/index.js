// Cloud Functions for The Monthly Table.
//
// Event writes (all callable from the page via the Firebase JS SDK):
//   - createEvent        Validates and posts an event, stores the host's email
//                         privately, emails them a signed "manage" link.
//   - getManageAccess    Checks a manage link before the page opens the editor.
//   - updateEvent        Saves edits -- requires that event's manage link.
//   - cancelEvent        Deletes the event -- requires that event's manage link.
//   - resendManageLinks  "Lost your link?" -- re-emails links for an address.
//   - adminRemoveEvent   Board-admin removal, gated by the admin passphrase.
//
// Email notifications:
//   - onNewEvent    Firestore trigger: fires when a document is created in
//                    `events`, emails every subscriber the announcement.
//   - dailyReminder Scheduled trigger: runs once a day, emails subscribers a
//                    digest of anything happening the next calendar day.
//
// Housekeeping:
//   - pruneOldEvents Scheduled trigger: deletes listings 60+ days past their
//                    date (and their RSVPs, owner record, and photo).
//
// firestore.rules makes `events` read-only from the browser, so these
// functions are the only way to create, edit, or delete one. The Admin SDK
// used here bypasses security rules entirely (that's expected and fine: this
// code runs on Google's infrastructure under this project's own service
// account, not in a visitor's browser).
//
// SETUP NEEDED BEFORE DEPLOYING (see README for the full walkthrough):
//   1. Verify a domain you own with Resend (Resend requires this -- unlike
//      some providers, there's no "verify a single address" option that
//      skips owning a domain) and set FROM_EMAIL below to an address at
//      that domain -- recipients will see it as the "from" address.
//   2. Store your Resend API key as a Firebase secret (never as plain
//      text in this file or anywhere in the repo):
//        firebase functions:secrets:set RESEND_API_KEY
//   3. Store a random signing key for manage links the same way:
//        openssl rand -base64 32   # copy the output, then:
//        firebase functions:secrets:set MANAGE_LINK_SECRET
//   4. firebase deploy --only functions

const crypto = require('crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { Resend } = require('resend');
const { createManageToken, verifyManageToken } = require('./manage-token');

initializeApp();
const db = getFirestore();

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const MANAGE_LINK_SECRET = defineSecret('MANAGE_LINK_SECRET');

const SITE_URL = 'https://sebastiansells13-bot.github.io/the-monthly-table/';
// TODO: set this to an address at the domain you verified with Resend --
// it's what recipients see as the sender, not a secret, safe to commit.
const FROM_EMAIL = 'The Monthly Table <notifications@CHANGE-ME.example>';

// SHA-256 of the board-admin passphrase -- the same constant as ADMIN_HASH
// in docs/app.js. Keep the two in sync when rotating (see README).
const ADMIN_HASH = '5f4f6fab154b4e5fe5789d4fd8aebdf94c1f75926e0c7b4335bd05e7f72e2b35';

const CATEGORIES = ['Food Distribution', 'Volunteer Day', 'Community Meal', 'Wellness & Care', 'Supply Drive'];
const PHOTO_URL_PREFIX = 'https://firebasestorage.googleapis.com/v0/b/the-monthly-table.firebasestorage.app/';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Plain-text lines -> an HTML body, escaping event text hosts typed in and
// turning bare URLs into links.
function linesToHtml(lines) {
  return lines
    .map((l) => escapeHtml(l).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>'))
    .join('<br>');
}

function unsubscribeUrl(token) {
  return `${SITE_URL}#unsubscribe=${encodeURIComponent(token)}`;
}

function eventLine(e) {
  const bits = [e.title, e.date];
  if (e.time) bits.push(e.time);
  if (e.location) bits.push(e.location);
  return bits.join(' — ');
}

async function getSubscribers() {
  // Modest cap -- see firestore.rules and README for why this collection
  // can't just be queried freely from the client, and why 2,000 is more
  // than this site will ever realistically need.
  const snap = await db.collection('subscribers').limit(2000).get();
  return snap.docs.map((d) => ({ token: d.id, email: d.data().email }));
}

async function sendToSubscribers(subject, buildBody) {
  const subscribers = await getSubscribers();
  if (subscribers.length === 0) return;

  const resend = new Resend(RESEND_API_KEY.value());
  const messages = subscribers.map((s) => ({
    to: [s.email], // one recipient per message -- never bundle multiple
                    // subscribers into one `to` array, that would expose
                    // every recipient's address to every other recipient
    from: FROM_EMAIL,
    subject,
    text: buildBody(s.token, false),
    html: buildBody(s.token, true),
  }));

  // Resend's batch endpoint takes up to 100 distinct emails per call.
  const BATCH = 100;
  for (let i = 0; i < messages.length; i += BATCH) {
    const { error } = await resend.batch.send(messages.slice(i, i + BATCH));
    if (error) throw new Error(`Resend batch send failed: ${error.message || error}`);
  }
}

exports.onNewEvent = onDocumentCreated(
  { document: 'events/{eventId}', secrets: [RESEND_API_KEY] },
  async (event) => {
    const e = event.data && event.data.data();
    if (!e || !e.title) return; // defensive -- shouldn't happen given firestore.rules

    const subject = `New on The Monthly Table: ${e.title}`;
    await sendToSubscribers(subject, (token, html) => {
      const lines = [
        'A new event just went up on The Monthly Table:',
        '',
        eventLine(e),
        e.description || '',
        '',
        `See it and RSVP: ${SITE_URL}#board`,
        '',
        `Unsubscribe: ${unsubscribeUrl(token)}`,
      ];
      return html ? linesToHtml(lines) : lines.join('\n');
    });
  }
);

exports.dailyReminder = onSchedule(
  {
    // Runs at 2pm Mountain Time. Because Denver is always behind UTC, this
    // local run time never crosses a UTC midnight boundary relative to
    // Denver's own calendar day -- so computing "tomorrow" via UTC Date
    // math below still lines up with Denver's "tomorrow". If you ever move
    // this schedule to run near Denver midnight, redo this math with an
    // actual Denver-timezone-aware date library instead.
    schedule: 'every day 14:00',
    timeZone: 'America/Denver',
    secrets: [RESEND_API_KEY],
  },
  async () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD, matches the app's date field

    const snap = await db.collection('events').where('date', '==', dateStr).get();
    if (snap.empty) return;
    const events = snap.docs.map((d) => d.data());

    const subject = events.length === 1
      ? `Tomorrow: ${events[0].title}`
      : `${events.length} events on The Monthly Table tomorrow`;

    await sendToSubscribers(subject, (token, html) => {
      const lines = [
        'Happening tomorrow on The Monthly Table:',
        '',
        ...events.map(eventLine),
        '',
        `See details: ${SITE_URL}#board`,
        '',
        `Unsubscribe: ${unsubscribeUrl(token)}`,
      ];
      return html ? linesToHtml(lines) : lines.join('\n');
    });
  }
);

// ---------------------------------------------------------------------------
// Event writes
// ---------------------------------------------------------------------------

// Hosts are in Las Cruces, so "today" means Mountain Time's calendar day,
// not the server's UTC one.
function todayDenver() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
}

function manageUrl(token) {
  return `${SITE_URL}#manage=${encodeURIComponent(token)}`;
}

function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new HttpsError('invalid-argument', 'That doesn’t look like a valid email address.');
  }
  return email;
}

function str(input, field) {
  return typeof input[field] === 'string' ? input[field].trim() : '';
}

// Server-side twin of the page's form checks -- the page's checks are for
// friendly messages, these are the ones that actually hold.
function cleanEvent(input) {
  if (!input || typeof input !== 'object') throw new HttpsError('invalid-argument', 'Missing event details.');
  const e = {
    title: str(input, 'title'),
    category: str(input, 'category'),
    date: str(input, 'date'),
    time: str(input, 'time'),
    startTime: str(input, 'startTime'),
    endTime: str(input, 'endTime'),
    location: str(input, 'location'),
    hostName: str(input, 'hostName'),
    hostContact: str(input, 'hostContact'),
    description: str(input, 'description'),
    volunteersNeeded: Math.floor(Number(input.volunteersNeeded) || 0),
  };
  const bad = (msg) => { throw new HttpsError('invalid-argument', msg); };
  if (!e.title || !e.date || !e.time || !e.location || !e.hostName || !e.description) bad('Fill in the required fields.');
  if (e.title.length > 80 || e.time.length > 40 || e.location.length > 100 || e.hostName.length > 60
    || e.hostContact.length > 80 || e.description.length > 400) bad('One of the fields is too long.');
  if (!CATEGORIES.includes(e.category)) bad('Choose a category.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) bad('Pick a date.');
  if (e.date < todayDenver()) bad('Pick today or a later date.');
  for (const t of [e.startTime, e.endTime]) if (t && !/^\d{2}:\d{2}$/.test(t)) bad('Start and end times need to be HH:MM.');
  if (e.startTime && e.endTime && e.endTime <= e.startTime) bad('End time needs to be after the start time.');
  if (e.volunteersNeeded < 0 || e.volunteersNeeded > 200) bad('Volunteers needed must be between 0 and 200.');
  return e;
}

function cleanPhoto(input) {
  const photoUrl = typeof input.photoUrl === 'string' ? input.photoUrl : '';
  const photoAssetId = typeof input.photoAssetId === 'string' ? input.photoAssetId : '';
  if (!photoUrl) return { photoUrl: '', photoAssetId: '' };
  // Only photos that went through this project's own upload flow --
  // never an arbitrary external URL.
  if (!photoUrl.startsWith(PHOTO_URL_PREFIX) || !photoAssetId.startsWith('event-photos/') || photoAssetId.length > 300) {
    throw new HttpsError('invalid-argument', 'That photo didn’t upload correctly — try again without it.');
  }
  return { photoUrl, photoAssetId };
}

// Fixed-window counter in the private `rateLimits` collection. Keys are
// hashed so no raw IPs or email addresses are stored there.
async function takeRateLimit(key, max, windowMs, message) {
  const ref = db.collection('rateLimits').doc(crypto.createHash('sha256').update(key).digest('hex'));
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : null;
    if (!cur || now - cur.windowStart > windowMs) {
      tx.set(ref, { count: 1, windowStart: now });
      return;
    }
    if (cur.count >= max) throw new HttpsError('resource-exhausted', message);
    tx.update(ref, { count: cur.count + 1 });
  });
}

function callerIp(request) {
  return (request.rawRequest && request.rawRequest.ip) || 'unknown';
}

// Resolves a manage link to its event, or throws the error the page shows.
async function eventForToken(token) {
  const eventId = verifyManageToken(MANAGE_LINK_SECRET.value(), token);
  if (!eventId) throw new HttpsError('permission-denied', 'That edit link isn’t valid or has expired — request a new one below.');
  const ref = db.collection('events').doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That event has already been removed.');
  return { ref, data: snap.data() };
}

async function deleteEventFully(ref, data) {
  await db.recursiveDelete(ref); // the event plus its rsvps subcollection
  await db.collection('eventOwners').doc(ref.id).delete().catch(() => {});
  if (data && data.photoAssetId) {
    await getStorage().bucket().file(data.photoAssetId).delete().catch(() => {});
  }
}

async function sendEmail(to, subject, lines) {
  const resend = new Resend(RESEND_API_KEY.value());
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject,
    text: lines.join('\n'),
    html: linesToHtml(lines),
  });
  if (error) throw new Error(`Resend send failed: ${error.message || error}`);
}

function sendManageEmail(to, e, token) {
  return sendEmail(to, `Your event is on the board: ${e.title}`, [
    'Thanks for hosting! Your event is live on The Monthly Table:',
    '',
    eventLine(e),
    '',
    'To edit or cancel it, use this link:',
    manageUrl(token),
    '',
    'Keep this email — anyone with the link can change your listing, so don’t forward it.',
    `Lost it? You can request a new one at ${SITE_URL}#host`,
  ]);
}

const writeOpts = { secrets: [RESEND_API_KEY, MANAGE_LINK_SECRET] };

exports.createEvent = onCall(writeOpts, async (request) => {
  const input = request.data || {};
  // Honeypot -- bots that fill every field get a fake success, no write.
  if (typeof input.website === 'string' && input.website.trim()) return { id: null, emailSent: true };

  const email = normalizeEmail(input.email);
  const event = cleanEvent(input.event);
  const photo = cleanPhoto(input.event || {});

  await takeRateLimit(`create-ip:${callerIp(request)}`, 5, 60 * 60 * 1000,
    'You’ve posted several events in the last hour — please try again later.');
  await takeRateLimit(`create-email:${email}`, 10, 24 * 60 * 60 * 1000,
    'That email has posted a lot of events today — please try again tomorrow.');

  const ref = db.collection('events').doc();
  const createdAt = Date.now();
  const batch = db.batch();
  batch.set(ref, { ...event, ...photo, createdAt });
  // Private: firestore.rules gives the browser no access to this collection.
  batch.set(db.collection('eventOwners').doc(ref.id), { email, createdAt });
  await batch.commit();

  let emailSent = true;
  try {
    await sendManageEmail(email, event, createManageToken(MANAGE_LINK_SECRET.value(), ref.id));
  } catch (err) {
    console.error('manage email failed', ref.id, err);
    emailSent = false;
  }
  return { id: ref.id, emailSent };
});

exports.getManageAccess = onCall(writeOpts, async (request) => {
  const { ref } = await eventForToken((request.data || {}).token);
  return { eventId: ref.id };
});

exports.updateEvent = onCall(writeOpts, async (request) => {
  const input = request.data || {};
  const { ref } = await eventForToken(input.token);
  const event = cleanEvent(input.event);
  await ref.update(event); // photo fields and createdAt are left as they were
  return { ok: true };
});

exports.cancelEvent = onCall(writeOpts, async (request) => {
  const { ref, data } = await eventForToken((request.data || {}).token);
  await deleteEventFully(ref, data);
  return { ok: true };
});

exports.resendManageLinks = onCall(writeOpts, async (request) => {
  const email = normalizeEmail((request.data || {}).email);
  const tooMany = 'Too many requests — please wait a bit and try again.';
  await takeRateLimit(`resend-ip:${callerIp(request)}`, 10, 60 * 60 * 1000, tooMany);
  await takeRateLimit(`resend-email:${email}`, 3, 60 * 60 * 1000, tooMany);

  const owned = await db.collection('eventOwners').where('email', '==', email).limit(50).get();
  const today = todayDenver();
  const links = [];
  for (const o of owned.docs) {
    const snap = await db.collection('events').doc(o.id).get();
    if (!snap.exists || snap.data().date < today) continue;
    const e = snap.data();
    links.push(eventLine(e), manageUrl(createManageToken(MANAGE_LINK_SECRET.value(), o.id)), '');
  }
  // Same response either way, so this can't be used to check whether an
  // address has posted anything.
  if (links.length) {
    try {
      await sendEmail(email, 'Your edit links for The Monthly Table', [
        'Here are the edit links for your upcoming events:',
        '',
        ...links,
        'Anyone with a link can change that listing, so don’t forward this email.',
      ]);
    } catch (err) {
      console.error('resend links email failed', err);
    }
  }
  return { ok: true };
});

exports.adminRemoveEvent = onCall(async (request) => {
  const input = request.data || {};
  await takeRateLimit(`admin-ip:${callerIp(request)}`, 30, 10 * 60 * 1000, 'Too many attempts — wait a few minutes.');
  const hash = crypto.createHash('sha256').update(String(input.passphrase || '')).digest('hex');
  if (hash !== ADMIN_HASH) throw new HttpsError('permission-denied', 'That passphrase doesn’t match.');
  if (typeof input.eventId !== 'string' || !input.eventId) throw new HttpsError('invalid-argument', 'Missing event.');
  const ref = db.collection('events').doc(input.eventId);
  const snap = await ref.get();
  if (snap.exists) await deleteEventFully(ref, snap.data());
  return { ok: true };
});

exports.pruneOldEvents = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'America/Denver' },
  async () => {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 60);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    const old = await db.collection('events').where('date', '<', cutoffISO).limit(200).get();
    for (const d of old.docs) await deleteEventFully(d.ref, d.data());

    // Rate-limit windows are at most a day long.
    const staleLimits = await db.collection('rateLimits')
      .where('windowStart', '<', Date.now() - 2 * 24 * 60 * 60 * 1000).limit(500).get();
    await Promise.all(staleLimits.docs.map((d) => d.ref.delete()));
  }
);
