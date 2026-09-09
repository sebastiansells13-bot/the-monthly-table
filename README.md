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
| `location` | string | free text |
| `hostName` | string | required |
| `hostContact` | string | optional, free text |
| `description` | string | required, ≤400 chars |
| `volunteersNeeded` | number | optional, `0` = not shown on the card |
| `createdAt` | number | `Date.now()` epoch ms |

The board only shows events with `date >= today`; sorting is ascending by `date` then `time` string. Category → accent color mapping lives in the `CATS` object near the top of the `<script>` block in `index.html`.

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
