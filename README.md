# DockMaster — AI-first e-signature

Upload a PDF. AI proposes **who signs, what each person fills in, and where each field goes**. You review and
correct the proposal on one screen, send it, and each signer completes their fields from a link. When everyone has
signed, the signed PDF is ready to download.

## Run it

**Production (one container, one URL):**
```bash
docker build -t dockmaster .
docker run -p 8000:8000 -v dockmaster_data:/data --env-file .env dockmaster   # .env holds ANTHROPIC_API_KEY
```
Open http://localhost:8000. The SQLite database, uploads, page images and signed PDFs live on the `/data` volume.

**Development (two terminals):**
```bash
uv sync && uv run nodeenv -p --node=lts          # first time: Python deps, plus Node inside .venv
cd frontend && uv run npm install && cd ..       # first time: frontend deps
uv run uvicorn app.api:app --app-dir backend --reload     # API on :8000
cd frontend && uv run npm run dev                         # app on :5173 (proxies /api to :8000)
```
The dev server also listens on your network, so you can test on a phone at `http://<your computer's IP>:5173`.

**Walk the whole journey without email:** sign up → upload (from the **Inbox**) → review → Send → open **Outbox** → click a blue
"Open signing page as this recipient" button → sign → repeat for each signer → download from the document's Status page.

## What works
- **Upload any PDF:** digital, scanned, rotated, or with mixed page sizes (Letter, A4, Legal, landscape).
- **AI proposal:**
  - the parties, and one signer per signature block (optional signers such as "Guarantor (if applicable)" are marked);
  - every field's type (signature / initials / date / text / checkbox / radio) and owner, with radio options grouped into
    choices ("pick one");
  - every field belongs to a participant; blanks about the agreement itself (party names, dates, amounts) go to
    Needs review when the owner is unclear;
  - blanks that are **not** fields (table borders, underlined headings), each with a reason;
  - fields it expected but couldn't find.
- **Review screen:**
  - collapsible sections for **Needs review** (low confidence, guessed position, or no signer), one per signer, and **Not a field**;
  - a sticky drop bar: drag a card onto a destination chip (or use "Move to…"), and move or resize boxes on the page;
  - add fields, add or remove signers;
  - optionally **pre-fill** any non-signature field for any participant (shown on the page as you type); it's locked
    for them, and whatever you leave blank they fill in;
  - **Reset to AI suggestions** undoes your field and assignment changes (keeps signer names and emails);
  - clicking a card finds its box, and clicking a box finds its card;
  - autosave;
  - a send checklist (hard rules block Send; Needs review can be overridden with "Send anyway").
- **Signing:**
  - no account needed;
  - only your own fields are active, with "Next field";
  - type your name straight into the signature box (shown in a script font), or draw it;
  - pre-filled fields are shown locked; the signer completes only the blank ones;
  - dates are prefilled;
  - radio choices allow exactly one option, and Finish waits until each required choice is answered.
- **Ask about the document:** the sender (in Review) and each signer (on their signing page) can ask questions. Answers come only from the document, with clickable page references. They aren't legal advice, and the conversation isn't stored.
- **Completion:** signatures and values are stamped into the PDF; status and outbox notifications are kept; the signed PDF downloads.
- **Outbox:** fix a recipient's email and resend their link (a corrected address gets a new link and the old one stops
  working), or just send a reminder.
- **Inbox:** every document with its status and "1 of 2 signed"; delete a document (with confirmation; signing links for sent documents stop working).
- **Failures stay visible:**
  - if the AI step fails, you still get a draft with every detected blank to assign by hand;
  - damaged or encrypted files get a plain message;
  - every loading and error state has text.

## What's faked
- **Email:** nothing is sent. Every notification goes to the in-app **Outbox**, with working signing links.
- **Auth:** basic email + password with a session cookie (no password reset, no hardening).
- **Signatures:** images stamped onto the PDF. No digital certificates, audit trail or legal-compliance features.

## What's cut (details and reasons in [DECISIONS.md](DECISIONS.md))
- An OCR engine: scanned pages are read by Claude from the page images instead.
- Splitting long documents across several AI calls (one call handles 18+ pages).
- Word field codes such as `FORMCHECKBOX` that leaked into the PDF as text with nothing drawn: there's no geometry to place them on.
- Label-only blanks on scanned pages (e.g. "Date:" with no line).
- A UI for signing order (the backend supports order groups).

## How the AI layer works
**Libraries decide WHERE. Claude decides WHAT and WHO.** Claude never outputs coordinates.
1. **`extract.py`:** PyMuPDF and OpenCV find every *candidate* blank (typed underscores, drawn lines, existing form
   widgets, checkboxes, round radio markers, lines in scanned images, and spots after labels like "Date:"). It records nearby labels, the
   heading in the same column, the line's text, and whether a line looks like a table border.
2. **`propose.py`:** one Claude call (`claude-sonnet-5-5`) with:
   - all the page text;
   - a compact candidate list;
   - page images with each candidate drawn as a red box and its ID (this is how scans work without OCR).

   A Pydantic schema enforces the output: parties, signers, and a classification for every candidate ID (type, owner,
   sender/signer, confidence, reason) or a rejection. Code then validates it: unknown IDs are dropped, and any
   candidate Claude skipped becomes an unassigned field with a warning.
3. **`place.py`:** maps candidate IDs back to their exact boxes and sizes them by type. Fields below 0.7 confidence,
   or with a guessed position, go to Needs review.

**Accuracy** (`backend/scripts/score.py`, 4 hand-labelled documents, 69 fields):

| | End-to-end | Cost (4 docs) | Wrong at ≥0.8 confidence |
|---|---|---|---|
| Sonnet 5.5 (used) | 94% | $0.23 | 0 |
| Haiku 4.5 | 77% | $0.10 | 13 |

Haiku was rejected for being overconfident. The test PDFs and labels are personal documents, so they aren't in this repo.

**Cost per document:** about **$0.03–0.05** for a 3–4 page agreement and **about $0.10** for an 18-page lease. Each
call takes 8–22 seconds. Every call's tokens and cost are logged to `backend/out/llm_calls.jsonl`.

## Repo map
`backend/app/pipeline/` (extract, propose, place, stamp) · `backend/app/api.py`, `auth.py`, `models.py`, `outbox.py` ·
`backend/scripts/` (`test_pdf.py`, `run_pipeline.py`, `score.py`, `e2e_journey.py`) · `frontend/src/` (`api.ts` is the
only module that calls the backend; all point↔pixel math is in `geometry.ts`) · [CLAUDE.md](CLAUDE.md) (spec and
current status) · [DECISIONS.md](DECISIONS.md) · [TECH_STACK.md](TECH_STACK.md) · [AI_TOOLING_NOTES.md](AI_TOOLING_NOTES.md)

## Licensing
PyMuPDF is AGPL-3.0, which is fine for this project. A commercial product would need Artifex's commercial license.
All other dependencies are MIT, BSD or Apache-2.0 (see [TECH_STACK.md](TECH_STACK.md)).
