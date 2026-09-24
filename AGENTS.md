# AGENTS.md

Quick orientation for any AI assistant working in this repository.
The full working rules live in `.cursor/rules/project.mdc` — read that first.

**What this is.** An exam revision engine. Administrators load past
examination papers; students sit them as timed multiple-choice practice exams
and are marked instantly.

**The four constraints that matter most:**

1. **One dependency, on purpose: `pg`.** This app deploys to Vercel, whose
   functions have no persistent local disk, so the database is PostgreSQL
   (Supabase in production) instead of a local file — that's the one thing
   allowed to come from npm. Don't add anything else; build it in
   `src/core/` or `src/lib/` instead.
2. **Node 22.5+.** Every database call is async (a network round trip to
   Postgres) — see `src/db.js`, `src/models/*.js`, `src/core/session.js`.
3. **No build step.** Plain CommonJS, hand-written template engine, one CSS file.
4. **Keep the security basics intact:** CSRF token on every POST form,
   parameterised SQL everywhere (`?` placeholders, converted to Postgres's
   `$1, $2, ...` in `src/db.js` — never string-build a query), scrypt for
   passwords, `{{ }}` escaping in templates, ownership checks before showing
   a student's results.

**Where things are:** `src/app.js` builds the app (middleware + routes, no
listener); `server.js` runs it locally, `api/index.js` runs it on Vercel;
`src/core/` is the mini-framework; `src/db.js` is the Postgres connection +
schema/migrations; `src/models/` holds the data and the marking logic;
`src/lib/parsers/` turns past papers into questions; `src/routes/` has the
handlers; `views/` and `public/` are the front end.

**To run it locally:** set `DATABASE_URL` to a Postgres connection string
(see `.env.example`), run `npm run seed` once, then `npm start`.
