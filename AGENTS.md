# AGENTS.md

Quick orientation for any AI assistant working in this repository.
The full working rules live in `.cursor/rules/project.mdc` — read that first.

**What this is.** An exam revision engine. Administrators load past
examination papers; students sit them as timed multiple-choice practice exams
and are marked instantly.

**The four constraints that matter most:**

1. **No dependencies.** `dependencies` in `package.json` is empty on purpose.
   Never add a package — build it in `src/core/` or `src/lib/` instead.
2. **Node 22.5+**, because the database is Node's built-in `node:sqlite`.
3. **No build step.** Plain CommonJS, hand-written template engine, one CSS file.
4. **Keep the security basics intact:** CSRF token on every POST form,
   prepared statements for all SQL, scrypt for passwords, `{{ }}` escaping in
   templates, ownership checks before showing a student's results.

**Where things are:** `server.js` wires everything; `src/core/` is the
mini-framework; `src/models/` holds the data and the marking logic;
`src/lib/parsers/` turns past papers into questions; `src/routes/` has the
handlers; `views/` and `public/` are the front end.

**To run it:** `npm run seed` once, then `npm start`.
