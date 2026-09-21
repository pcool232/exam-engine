# Running this project in Cursor (Windows)

Ten minutes end to end. You do not need to install any packages.

---

## 1. Check your Node.js version

The project uses Node's built-in SQLite, so it needs **Node 22.5 or newer**.

Open Cursor, then open a terminal with **Ctrl + `** (Ctrl and the backtick key,
above Tab) and run:

```powershell
node --version
```

- **v22.5.0 or higher** — you are ready, go to step 2.
- **Lower, or "not recognised"** — install the current LTS from
  <https://nodejs.org>, accept the defaults, then **close and reopen Cursor**
  and check again. Cursor only picks up a new PATH on restart.

---

## 2. Open the project

**File → Open Folder…** and choose the `revision-engine` folder.

Open the folder itself — not a file inside it, and not its parent. Cursor's
project rules, the debug configuration and the AI context all key off the
folder root. You should see `server.js` and `package.json` at the top level of
the sidebar.

If Cursor asks *"Do you trust the authors of the files in this folder?"*,
choose **Yes, I trust the authors** — the terminal and debugger will not run
otherwise.

---

## 3. Create the database and your administrator account

In the terminal (**Ctrl + `**):

```powershell
npm run seed
```

This creates `data/revision-engine.db`, an administrator account and a sample
exam. It prints your sign-in details:

```
email:    admin@revision.local
password: ChangeMe123!
```

Run this once. Running it again is harmless — it leaves an existing
administrator and sample exam alone.

---

## 4. Start the server

```powershell
npm start
```

You will see:

```
  Revision Engine is running
  →  http://localhost:3000
```

Ctrl-click that link, or open <http://localhost:3000> in your browser.

Sign in with the details from step 3, then open **My account** and change the
password before anyone else uses it.

To stop the server, click the terminal and press **Ctrl + C**.

---

## 5. Load a real past paper

1. **Exams → Import an exam file** — choose a JSON, CSV, Word, PDF or text
   file, or paste the questions into the box underneath the file picker.
2. **Review** — every question that was read is shown with its correct answer
   marked, and anything the parser could not make sense of is listed separately
   and skipped. A JSON file can also carry the exam's title, time limit and
   pass mark, which arrive already filled in.
3. **Create the exam** — tick *Publish straight away* if students should see it
   immediately, or leave it as a draft and publish later.

To add questions to a paper you already have, open it and use **Import
questions** instead.

`exams/` has a complete past paper ready to upload, and `sample-data/` has a
small example of each accepted format.

---

## 6. While you are developing

Use `npm run dev` instead of `npm start` — the server restarts by itself
whenever you save a file. Reload the browser to see the change; there is no
build step to wait for.

To run it under the debugger instead — so you can set breakpoints by clicking
in the gutter next to a line number — open `server.js`, press **F5**, and pick
**Node.js** when Cursor asks what to debug. It remembers the choice after that.

To wipe everything and start from a clean database:

```powershell
npm run reset-db
```

---

## 7. Working with Cursor's AI on this project

The repository ships with `.cursor/rules/project.mdc`, which Cursor loads into
every AI request automatically. It tells the assistant the architecture, the
template syntax, the marking rules and — most importantly — that this project
has **no npm dependencies on purpose**, so it will not try to rewrite things
around Express or add packages.

You do not have to do anything to switch it on. Two things are worth knowing:

- **Ctrl + L** opens chat about the whole project. Good for "where is the
  marking logic?" or "add a question category field".
- **Ctrl + K** edits the code you have selected, in place. Good for small,
  local changes.

If the assistant ever suggests `npm install <something>`, that is the one
suggestion to push back on — point it at `.cursor/rules/project.mdc`.

---

## 8. Optional: put it under version control

```powershell
git init
git add .
git commit -m "Revision Engine: initial commit"
```

`.gitignore` already excludes `data/` (your database), `.env` and
`node_modules/`, so your students' results and any secrets stay out of the
repository.

---

## If something does not work

**`node` is not recognised** — Node is not installed, or Cursor was open
before you installed it. Install from nodejs.org, then restart Cursor.

**"This application needs the built-in SQLite module"** — your Node is older
than 22.5. Check with `node --version` and upgrade.

**`npm` is not recognised** — npm ships with Node; the same fix applies.

**"Port 3000 is already in use"** — something else is on that port. Start it
elsewhere:

```powershell
$env:PORT=3001; npm start
```

**The page will not load** — check the terminal is still showing "Revision
Engine is running". If it has stopped or shown an error, the message there
says what went wrong.

**A new page gives "404 — We could not find that page", or a change has not
appeared** — the running server is out of date. Pages and styles are re-read
from disk on every request, but the list of addresses the server answers on is
fixed when it starts, so new pages only appear after a restart. Press
**Ctrl + C** in the terminal and run `npm start` again. The startup message
prints the time it started and how many addresses it knows about, so you can
tell at a glance whether it is current.

Use `npm run dev` instead of `npm start` while you are changing things and it
restarts itself every time a file is saved, which avoids this entirely.

**You forgot the administrator password** — `npm run reset-db` clears
everything and seeds a fresh administrator. To choose your own credentials
instead, copy `.env.example` to `.env`, set `ADMIN_EMAIL` and
`ADMIN_PASSWORD`, then run `npm run reset-db`.

---

## Putting it on a server later

`README.md` covers deployment: an nginx reverse-proxy block, a systemd service
file, the HTTPS cookie setting, and what to back up. The whole system is one
SQLite file in `data/`, so backing that file up is your backup.
