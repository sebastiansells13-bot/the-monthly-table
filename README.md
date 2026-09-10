# The Monthly Table

A community-run events calendar for Las Cruces, NM. Neighbors post monthly food distributions, care days, volunteer drives, community meals, and supply drives; anyone who opens the page can add one. Built as a single-page Claude Artifact backed by a live shared database — no backend to deploy or maintain.

It's an independent, community-maintained board — **not** an official page of, or endorsed by, 21st Century Care or Roadrunner Food Bank. It exists to point neighbors toward the kind of work those organizations do and to give people an easy way to organize grassroots events alongside it. See the "Why this board exists" section on the page itself for the exact wording — don't strengthen the affiliation language without both organizations' sign-off.

## Live page

- **Artifact URL:** https://claude.ai/code/artifact/961d5793-c566-49f5-ad24-124af6d9528c
- Private by default (owner-only) until shared from the page's own Share menu.

## How it works

- `index.html` is the entire site — one file, no build step.
- Data (submitted events) lives in the artifact's built-in `db` capability, not in this repo. The file has no seed data hardcoded in it; starter/example events were written directly into the live database via the Artifact tool, not the page source.
- Anyone with the page open can submit the "Host an event" form; it writes straight to the shared `events` collection and appears on every viewer's board immediately (no login, no moderation queue).

### `events` collection schema

Each document (auto-generated id):

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
| `photoAssetId` / `photoUrl` | string | optional, set when a host attaches a photo via the `assets` capability |
| `createdAt` | number | `Date.now()` epoch ms |

Each event also has an `events/{id}/rsvps/{visitorId}` subcollection — one doc per "I'm in" click, keyed by a random id the page stores in the visitor's `localStorage` (`mt_visitor_id`), so a person's RSVP is idempotent per browser with no login. The count shown on a card is `rsvps.size`, never a counter field (counters aren't safe under the store's last-writer-wins writes).

The board only shows events with `date >= today`; sorting is ascending by `date` then `time` string. Category → accent color mapping lives in the `CATS` object near the top of the `<script>` block in `index.html`.

## Features beyond the basic board

- **Host self-service edit/cancel.** Each card has a "Manage" control gated by the 4-digit code the host set at submission (hashed client-side with `crypto.subtle`, compared by hash — the plain code is never stored or transmitted). There's no recovery if a host loses their code; they'd need to repost.
- **RSVP.** "I'm in" writes a doc to that event's `rsvps` subcollection; the count is the subcollection size, not a counter.
- **Add to calendar.** A Google Calendar link (works without any capability) and an `.ics` download (via the `downloads` capability) per event. If a host didn't set start/end time, the calendar entry is all-day.
- **Optional event photo.** Uses the `assets` capability (`assets.upload`). Deleting an event does **not** delete its uploaded photo — orphaned assets accumulate and need occasional manual cleanup via the Artifact tool's `list_assets`/`delete_asset`.
- **Spam deterrence, not prevention.** A hidden honeypot field (`website`) silently no-ops real submissions from simple bots, and a 45-second per-browser cooldown (via `localStorage`) throttles repeat posting. Neither stops a determined actor — the `db` capability's default rules leave `events` writable by anyone who can open the page (that's what makes "anyone can host" possible), so nothing here is a real security boundary.
- **Old-listing cleanup.** On load, the page best-effort deletes events more than 60 days past their date (and their `rsvps`) to stay well under the artifact database's 5,000-document cap. This runs from any visitor's browser, not a server job.
- **Board admin panel.** A "Board admin" link in the footer opens a passphrase-gated panel (same hash-compare pattern as the edit code) listing every event, past included, with a one-click remove. **This is a UI convenience, not real access control** — every viewer already has the same underlying write/delete permission on the `events` collection; the passphrase only saves you from asking Claude to delete something. The current passphrase isn't written down here on purpose (this repo is public) — ask Sebastian, or change it yourself by computing a new SHA-256 hex digest (e.g. `printf '%s' 'your new phrase' | shasum -a 256`) and swapping the `ADMIN_HASH` constant near the top of the `<script>` block in `index.html`.

## Known limitations

- No true moderation boundary — see above. Fine for a small trusted community; risky if the link gets wide, anonymous reach.
- RSVP counts are fetched once per card load, not live-subscribed (the store caps subscriptions at 64 per view) — a count can be briefly stale if someone else RSVPs while you're looking at the same card.
- No custom domain — this lives at the Artifact URL above. A real domain would mean hosting the page outside Claude Artifacts entirely.
- Event photos have no editing/removal path after initial submission.

## Updating the live page

This repo is the source of truth for the page's code; the Artifact is the deployed copy.

1. Edit `index.html` here.
2. Republish it to the **same** artifact URL above (pass `url` when publishing) so the link doesn't change and existing data isn't affected.
3. Commit the change in this repo.

Database writes (seeding, corrections, moderation) go through the Artifact tool's `read_db`/`write_db` actions against the URL above — they don't touch this repo.

## Design notes

- Palette: dried-chile red, desert sage, and turquoise accents on warm adobe/sand neutrals — a Mesilla Valley/high-desert theme rather than a generic charity look.
- Type: Bricolage Grotesque (headlines) + Karla (body/UI), loaded from Google Fonts.
- Both light and dark themes are defined via CSS custom properties in `:root`.
