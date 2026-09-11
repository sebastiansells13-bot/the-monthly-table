// Cloud Functions for The Monthly Table's email notifications.
//
// Two independent functions, sharing the helpers below:
//   - onNewEvent    Firestore trigger: fires when a document is created in
//                    `events`, emails every subscriber the announcement.
//   - dailyReminder Scheduled trigger: runs once a day, emails subscribers a
//                    digest of anything happening the next calendar day.
//
// Neither function ever touches the `events`/`subscribers` collections
// through the app's own firestore.rules -- the Admin SDK used here bypasses
// security rules entirely (that's expected and fine: this code runs on
// Google's infrastructure under this project's own service account, not in
// a visitor's browser).
//
// SETUP NEEDED BEFORE DEPLOYING (see README for the full walkthrough):
//   1. Verify a domain you own with Resend (Resend requires this -- unlike
//      some providers, there's no "verify a single address" option that
//      skips owning a domain) and set FROM_EMAIL below to an address at
//      that domain -- recipients will see it as the "from" address.
//   2. Store your Resend API key as a Firebase secret (never as plain
//      text in this file or anywhere in the repo):
//        firebase functions:secrets:set RESEND_API_KEY
//   3. firebase deploy --only functions

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { Resend } = require('resend');

initializeApp();
const db = getFirestore();

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

const SITE_URL = 'https://sebastiansells13-bot.github.io/the-monthly-table/';
// TODO: set this to an address at the domain you verified with Resend --
// it's what recipients see as the sender, not a secret, safe to commit.
const FROM_EMAIL = 'The Monthly Table <notifications@CHANGE-ME.example>';

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
      const body = lines.join('\n');
      return html ? body.replace(/\n/g, '<br>') : body;
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
      const body = lines.join('\n');
      return html ? body.replace(/\n/g, '<br>') : body;
    });
  }
);
