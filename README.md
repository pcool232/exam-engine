# Revision Engine

Load past examination papers, publish them as online practice exams, and let
students sit them and get marked instantly — in the style of TestKing or an
exam-dump trainer, but running on your own server with your own papers.

- **Students** register, sign in, pick a paper, answer multiple-choice
  questions under a timer, submit, and immediately see their mark, a
  pass/fail verdict, and a question-by-question review with explanations.
- **Administrators** create exams and load questions in bulk — by pasting the
  text of a past paper, or uploading a Word, PDF, CSV or JSON file — then
  publish the paper and track how everyone is doing.

## What is in the box

| Area | What it does |
| --- | --- |
| Accounts | Self-registration, sign-in, password changes, student/administrator roles |
| Exam runner | Timed papers, shuffled questions and options, answers saved as you click, safe to refresh |
| Marking | Automatic, instant; single-answer and multiple-answer questions; per-question marks; configurable pass mark |
| Review | Correct answers, your answers, and explanations after submission (can be switched off per exam) |
| Importing | Pasted past-paper text, Word (.docx), PDF, CSV, JSON — with a review screen before anything is saved |
| Question bank | Draw a random subset of N questions per attempt, so every sitting differs |
| Admin reporting | Results table, CSV export, per-question success rates to spot bad questions |

## Requirements

**Node.js 22.5 or newer.** That is the only requirement. The app uses Node's
built-in SQLite, so there are **no npm dependencies to install** and nothing to
compile — which also means no `node-gyp` build errors on your server.

Check your version with `node --version`. If it is older, install a current
release from <https://nodejs.org>.

## Getting started

```bash
cd revision-engine

# 1. Create the database and the first administrator account
npm run seed

# 2. Start the server
npm start
```

Then open <http://localhost:3000>.

The seed step prints the administrator sign-in details:

```
email:    admin@revision.local
password: ChangeMe123!
```

**Change that password immediately** — sign in, open *My account*, and set a new
one. You can also set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in a `.env` file before
running `npm run seed` to choose your own from the start.

Seeding also creates a small sample paper so you can try the whole flow right
away. Delete it from *Exams* once you have your own.

## Loading a past paper

There are two ways in.

**A prepared file becomes a whole paper in one step:**

1. **Exams → Import an exam file.** Choose a `.json`, `.csv`, `.docx`, `.pdf`
   or `.txt` file, or paste the questions into the box below the file picker.
2. **Review.** Every question that was read is shown with its correct answer
   marked; anything the parser could not make sense of is listed separately and
   skipped. A JSON file can also carry the exam's title, time limit and pass
   mark, and those arrive already filled in for you to check.
3. **Create the exam.** Tick *Publish straight away* if students should see it
   at once, or leave it as a draft.

**Or build a paper up by hand:** **Exams → New empty exam**, then **Import
questions** to add a batch, or **Add one question** at a time. Publish when
the questions are ready.

Nothing is written to the database until you confirm on the review screen.

### Pasting past-paper text

This is the format most past papers and exam dumps already use:

```
1. Which organelle produces most of a cell's ATP?
A. Nucleus
B. Mitochondrion
C. Ribosome
D. Golgi apparatus
Answer: B
Explanation: Mitochondria carry out aerobic respiration.

Question 2
Which TWO of these are components of blood? (Choose two)
A) Plasma
B) Chlorophyll
C) Platelets
D) Keratin
Correct Answers: A, C
```

The parser is deliberately forgiving:

- Questions may be numbered `1.`, `1)`, `Q1`, `#1` or `Question 1`.
- Options may be written `A.`, `A)`, `(A)` or `A -`, using letters A to J.
- The answer line may say `Answer:`, `Ans:`, `Correct Answer:`, `Key:` or
  `Solution:`, and may list several (`A, C` / `AC` / `A and C`).
- The answer may instead be the full text of an option.
- A leading `*` marks the correct option, so no answer line is needed:
  `*B. Mitochondrion`
- `Explanation:`, `Rationale:` or `Reason:` adds an explanation.
- "(Choose two)" or more than one correct answer makes it a multiple-answer
  question automatically.
- Question text and option text may wrap across several lines.

One limitation worth knowing: **options must be lettered A–J.** If your paper
numbers its options 1, 2, 3, replace those with letters first — otherwise they
look like new questions.

### CSV

```csv
question,option_a,option_b,option_c,option_d,correct,explanation,marks
What is 7 x 8?,54,56,48,64,B,Seven eights are fifty-six,1
Which are mammals?,Whale,Shark,Bat,Trout,"A,C",Mammals nurse their young,2
```

A header row is required. Recognised columns: `question`, `option_a` … `option_j`
(or `option1`, `option2`, …), `correct` (also `answer` or `key`), `explanation`,
`type`, `marks`. The answer cell accepts `B`, `A,C`, `AC`, or the full text of an
option.

### JSON

```json
[
  {
    "question": "What is 2 + 2?",
    "options": ["3", "4", "5"],
    "correct": "B",
    "explanation": "Basic addition",
    "marks": 1
  }
]
```

Options may also be objects — `{"text": "4", "correct": true}` — and `correct`
accepts a letter, a zero-based index, the full option text, or an array of those.

A JSON file may also describe the exam itself, so that one upload creates the
paper and its questions together:

```json
{
  "exam": {
    "title": "Design and Technology Paper 1",
    "code": "17/1",
    "subject": "Design and Technology",
    "year": "October/November 2018",
    "description": "Answer all 40 questions.",
    "durationMinutes": 60,
    "passMark": 50,
    "questionsPerAttempt": 0,
    "shuffleQuestions": false,
    "shuffleOptions": false,
    "showAnswers": true
  },
  "questions": [ ... ]
}
```

Every field is optional and every value can be changed on the review screen
before the exam is created. `"exam"` may also be a plain string, in which case
it is taken as the title.

### Questions with a diagram

Add an `image` to a question (JSON) or an `image` column (CSV) to show a picture
above the options, in both the exam and the answer review:

```json
{
  "question": "Which of the following is a back saw?",
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRg…",
  "options": ["Shown at A", "Shown at B", "Shown at C", "Shown at D"],
  "correct": "C"
}
```

The value can be a `data:` URI (self-contained — the file carries its own
pictures), a path to a file you put in `public/`, or an `https://` URL.

When the *options themselves* are pictures, embed the whole lettered figure in
the question and word the options "Shown at A", "Shown at B" and so on — then
**turn off option shuffling for that exam**, or the letters will no longer match
the picture.

`exams/` holds a complete worked example: a 40-question past paper with 18
diagrams, in a single JSON file.

### Word and PDF

The text is extracted from the document and then read exactly like pasted
past-paper text, so the same layout rules apply. Review the preview carefully:
PDFs vary enormously, and a **scanned** PDF holds pictures rather than text, so
nothing can be extracted from it. For those, copy the text out yourself (or run
it through OCR first) and paste it instead.

Working examples of all three text formats are in `sample-data/`.

## Exam settings

| Setting | Effect |
| --- | --- |
| Time limit | Minutes. `0` means untimed. When the clock runs out the paper is submitted and marked automatically. |
| Pass mark | The percentage needed to pass. |
| Questions per attempt | `0` serves every question. A smaller number draws that many at random from the bank, so repeat attempts differ. |
| Shuffle questions / options | Order is randomised once per attempt and then frozen, so refreshing never reshuffles a paper mid-exam. |
| Show answers | Whether students see correct answers and explanations after submitting. |
| Publish | Students only see published papers. |

### How marking works

Each question is worth its `marks` value (1 by default). A question is correct
when the selection matches the correct set **exactly** — so on a multiple-answer
question, picking one of two correct options, or both correct ones plus a wrong
one, scores zero. There is no negative marking.

## Deployment

Any machine that runs Node 22.5+ will do — a VPS, a Raspberry Pi, Render,
Railway, Fly.io, or a PC on the school network.

```bash
cp .env.example .env     # then edit it
NODE_ENV=production npm start
```

Points worth attending to:

1. **Put it behind HTTPS.** Terminate TLS at nginx, Caddy, or your host's load
   balancer, then set `COOKIE_SECURE=true` in `.env` so session cookies are only
   sent over HTTPS.
2. **Keep it running.** Use a process manager so it restarts on reboot or crash:

   ```bash
   # systemd example: /etc/systemd/system/revision-engine.service
   [Unit]
   Description=Revision Engine
   After=network.target

   [Service]
   Type=simple
   User=www-data
   WorkingDirectory=/opt/revision-engine
   Environment=NODE_ENV=production
   ExecStart=/usr/bin/node server.js
   Restart=always

   [Install]
   WantedBy=multi-user.target
   ```

3. **Back up `data/revision-engine.db`.** That single file holds every account,
   question and result. Copy it somewhere safe on a schedule. (Copy the
   `-wal` and `-shm` files alongside it, or stop the server first.)
4. **Set `ALLOW_REGISTRATION=false`** if you would rather create student accounts
   yourself from *Students* than let anyone sign up.

An nginx reverse-proxy block:

```nginx
server {
    server_name exams.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Configuration

Every setting is optional; copy `.env.example` to `.env` and change what you need.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `NODE_ENV` | `development` | Set to `production` on a server (enables template caching) |
| `DATABASE_FILE` | `data/revision-engine.db` | Where the SQLite file lives |
| `APP_NAME` | `Revision Engine` | Name shown in the header |
| `SESSION_TTL_HOURS` | `12` | How long a sign-in lasts |
| `COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS |
| `ALLOW_REGISTRATION` | `true` | Set `false` to switch off self-registration |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | Used by `npm run seed` only |

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run with auto-restart on file changes |
| `npm run seed` | Create the administrator (and sample exam) if missing |
| `npm run reset-db` | **Delete everything** and start from a clean database |

## How it is put together

```
server.js              start-up, middleware pipeline, routes, error pages
src/
  config.js            environment configuration (.env loader)
  db.js                SQLite connection and schema
  seed.js              first administrator + sample exam
  core/                a small web framework built on node:http
    app.js             routing, middleware, response helpers
    body.js            form, JSON and multipart/file-upload parsing
    session.js         SQLite-backed sessions and CSRF tokens
    static.js          static file serving
    template.js        the HTML template engine
  lib/
    password.js        scrypt password hashing
    parsers/           text, CSV, JSON, DOCX and PDF question importers
  middleware/auth.js   sign-in state, role checks, CSRF verification, flash messages
  models/              users, exams/questions, attempts and marking
  routes/              auth, student and admin request handlers
views/                 HTML templates
public/                stylesheet and the exam-runner script
sample-data/           example import files in all three text formats
```

There is no build step and no bundler: edit a template or the stylesheet, reload
the page, and the change is there.

### Security notes

- Passwords are hashed with scrypt and a per-user random salt; they are never
  stored or logged in plain text.
- Sessions are server-side. The cookie carries only a 256-bit random identifier,
  is `HttpOnly` and `SameSite=Lax`, and a fresh identifier is issued on sign-in.
- Every state-changing form carries a CSRF token that is verified server-side.
- All database access uses prepared statements.
- Every value rendered into a page is HTML-escaped by default.
- Students can only read their own results; the admin area is role-checked on
  every request.

For anything beyond coursework practice, also put the site behind HTTPS and keep
Node.js up to date.

## Ideas for later

The pieces are in place to extend this: question categories and topic-level
feedback, essay or short-answer questions marked by hand, images in questions,
certificates on passing, emailed results, or a class/cohort grouping so a
lecturer sees only their own students.
#   e x a m - e n g i n e  
 