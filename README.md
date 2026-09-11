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
| **Photo upload** | Works | Wired up but silently no-ops — see Firebase project setup below |

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

## Features beyond the basic board (both versions)

- **Host self-service edit/cancel.** Each card has a "Manage" control gated by the 4-digit code the host set at submission (hashed client-side with `crypto.subtle`, compared by hash — the plain code is never stored or transmitted). There's no recovery if a host loses their code; they'd need to repost.
- **RSVP.** "I'm in" writes a doc to that event's `rsvps` subcollection.
- **Add to calendar.** A Google Calendar link and an `.ics` download per event. If a host didn't set start/end time, the calendar entry is all-day.
- **Optional event photo.**
- **Spam deterrence, not prevention.** A hidden honeypot field (`website`) silently no-ops real submissions from simple bots, and a 45-second per-browser cooldown (via `localStorage`) throttles repeat posting. Neither stops a determined actor with dev tools — see security notes below.
- **Old-listing cleanup.** On load, the page best-effort deletes events more than 60 days past their date (and their `rsvps`). This runs from any visitor's browser, not a server job.
- **Board admin panel.** A "Board admin" link in the footer opens a passphrase-gated panel (same hash-compare pattern as the edit code) listing every event, past included, with a one-click remove. **This is a UI convenience, not real access control** — see below. The current passphrase isn't written down here on purpose (this repo is public) — ask Sebastian, or change it yourself: compute a new SHA-256 hex digest (`printf '%s' 'your new phrase' | shasum -a 256`) and swap the `ADMIN_HASH` constant near the top of the `<script>` block, in **both** files if you want them to match.

## Security model, honestly

Both backends implement the same "anyone can host, no login" design, which means:

- **Artifact version:** every viewer of the artifact has the same read/write access to the `events` collection by default (the `db` capability's default rules). The 4-digit edit code and admin passphrase are UI-level friction, not enforced server-side.
- **GitHub Pages / Firebase version:** `firestore.rules` (in this repo) makes `events` and `events/*/rsvps` readable and writable by anyone — same open model — but adds real **server-side field validation** on create/update (required fields, length caps, an allowed category list, a date-format check) that the Artifact's `db` had no way to express. Still, nothing stops someone with browser dev tools from calling the Firestore SDK directly with the public `firebaseConfig` (which is *meant* to be public — Firebase's security model is the rules, not a hidden key) and editing or deleting any event, bypassing the edit-code/admin-passphrase UI entirely.

In short: both versions are fine for a small trusted community sharing a link, and both are vulnerable to a motivated bad actor. Real per-poster write protection would need actual authentication, which the site deliberately doesn't have (no accounts, no login).

## Firebase project (GitHub Pages version only)

- Project: `the-monthly-table` (Spark/free plan), console: https://console.firebase.google.com/project/the-monthly-table
- Firestore database created in Standard edition, `nam5` (US) location, rules in `firestore.rules` — paste that file's contents into the console's Firestore → Rules tab to update them (or use the Firebase CLI).
- **Storage (for photo upload) requires upgrading the project to the Blaze (pay-as-you-go) plan** — it needs a billing account on file even though actual usage stays within the free-tier credit for a small site like this. That upgrade needs to happen from the Firebase console by whoever owns the Google account; it's not something that can be scripted or done on someone's behalf. Until then, `docs/index.html` still tries `getStorage()`/`uploadBytes()` and just silently skips the photo (the rest of the submission goes through fine) — no code changes needed once Storage is enabled, it'll start working.
- The `firebaseConfig` object in `docs/index.html` (apiKey, projectId, etc.) is not a secret — Firebase's access model relies on security rules, not on hiding that object. Don't add real secrets (service account keys, admin credentials) to this repo.

## Updating the live pages

Each file is the source of truth for its own deployment:

- **Artifact version:** edit `index.html`, republish it to the same artifact URL above (pass that URL so it updates in place rather than creating a new artifact). Database writes/seeding/moderation for it go through the Artifact tool's `read_db`/`write_db` actions, not this repo.
- **GitHub Pages version:** edit `docs/index.html` and push to `master` — Pages rebuilds automatically from `/docs`. Firestore data changes go through the Firebase console, the Firebase CLI, or a script using the Firebase client SDK (`npm install firebase`) — never hand-edit `firestore.rules` deployment without also pasting the update into the console's Rules tab (this repo's copy isn't auto-deployed).

## Design notes

- Palette: dried-chile red, desert sage, and turquoise accents on warm adobe/sand neutrals — a Mesilla Valley/high-desert theme rather than a generic charity look.
- Type: Bricolage Grotesque (headlines) + Karla (body/UI), loaded from Google Fonts.
- Both light and dark themes are defined via CSS custom properties in `:root`.
- `docs/index.html` includes `[hidden]{display:none!important}` explicitly — outside the Claude Artifact wrapper (which injects that rule automatically), a class-based `display` rule at equal CSS specificity to `[hidden]` will beat the browser's native hidden-attribute handling and the element never actually hides. `index.html` doesn't need this since the Artifact platform adds it for you.
