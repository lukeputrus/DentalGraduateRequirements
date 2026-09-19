# Dental Graduate Requirements Tracker

A web app for dental students to track the clinical competencies they need to pass before graduating, and for program administrators to define and update those requirements per school and per graduating class.

## Features

- **Admin accounts** manage dental schools, define competencies (with prerequisite items — one-time steps or repeated case counts) per school and graduating class year, create and edit student accounts, reset passwords, and record official exam outcomes (passed / needs retest).
- **Student accounts** select their dental school and graduating class year from a dropdown, see their personal competency checklist grouped by category, check off prerequisites or log case counts with a stepper, search/filter their list, and see a live progress ring + stat breakdown (passed / eligible / prereqs in progress / not started / needs retest).
- **Per-class-year requirements**: competencies belong to a specific school + graduating class year, so updating requirements for an incoming class never changes what current students see. Admins can copy an entire competency set forward to a new class year as a starting point.
- **AI assistant widget** (bottom-right, student accounts only): students can ask questions about their own requirements or attach a document/image, answered by Claude with their live progress as context.
- Seeded with ~70 CODA-accredited U.S. dental schools (admin-editable) and a real, fully-populated example dataset: University of Detroit Mercy School of Dentistry, Class of 2028 (52 competencies / 117 items, extracted from the school's own competency manual — see **Detroit Mercy seed data** below).

## Tech stack

Node.js + Express, server-rendered EJS views, SQLite (`better-sqlite3`), session-based auth (`express-session`), `bcryptjs` for password hashing, `helmet` for security headers, hand-rolled CSRF protection, and the `@anthropic-ai/sdk` for the AI assistant. No frontend build step — plain CSS and a few small vanilla-JS enhancement files.

## Getting started

```bash
npm install
cp .env.example .env   # edit SESSION_SECRET at minimum
npm start              # creates/migrates the SQLite DB and seeds it on first run
```

Visit `http://localhost:3000`. The database file lives at `data/app.sqlite` (gitignored) and is created automatically.

### Temporary admin login

- **Username:** `luke`
- **Password:** `1234`

This account is seeded automatically the first time the app runs against an empty database. It is flagged as a temporary password, so the app **forces a password change on first login** — you can't do anything else until you set a new one. Do this immediately in any real deployment.

### Running tests

```bash
npm test
```

Covers the competency status/summary logic directly, plus integration tests (via `supertest`) for login, CSRF enforcement, and the full admin-builds-a-competency → student-clears-it → admin-marks-it-passed flow.

## How the requirements model works

- **Schools** — a flat, admin-editable list (Admin → Schools). Seeded with a broad list of accredited U.S. dental schools; add, rename, or remove any school at any time.
- **Competencies** — a gradeable exam a student must eventually pass (e.g. "Local Anesthesia (IAN) Competency"), scoped to one school + one graduating class year, with a category, an optional DS3/DS4 tag, a description, and an optional due date / source page citation.
- **Competency items** — the concrete prerequisites a student clears before they're eligible to sit a competency's exam. Each item is either **check** (a one-time pass/fail step) or **count** (done a specific number of times, e.g. "perform 3 supervised injections"), tracked per student with a checkbox or a +/− stepper.
- **Exam outcome** — recorded by an admin on the student's detail page (not_attempted / passed / needs_retest), independent of item progress. A competency's displayed status is computed as: `passed`/`needs_retest` if an admin has recorded one; otherwise `eligible` once every item hits its target, `prereqs_in_progress` once some items are underway, `not_started` otherwise.

Admins manage all of this from **Admin → Competencies**: pick a school + class year, add competencies and their items (each competency's editor is collapsible so a 50+ item list stays manageable), or copy a whole set forward to a new class year in one step.

## The AI assistant

Set `ANTHROPIC_API_KEY` in `.env` to enable it (get a key at https://console.anthropic.com/). Without a key, the widget still appears for students but replies with a message explaining it isn't configured yet — nothing breaks.

- Calls the Claude API (`claude-opus-5`) with the student's live competency progress summarized into the system prompt, so it can actually answer "what do I still need to do for Oral Surgery?"
- Supports attaching a PDF or image (PNG/JPEG/WEBP/GIF, 15MB max) to a question; the file is sent directly to Claude for that turn and is **not stored** on the server — only its filename is kept in the conversation history.
- Conversation history is stored per student (`chat_messages` table) so it persists across visits; only the last ~20 messages are replayed to the model to bound cost.
- Every request runs on your own Anthropic account and bills accordingly. For a class-wide rollout, consider the cost per message before enabling it broadly — `MODEL` and `output_config.effort` in `src/utils/anthropic.js` are the two easiest levers if you want to trade quality for cost.

## Detroit Mercy seed data

`src/data/detroitMercyClassOf2028.json` was extracted from the University of Detroit Mercy School of Dentistry's own "Class of 2028 Competency Manual" (a 325-page PDF) by having an AI agent read every competency's instructions section and structure it into this app's schema, citing the source page for each entry. It's a strong starting point, not a guarantee — **have the program review it against the current manual before students rely on it**, and use the admin Competencies page to correct anything that's changed. Nine entries (mostly in Periodontal and Radiology, which the manual doesn't subdivide by DS3/DS4) needed a judgment call on the dental year; search the JSON file for `"uncertain"` to see exactly which ones and why.

## Known limitations

- **Sessions are in-memory** (`express-session`'s default `MemoryStore`). Restarting the server logs everyone out. Fine for a single small program; swap in a persistent session store (e.g. `connect-sqlite3`) before running this at real scale or behind multiple processes.
- **SQLite** is a single file on local disk — simple and dependency-free, but means the app should run as a single process/instance. Fine for one program's cohort size; migrate to Postgres if you outgrow it.
- No email/forgot-password flow. Account recovery is admin-driven by design (admin resets a student's password to a new temporary one, shown once).

## Security notes

- Passwords are hashed with `bcryptjs`; the seeded temp admin password is hashed too and must be changed before the account can do anything else.
- CSRF tokens are required on every state-changing request (session-bound, checked server-side).
- `helmet` sets a strict Content-Security-Policy (no inline scripts/styles, no external origins); all interactivity is in same-origin `.js` files under `public/js/`.
- A student can only ever read or modify their own competency progress and chat history — every item/competency ID in a request is checked server-side against the logged-in student's own school + class year.
- Login attempts are rate-limited.
