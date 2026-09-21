# Ready-made exam files

Drop-in import files for the admin area. To load one:

**Exams → Import an exam file** → **Choose a file** → pick the `.json` →
**Read the questions** → check the settings on the review screen →
**Create the exam**.

That is the whole job. These files carry their own title, code, subject, time
limit, pass mark and shuffle settings, so the review screen arrives already
filled in; you only need to change something if you disagree with it. Tick
**Publish straight away** on that screen if you want students to see it at once,
or leave it as a draft and publish later.

---

## bec-jc-design-technology-2018-p1.json

**Botswana Examinations Council — Junior Certificate Examination
Design and Technology, Paper 1 (17/1), October/November 2018**
40 questions · 40 marks · 1 hour

Transcribed from the scanned paper. Eighteen questions carry a diagram, cropped
from the original pages and embedded in the file, so no separate image folder is
needed — the single JSON file is everything.

The file sets these itself, so the review screen shows them already filled in:

| Setting | Value |
| --- | --- |
| Title | Design and Technology Paper 1 (17/1) |
| Exam code | 17/1 |
| Subject | Design and Technology |
| Year / sitting | October/November 2018 |
| Time limit | 60 minutes |
| Pass mark | 50% |
| Questions per attempt | 0 (use all 40) |
| Shuffle questions | **off** |
| Shuffle options | **off** — see below |

**Leave option shuffling off for this paper.** In nine questions the answers are
pictures rather than words, so the options read "Shown at A", "Shown at B" and
so on, and refer to the letters printed inside the diagram. Shuffling them would
put "Shown at C" in position A. The review screen warns you about this when it
spots those options. Question shuffling is off simply to keep the paper in its
original order.

### Answers you should check before publishing

The scanned paper carries no marking key — the pencil marks on it are a
candidate's own answers, and at least one is wrong (question 1 is marked "Mild
steel"; the base metal of all ferrous metals is iron). Every answer in this file
was therefore worked out from the subject matter, not copied from an official
key.

Twenty-two are settled by definition and safe. **The eighteen below are the ones
to check against the BEC marking key before students use this paper**, either
because the wording admits more than one reading or because the answer depends
on detail in a scanned picture:

| Q | Topic | Answer used here |
| --- | --- | --- |
| 3 | Factor when marking out | C — Ensure accuracy |
| 11 | Rotary to linear motion | A — Gate sliding on rail |
| 12 | Cam that drops part K quickly | A — the snail/drop cam |
| 15 | Not a shading technique | A — Contrasting |
| 16 | Name of the hinge | A — Concealed hinge |
| 19 | Not a characteristic of a pre-finish | C — Stain |
| 21 | Tool for the part marked T | A — Forstner bit |
| 26 | Forces on the trampoline base | B — Compression and tension |
| 27 | Statement about the sketch | D — XY divided into five equal parts |
| 29 | Chisel handle with a ferrule | C |
| 30 | Eye of a ball pein hammer | B — left soft to absorb shock |
| 31 | Correct grip for heavy filing | A |
| 32 | "construction was changed" | A — Modification |
| 34 | Reason for batteries in series | B — They release power fast |
| 35 | Correct statement about the gear train | D — Q and R rotate at the same speed |
| 37 | Drawn in perspective | B |
| 39 | Correct use of a try square | A |
| 40 | Correct plan of the block | C |

Questions 34, 35, 19 and 40 are the least certain of these.

To change one: **Exams → open the paper → Edit** on the question, tick the right
option, **Save changes**. The explanation text can be corrected in the same
place.

### Where the diagrams came from

Each figure is a crop of the scanned page, converted to greyscale JPEG at 760px
wide and embedded as a `data:` URI (about 290 KB of images in a 442 KB file).
Questions 35 and 36 share the gear-train diagram. Nothing is fetched from the
internet when a student sits the paper.
