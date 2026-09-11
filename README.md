# The Monthly Table

A community-run events calendar for Las Cruces, NM. Neighbors post monthly food distributions, care days, volunteer drives, community meals, and supply drives; anyone who opens the page can add one.

It's an independent, community-maintained board — **not** an official page of, or endorsed by, 21st Century Care or Roadrunner Food Bank. It exists to point neighbors toward the kind of work those organizations do and to give people an easy way to organize grassroots events alongside it. See the "Why this board exists" section on the page itself for the exact wording — don't strengthen the affiliation language without both organizations' sign-off.

## Two independent copies of the same app

This repo contains **two separate implementations** of the same design and feature set, each wired to a different backend. They share no code and their data does **not** sync with each other — the same event posted on one won't appear on the other.

| | `index.html` (repo root) | `docs/index.html` |
|---|---|---|
| **Live at** | https://claude.ai/code/artifact/961d5793-c566-49f5-ad24-124af6d9528c | https://sebastiansells13-bot.github.io/the-monthly-table/ |
| **Hosted by** | Claude Artifacts | GitHub Pages |
| **Data layer** | The Artifact's built-in `db`/`assets`/`downloads` capabilities (`window.claude.use(...)`) | Firebase (Firestore + Storage), project `the-monthly-table`, via the modular JS SDK loaded from `gstatic.com` |
| **Sharing** | Private by default — share from the page's own Share menu | Public, no sharing step needed |
| **Photo upload** | Works | Works (Blaze plan + Storage bucket both provisioned) |
| **`app.js`** | n/a — script is inline (the Artifact platform's own CSP already covers it) | Extracted to its own file so `script-src` can omit `unsafe-inline` in the page's CSP |
| **Email notifications** | Not available — the Artifact's `db` has no trigger system to hang a Cloud Function off of | New-event announcements + next-day reminders, via Cloud Functions (`functions/`) — see the setup section below |

Why two: the Artifact version is the original, quickest to iterate on from inside a Claude conversation. The GitHub Pages version exists so the board can live at a public URL with no claude.ai dependency. If you only need one, the Artifact version is simpler to maintain (no external project to manage); the Pages version is the one to point outside links at.

## `events` schema (same shape on both backends)

Each document (auto-generated id), collection `events`:

| field | type | notes |
|---|---|---|
| `title` | string | required, ≤80 chars |
| `category` | string | one of: `Food Distribution`, `Volunteer Day`, `Community Meal`, `Wellness & Care`, `Supply Drive` |
| `date` | string | `YYYY-MM-DD` |
| `time` | string | free text, e.g. `9:00–11:00 AM` |
| `startTime` / `endTime` | string | optional, `HH:MM` 24-hour — only used to build the "Add to calendar" links |
| `location` | string | free text |
| `hostName` | string | required |
| `hostContact` | string | optional, free text |
| `description` | string | required, ≤400 chars |
| `volunteersNeeded` | number | optional, `0` = not shown on the card |
| `editCodeHash` | string | SHA-256 hex of the 4-digit code the host set at submission — lets them edit/cancel later. Never store the plain code. |
| `photoAssetId` / `photoUrl` | string | optional, set when a host attaches a photo |
| `createdAt` | number | `Date.now()` epoch ms |

Each event also has an `events/{id}/rsvps/{visitorId}` subcollection — one doc per "I'm in" click, keyed by a random id the page stores in the visitor's `localStorage` (`mt_visitor_id`), so a person's RSVP is idempotent per browser with no login. The count shown on a card is the subcollection size, never a counter field (counters aren't safe under last-writer-wins writes, which both backends use).

The board only shows events with `date >= today`; sorting is ascending by `date` then `time` string. Category → accent color mapping lives in the `CATS` object near the top of each file's `<script>` block.

### `subscribers` schema (GitHub Pages / Firebase version only)

Each document, collection `subscribers`, **document id is the subscriber's unsubscribe token** (a client-generated UUID — see the security note in `firestore.rules` and below for why the collection is designed this way):

| field | type | notes |
|---|---|---|
| `email` | string | required, ≤254 chars, must match a basic email pattern |
| `subscribedAt` | number | `Date.now()` epoch ms |

Signing up writes one of these via the "Get notified" form. Unsubscribing (a link in every email, `#unsubscribe=<token>`) deletes it by id. Nothing else reads or writes this collection from the client — the Cloud Functions in `functions/` read it with the Admin SDK, which bypasses `firestore.rules` entirely.

## Features beyond the basic board (both versions)

- **Host self-service edit/cancel.** Each card has a "Manage" control gated by the 4-digit code the host set at submission (hashed client-side with `crypto.subtle`, compared by hash — the plain code is never stored or transmitted). There's no recovery if a host loses their code; they'd need to repost.
- **RSVP.** "I'm in" writes a doc to that event's `rsvps` subcollection.
- **Add to calendar.** A Google Calendar link and an `.ics` download per event. If a host didn't set start/end time, the calendar entry is all-day.
- **Optional event photo.**
- **Spam deterrence, not prevention.** A hidden honeypot field (`website`) silently no-ops real submissions from simple bots, and a 45-second per-browser cooldown (via `localStorage`) throttles repeat posting. Neither stops a determined actor with dev tools — see security notes below.
- **Old-listing cleanup.** On load, the page best-effort deletes events more than 60 days past their date (and their `rsvps`). This runs from any visitor's browser, not a server job.
- **Email notifications** *(GitHub Pages / Firebase version only)*. A "Get notified" box signs a visitor up by email — no login, no confirmation click (no double opt-in yet; see Known limitations). Two Cloud Functions in `functions/` do the actual sending: `onNewEvent` emails everyone when a new event is posted, `dailyReminder` runs once a day and emails a digest of anything happening the next calendar day. Both use Resend. Unsubscribing is one click from a link in every email — no page visit or form required, though the link does land back on the site to confirm. See "Email notifications setup" below to actually turn this on.
- **Board admin panel.** No visible link anywhere on purpose — open it by adding `#admin` to the page's URL (e.g. `https://sebastiansells13-bot.github.io/the-monthly-table/#admin`, or the Artifact URL with `#admin` appended) and reloading if it doesn't pop up immediately. That gets you a passphrase-gated panel (same hash-compare pattern as the edit code) listing every event, past included, with a one-click remove — no explanatory text in the popup itself; read this section instead. Closing the panel clears `#admin` from the URL so a plain reload afterward doesn't reopen it. **This is a UI convenience, not real access control** — see below; removing the visible link only cuts down on a casual visitor noticing the feature exists, it does nothing against anyone who reads the page source (the `#admin` trigger and the `admin-overlay` markup are both sitting right there) or opens dev tools. The current passphrase isn't written down here on purpose (this repo is public) — ask Sebastian, or change it yourself: compute a new SHA-256 hex digest (`printf '%s' 'your new phrase' | shasum -a 256`) and swap the `ADMIN_HASH` constant near the top of the `<script>` block (`docs/app.js` for the Pages version, the inline `<script>` in `index.html` for the Artifact version), in **both** files if you want them to match.

## Security model, honestly

Both backends implement the same "anyone can host, no login" design. That tradeoff runs deeper than "someone with dev tools could bypass the UI" — read this section rather than assuming the friction below is stronger than it is.

**The edit code and admin passphrase are crackable by reading the board, not just by opening dev tools.** `editCodeHash` is stored in the same document that `allow read: if true` makes public. A 4-digit code is only 10,000 possibilities — anyone can pull that hash from the open data feed and brute-force it locally in well under a second, then use "Manage" *exactly as designed* to edit or cancel that event. The admin passphrase has the same shape of problem: `ADMIN_HASH` is a constant in public page source, and unlocking it is a pure client-side hash comparison that never touches the network — brute-forcing it is not just possible but instant and undetectable, unlike even a weak server-side login (which at least makes a request an operator could notice or rate-limit). Longer passphrase entropy makes exhaustive brute-force impractical, but a targeted dictionary/guessing attack is not. **Nothing in this codebase can fix that without adding real accounts**, which the site deliberately doesn't have. Rotate the admin passphrase if you suspect it's been guessed; there's no equivalent fix for a compromised edit code beyond deleting and re-posting the event.

- **Artifact version:** every viewer of the artifact has the same read/write access to the `events` collection by default (the `db` capability's default rules), and the Artifact's `db` has no way to express field-shape validation at all — a malformed write (accidental or malicious) has no schema to fail against. `renderEvents()` now wraps each card's render in try/catch so one bad document degrades to a skipped card instead of breaking the board for everyone, but the document itself is still accepted as written.
- **GitHub Pages / Firebase version:** `firestore.rules` makes `events` and `events/*/rsvps` readable and writable by anyone — same open model — but adds real **server-side field validation** on create/update: required fields, length caps, an allowed category list, a date-format check, and (as of this pass) validation that `photoUrl` is either empty or a genuine download URL from this project's own Storage bucket, closing off using an event's photo field to hotlink arbitrary external content. `storage.rules` caps uploads at 8 MiB and restricts content types to `image/jpeg|png|gif|webp` — deliberately excluding `image/svg+xml`, since SVG can carry an embedded `<script>`; the app only ever renders `photoUrl` inside an `<img>` (which never executes it), but the raw Storage URL is a plain link, and a malicious SVG served from it would run script if someone opened that link directly. A CSP is set via `<meta>` (`script-src 'self' https://www.gstatic.com`, no `unsafe-inline`, which is why the script now lives in `docs/app.js` rather than inline) to cap the blast radius of anything future found. Still, nothing stops someone with browser dev tools from calling the Firestore/Storage SDK directly with the public `firebaseConfig` (which is *meant* to be public — Firebase's security model is the rules, not a hidden key) and editing or deleting any event, or hammering `addDoc` to exhaust the project's document quota — the honeypot field and posting cooldown are page-JS only, enforced nowhere server-side, and both bypassable in seconds by anyone who skips the form.

In short: both versions are fine for a small trusted community sharing a link, and both are vulnerable to a motivated reader of their own public data, not just a sophisticated attacker. Real per-poster write protection and real rate limiting would both need actual authentication, which the site deliberately doesn't have.

**`subscribers` is the one collection that's deliberately *not* openly readable.** Unlike `events`, email addresses are real PII and were never meant to be public. `firestore.rules` allows `get` (fetch one document you already have the id for) but not `list` (enumerate/query the whole collection) — since the document id is an effectively-unguessable UUID chosen by the signing-up client, this is the same "secret link" pattern Firestore's own docs recommend, not security through obscurity on top of an otherwise-open collection. A subscriber's email is only ever readable by someone holding their own token (i.e. the subscriber themselves, via their unsubscribe link) or by the Cloud Functions' Admin SDK access, which bypasses rules entirely and runs only on Google's infrastructure under this project.

**Known, accepted, not fixed:** RSVP counts can be trivially inflated (no uniqueness or rate constraint beyond a client-generated visitor id) — low stakes, not worth the complexity of a real fix given everything above. Email signup has no confirmation step (no double opt-in) — anyone could sign a stranger's address up without their consent, since there's no login to verify against. Genuinely fixing that needs a confirm-your-email flow, which needs the Cloud Functions to be live first (send the confirmation email) — worth adding once the base notification system is working and this stops being a purely theoretical gap.

## Firebase project (GitHub Pages version only)

- Project: `the-monthly-table` on the **Blaze** (pay-as-you-go) plan, console: https://console.firebase.google.com/project/the-monthly-table
- Firestore database created in Standard edition, `nam5` (US) location, rules in `firestore.rules` — paste that file's contents into the console's Firestore → Rules tab to update them (or use the Firebase CLI).
- Storage bucket `the-monthly-table.firebasestorage.app`, no-cost location (`US-EAST1`), rules in `storage.rules` (same paste-to-update workflow, under Storage → Rules).
- **Cost:** Blaze doesn't change the free quota — it only lets usage exceed it (and bills for the excess) instead of hard-capping at it. At this site's realistic scale (a small community calendar), expected spend is $0/month; the free tier alone comfortably covers normal traffic by a wide margin. A **budget alert** is configured on the linked billing account (Google Cloud Console → Billing → Budgets & alerts → "Firebase Project the-monthly-table"): emails at $1, $1.80, and $2 of actual spend, sent to both billing admins and project owners. Firebase auto-created this budget at the same default thresholds during the Blaze upgrade — nothing needed to be added.
- The `firebaseConfig` object in `docs/index.html` (apiKey, projectId, etc.) is not a secret — Firebase's access model relies on security rules, not on hiding that object. Don't add real secrets (service account keys, admin credentials) to this repo.

## Email notifications setup

The signup form and `subscribers` collection work as soon as `firestore.rules` is deployed (see above) — people can sign up right now. Nothing actually gets *sent* until the two Cloud Functions in `functions/` are deployed, which needs a few one-time steps:

1. **Own a domain.** Unlike some providers, Resend requires verifying a domain you own before it'll send to real recipients at all — there's no "verify a single email address" shortcut. If you don't have one yet, buy it yourself from any registrar (that's a purchase only you can make); Cloudflare Registrar and Namecheap are both reasonable, no-nonsense options.
2. **Create a free Resend account** at [resend.com](https://resend.com) (or swap in another provider — the code isolates all of the sending logic in `sendToSubscribers()` in `functions/index.js`, so switching means rewriting that one function, not the two triggers that call it).
3. **Add and verify your domain**: Domains → Add Domain, then add the DNS records Resend shows you (SPF/DKIM, typically 2-3 TXT/MX records) at wherever you manage that domain's DNS. Verification is usually automatic within minutes once the records propagate.
4. **Create an API key**: API Keys → Create API Key, with "Sending access" permission. Copy it somewhere safe (a password manager) — Resend only shows it once.
5. **Set `FROM_EMAIL`** in `functions/index.js` to an address at your verified domain (e.g. `notifications@yourdomain.com`) — it's not a secret, it's just what recipients see as the sender, safe to commit.
6. **Install the Firebase CLI and log in** (this needs to happen in a real terminal you control, since it opens a Google OAuth consent screen for you to approve):
   ```bash
   npx firebase-tools login
   ```
7. **Store the API key as a secret** — never paste it into any file in this repo, this is the one step that has to go directly into Firebase's own secret storage:
   ```bash
   npx firebase-tools functions:secrets:set RESEND_API_KEY
   ```
   (it'll prompt you to paste the key; input is hidden)
8. **Deploy:**
   ```bash
   cd functions && npm install && cd ..
   npx firebase-tools deploy --only functions
   ```

After that, `onNewEvent` fires automatically the next time someone posts an event, and `dailyReminder` starts running once a day at 2pm Mountain Time. To confirm it's working without waiting for a real event, use the Firebase console's Cloud Functions logs (or `npx firebase-tools functions:log`), or manually add a test document to `events` via the Firestore console and watch for the email.

## Updating the live pages

Each file is the source of truth for its own deployment:

- **Artifact version:** edit `index.html`, republish it to the same artifact URL above (pass that URL so it updates in place rather than creating a new artifact). Database writes/seeding/moderation for it go through the Artifact tool's `read_db`/`write_db` actions, not this repo.
- **GitHub Pages version:** edit `docs/index.html` (and `docs/app.js`) and push to `master` — Pages rebuilds automatically from `/docs`. Firestore data changes go through the Firebase console, the Firebase CLI, or a script using the Firebase client SDK (`npm install firebase`) — never hand-edit `firestore.rules`/`storage.rules` deployment without also pasting the update into the console's Rules tab (this repo's copy isn't auto-deployed).
- **Cloud Functions:** edit `functions/index.js`, then `npx firebase-tools deploy --only functions` from the repo root. This repo's copy also isn't auto-deployed — same "paste it into the console, or run the deploy command" rule as the security rules files.

## Design notes

- Palette: dried-chile red, desert sage, and turquoise accents on warm adobe/sand neutrals — a Mesilla Valley/high-desert theme rather than a generic charity look.
- Type: Bricolage Grotesque (headlines) + Karla (body/UI), loaded from Google Fonts.
- Both light and dark themes are defined via CSS custom properties in `:root`.
- `docs/index.html` includes `[hidden]{display:none!important}` explicitly — outside the Claude Artifact wrapper (which injects that rule automatically), a class-based `display` rule at equal CSS specificity to `[hidden]` will beat the browser's native hidden-attribute handling and the element never actually hides. `index.html` doesn't need this since the Artifact platform adds it for you.
