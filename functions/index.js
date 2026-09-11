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
//   1. Set FROM_EMAIL below to the address you verified as a Single Sender
//      in SendGrid -- recipients will see this as the "from" address.
//   2. Store your SendGrid API key as a Firebase secret (never as plain
//      text in this file or anywhere in the repo):
//        firebase functions:secrets:set SENDGRID_API_KEY
//   3. firebase deploy --only functions

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const sgMail = require('@sendgrid/mail');

initializeApp();
const db = getFirestore();

const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');

const SITE_URL = 'https://sebastiansells13-bot.github.io/the-monthly-table/';
// TODO: set this to the email address you verified in SendGrid's Single
// Sender Verification -- it's what recipients see as the sender, not a
// secret, safe to commit.
const FROM_EMAIL = 'CHANGE-ME@example.com';
const FROM_NAME = 'The Monthly Table';

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

  sgMail.setApiKey(SENDGRID_API_KEY.value());
  const messages = subscribers.map((s) => ({
    to: s.email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    text: buildBody(s.token, false),
    html: buildBody(s.token, true),
  }));

  // SendGrid's free tier handles this fine as individual sends; batching
  // just keeps any one API call small and easy to retry if it fails.
  const BATCH = 50;
  for (let i = 0; i < messages.length; i += BATCH) {
    await sgMail.send(messages.slice(i, i + BATCH));
  }
}

exports.onNewEvent = onDocumentCreated(
  { document: 'events/{eventId}', secrets: [SENDGRID_API_KEY] },
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
    secrets: [SENDGRID_API_KEY],
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
