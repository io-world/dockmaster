# DockMaster — AI-first e-signature (practical project)

## What this is
A working e-signature product where **AI does the setup work**. The sender uploads a PDF; the system
proposes who signs, what each signer fills in, and where each field goes. The sender reviews and
corrects the proposal instead of building it from scratch.

**The bar:** if you remove the AI, the product should be visibly worse. No form builder with an AI button.

- Due: **Sun 4 Oct 2026, 11:59pm**. Live test: **Mon 5 Oct** — the CEO uploads a PDF we have never seen.
- Build for the general case. Never tune to specific test PDFs.
- Effort cap: 10–15 hours. Prefer six things working over eleven half-built.

## Current status (handoff — updated 2026-10-04, session 3)
Read this first. Detailed reasoning for every choice is in `DECISIONS.md`; libraries in `TECH_STACK.md`.

**Done and verified**
- Pipeline: extract → propose → place → stamp. Handles rotated, scanned (via marked images; no OCR engine) and mixed page sizes.
- Backend API (`backend/app/api.py`, see the API section below), auth, outbox, stamping, AI-failure fallback.
- Frontend steps 1–6 (auth, envelopes, review board with DnD/boxes/add field/autosave/checklist/send, signing,
  status, outbox).
- Session 2 (2026-10-03): nav "Envelopes" renamed to "Inbox"; delete documents from the Inbox (with confirmation).
  Review board is now vertical collapsible sections + a sticky drop bar (chips), with auto-scroll off and a "Move to…"
  menu on cards. Thin-box resize-handle bug fixed. Full journey re-verified.
  Warnings banner replaced by an expandable/minimisable "AI summary" panel (summary + notes; never dismissed).
  AI notes now refer to pages/labels instead of candidate IDs.
  Ask-the-document chat for the sender (Review panel) and signers (signing page); page links; prompt-cached; history not stored.
  Session 3 (2026-10-03): live "You fill" value preview on the page (superseded 10-04: no sender role; optional locked pre-fill per field); "Reset to AI suggestions" (`ai_draft` snapshot);
  radio buttons end to end (extract `src=radio`, AI `group`, `field.group_id` column via a tiny migration in `db.py`).
- Session 3 (2026-10-04):
  - No sender role: every field belongs to a participant; the sender may pre-fill any non-signature field in Review
    (shown live on the page), and pre-filled values are locked for that participant (read-only, kept by the server).
  - Signing: clicking a signature/initials box opens the dialog on "Type your name", pre-filled from the signer's own
    "Name" field or the sender-entered name; Apply scales the image to fit the box. The signed-in sender gets
    "← Back to Outbox" / "View document status" after signing.
  - Outbox: "Edit email / Resend" (a changed email rotates the token).
  - Review: radio/checkbox groups added in one go ("How many options?"), moved and resized as one dashed frame that
    re-spaces the markers (row when wide, column when tall); radio choices have editable names.
  - Bug fix: page images could show a deleted document's pages (SQLite reuses ids; no cache headers). Now `?v=` per
    upload plus `Cache-Control: no-cache`.
  - Docker removed: production is `npm run build` + one uvicorn process. `tests/` holds requirements and test cases (JSON).
  - `SUBMISSION_README.md` (one page, for the CEO) is local only and gitignored.
- Step 7: full journey passes end to end (`backend/scripts/e2e_journey.py`).
- `score.py`: Sonnet 94% end-to-end on 4 labelled docs. Haiku rejected (77%, overconfident).
- README.md and AI_TOOLING_NOTES.md drafted.
- Public repo https://github.com/io-world/dockmaster: clean history (old commit purged by deleting and recreating the
  repo on 2026-10-02), all docs committed. Repo-local git author is set to the io-world noreply address.

**Open items (in priority order)**
1. **Deploy:** self-hosted on the owner's machine (port 80 → :8000), production mode (built frontend + uvicorn, no
   `--reload`). No Docker (removed 2026-10-04).
2. **Unseen-PDF drill:** someone else picks documents and uses the app cold. Fix what breaks.
3. **AI_TOOLING_NOTES.md:** the user adds their own reflections (marked "To finish (owner)").
4. **5-minute recording.** Feature freeze was Sunday 4 Oct midday; anything new now is a bug fix.
5. Nice-to-haves if time allows: more varied labelled test PDFs (offer letter, 3-party agreement, existing form fields).

**Known gaps (accepted, logged in DECISIONS):** radio detection on scans is image-only (no OpenCV circle finder); `FORMCHECKBOX` field-code checkboxes are
undetectable; label-only blanks on scans; the AI varies between runs on the lease (landlord alternative blocks);
two PDFs with the same filename share an output folder in the test scripts.

**Privacy rules (user's explicit requirement):**
- Never commit or publish `backend/test_pdfs/*.pdf`, `*.labels.json`, `*.docx` or `.env` (all gitignored).
- Never name the user, their employer or the personal document types in committed files.
- Re-audit a fresh clone of GitHub before and after every push.

**How to resume:** start the backend and frontend (Running section at the end of this file). For UI checks,
Playwright with Chromium is in `.venv` (`PLAYWRIGHT_BROWSERS_PATH=.venv/playwright-browsers`). Run automated UI tests
on other ports (backend :8001, frontend :5174 with `DOCKMASTER_API`) so they never touch the user's running servers
or `backend/data`.

## Scoring (guides every tradeoff)
| Weight | Criterion |
|---|---|
| 30% | AI genuinely does the work on an unseen document |
| 25% | Whole journey works cold in someone else's hands (upload → review → send → sign → notify) |
| 20% | Scoping judgment — log every cut in `DECISIONS.md` |
| 15% | Handles being wrong: errors visible and cheap to fix, no unearned confidence |
| 10% | Product instinct — small decisions, make mistakes impossible |

Not scored: visual polish, tests/CI, security hardening, legal compliance, scale.

## Core principle
**PyMuPDF decides WHERE. Claude decides WHAT and WHO.**
- Libraries produce exact geometry (candidate blanks + labels).
- Claude classifies candidates (type, owner, confidence, reason). Claude **never outputs coordinates**.
- Code maps candidate IDs back to bboxes.

## Stack
- Python + **uv only** (no conda, no pip install outside uv). FastAPI. SQLite + SQLModel.
- PyMuPDF (AGPL — fine for this project; note commercial licensing in README).
- Scans: no OCR engine. `opencv-python-headless` finds lines; Claude reads labels from page images on which every candidate is drawn as a red box + ID. PyMuPDF `get_textpage_ocr()` is used only if Tesseract happens to be installed (optional).
- LLM: Anthropic API. Start with `claude-sonnet-5-5`; evaluate `claude-haiku-4-5-20251001` on the labeled test set for cost.
- Frontend: React + Vite + TypeScript + Tailwind (decided and built). `@dnd-kit/core` for drag between columns, `react-rnd` for box move/resize, `signature_pad` for signatures. No router library or state library.
- Deploy: one process. `npm run build` makes `frontend/dist`; uvicorn serves the API and those files on one URL. Data in `backend/data/`.

## Repo layout
```
backend/
  app/
    pipeline/
      extract.py    # PDF -> candidates + labels + page images
      propose.py    # candidates + page images -> Claude -> assignments
      place.py      # candidate_id -> bbox; label_offset fallback
      stamp.py      # write values/signatures into final PDF
    models.py       # SQLModel tables
    api.py          # FastAPI routes
    outbox.py       # notification log (no real email)
  scripts/
    run_pipeline.py # CLI: run pipeline on a PDF, print JSON
    score.py        # compare output to labeled ground truth
  test_pdfs/        # real-world docs + *.labels.json ground truth
frontend/
tests/              # testing requirements + plain-English test cases (JSON)
DECISIONS.md        # every scope decision + cut, with reasoning and timestamp
TECH_STACK.md       # libraries/services/tools used: version, purpose, GitHub repo, license
AI_TOOLING_NOTES.md # what AI tools did, where I took over, what they got wrong
README.md           # one page: works / faked / cut / how AI layer works / cost per doc
```

## Pipeline

### 1. extract.py — candidates (no AI)
Per page:
- **Text layer check.** If no text → try `get_textpage_ocr()` (optional Tesseract); otherwise the page is marked scanned and Claude reads it from the marked image.
- **Typed underscores:** `page.get_text("words")`, regex `_{3,}` inside each word (label and underscores may arrive as one word); estimate sub-bbox by char width; merge adjacent runs on the same row.
- **Drawn lines:** `page.get_drawings()` → items `"l"` that are horizontal (|dy| < 1) **and** items `"re"` with height < 2 (Word exports underlines as thin rects).
- **Scanned pages:** render, threshold, morphological open with a wide horizontal kernel (~40x1) in OpenCV.
- **Existing widgets:** `page.widgets()` — take as-is, highest placement trust.
- **Filter:** drop length < ~40pt, width > ~85% of page, lines with text on top, duplicates (underscore + line overlap).
- **Labels:** for each candidate, nearest words to the left on the same row, directly below, and nearest heading-like text above.
- **Label-only blanks:** labels like "Date:" / "Signature:" with no nearby line → emit a candidate with `placement: label_offset`.
- Output numbered candidates: `c7: page 3, bbox, src, left_label, below_label, heading`.
- Render page PNGs (`get_pixmap(dpi=...)`) for UI and for Claude.

### 2. propose.py — Claude
- Input: candidate list, page text in reading order (consider `pymupdf4llm`), page images.
- **Classification, not generation:** Claude assigns each candidate a type + signer, or marks it `not_a_field` with a reason. Only `label_offset` candidates are speculative.
- Use tool use / JSON schema for enforced structured output.
- Long documents: chunk by page, then reconcile parties across chunks.
- Log input/output tokens, cost, duration for every call.

### 3. place.py
- Map `candidate_id` → bbox. Size fields by type (signature taller than text).
- `label_offset` fields get placed just after the label and are flagged in the UI regardless of confidence.

### 4. stamp.py
- Insert signature images and text values at field bboxes, then save the completed PDF.

## Coordinates (common source of bugs)
- Store everything in **PyMuPDF space: points (1/72 in), origin top-left.** (Raw PDF is bottom-left; PyMuPDF normalizes.)
- The frontend converts with one scale factor: `rendered_px / page_width_pts`. No other coordinate system on the server.

## Proposal JSON (what `POST /envelopes` returns)
```json
{
  "document": {"doc_type": "Mutual NDA",
    "pages": [{"n": 1, "width": 612, "height": 792, "image": "/pages/1.png", "text_layer": true}]},
  "parties": [{"id": "p1", "name": "Acme Corp", "role": "Disclosing Party", "evidence": "page 1, preamble"}],
  "signers": [{"id": "s1", "party_id": "p1", "label": "Signer for Acme Corp",
    "name": null, "email": null, "is_self": false, "order": 1}],
  "fields": [{"id": "f1", "signer_id": "s1", "type": "signature", "label": "By:",
    "page": 3, "bbox": [72, 540, 288, 556], "required": true,
    "candidate_id": "c7", "placement": "line",
    "confidence": 0.93, "reason": "Under 'DISCLOSING PARTY' heading, labeled 'By:'",
    "source": "ai"}],
  "rejected_candidates": [{"candidate_id": "c9", "reason": "table border"}],
  "warnings": ["Receiving Party name is blank in the document"],
  "meta": {"model": "", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "duration_ms": 0}
}
```
- `type`: `signature | initials | text | date | checkbox | radio`. Each radio option is its own field with a shared `group_id`.
- `placement`: `widget | line | underscore | label_offset`.
- `source` flips to `user` when the sender adds or edits a field (correction data).
- Fields reference signers **by ID only**, never by name.

## Data model
- **User:** email, password_hash
- **Envelope:** owner, pdf_path, page sizes, status (`draft → sent → completed`), proposal JSON
- **Party:** name, role, source
- **Signer:** party_id, name, email, is_self, order, signing token, status
- **Field:** as in the JSON above, plus `value`
- **OutboxEmail:** to, subject, body, event (`sent | your_turn | signed | completed`), link, created_at

## API (as built: `backend/app/api.py`, `auth.py`; this is the source of truth)
All routes are under `/api`. Session cookie `dm_session` (httpOnly). Signing routes need no login: the token is the credential.
```
POST /api/auth/signup | /login | /logout        GET /api/auth/me
GET  /api/envelopes                             list: filename, created_at, status, signed_count/signer_count
POST /api/envelopes                             multipart PDF → pipeline (sync) → draft detail
GET  /api/envelopes/{id}                        detail: pages(image_url), parties, signers, fields, rejected
                                                (with page/bbox/label), missing_fields, warnings, ai{ok,model,cost}
GET  /api/envelopes/{id}/pages/{n}.png
DELETE /api/envelopes/{id}                      delete in any state (rows, outbox entries, files); signing links die
PUT  /api/envelopes/{id}                        {signers, fields, rejected}: bulk replace (draft only)
POST /api/envelopes/{id}/send                   400 {problems:[...]} or {status, self_sign_token}
GET  /api/envelopes/{id}/status                 signers (status, signed_at), outbox, final_pdf_url
GET  /api/envelopes/{id}/final.pdf
GET  /api/sign/{token}                          envelope, signer, can_sign, pages, fields (mine), others, prefilled
GET  /api/sign/{token}/pages/{n}.png            POST /api/sign/{token} {values:{field_id: value}}
GET  /api/sign/{token}/final.pdf                GET /api/outbox (+ can_resend, link_replaced)
POST /api/outbox/{id}/resend {email}            resend a "your turn" link; a changed email rotates the token
POST /api/envelopes/{id}/ask  |  POST /api/sign/{token}/ask   {question, history} -> {answer, meta}; doc-grounded Q&A, no storage
```
Field values: text/date as text; checkbox/radio "true"/"false" (one "true" per radio group); signature/initials as a PNG data URL (transparent background).
Field types: signature | initials | date | text | checkbox | radio (options share `group_id`; one owner per group; checkboxes
added as a group share one for layout only). Every field belongs to a signer (`filled_by` is always "signer"; older
"sender" fields count as unassigned). The sender may pre-fill non-signature fields in Review; they are locked when signing.
Run the pipeline synchronously in the request (spinner in UI). No background job queue.
PyMuPDF is not thread-safe: never share a document across threads.

## User workflow
1. Sender signs in, uploads a PDF.
2. Review: page images with field boxes, plus a parties/signers panel. Low-confidence and `label_offset` fields shown first, each with its reason.
3. In the same panel: name + email per signer, "this is me" toggle.
4. Send — **blocked** until every field has a signer and every signer has an email.
5. Signers open their link (**no account required**), fill only their fields, submit.
6. Every field belongs to a signer. In Review the sender may pre-fill any non-signature field (locked for that
   signer); blanks are completed by the signer. If the sender is a signer ("This is me"), they sign right after Send.
7. All signed → stamp final PDF → "completed" outbox entry to everyone → download.

Outbox entries are clickable and contain the real signing link (no real email delivery).

## Build order
1. `extract.py` + `run_pipeline.py` on 8–10 real PDFs (mutual NDA, one-way NDA, 3-party agreement, lease, offer letter, waiver, Word-exported contract, a scanned page, a PDF with existing form fields). Eyeball the candidates.
2. `propose.py` + `place.py`. Hand-label test PDFs, run `score.py`, record accuracy.
3. Models + API. Confirm files survive a restart.
4. Signing flow + `stamp.py` + outbox.
5. Frontend review and signing screens.
6. Unseen-PDF drill: someone else picks documents and uses it cold. Fix what breaks.
7. README + 5-minute recording. Stop adding features by Sunday midday.

## Working rules for Claude Code
- Read this file before starting any task. Keep changes small and runnable.
- Never hard-code anything specific to a test PDF.
- When a scope decision is made, append it to `DECISIONS.md` (date, decision, reason).
- When a library, service or tool is added (or a planned one starts being used), update `TECH_STACK.md` (version, purpose, where in the code, GitHub repo, license).
- Log token usage and cost on every Claude API call.
- Prefer simple: SQLite, sync requests, one process. Ask before adding infrastructure.
- Secrets via environment variables (`ANTHROPIC_API_KEY`, loaded from the gitignored `.env`); never commit them.

## Running
- Frontend dev (second terminal): `cd frontend && uv run npm run dev` → http://localhost:5173 (proxies `/api` to :8000).
  Vite listens on the LAN too (`server.host: true`): open `http://<this Mac's IP>:5173` or `http://<name>.local:5173` from a phone. The backend can stay on localhost.
  First time: `cd frontend && uv run npm install`. Node lives in `.venv` (nodeenv); always run npm through `uv run`.
- Production: `cd frontend && uv run npm run build && cd .. && uv run uvicorn app.api:app --app-dir backend --host 0.0.0.0 --port 8000`
  (no `--reload`; serves the API and `frontend/dist` on :8000).
- End-to-end check: `PLAYWRIGHT_BROWSERS_PATH=.venv/playwright-browsers uv run python backend/scripts/e2e_journey.py <url> <pdf> <outdir>` (empty data folder: set `DATA_DIR`; one AI call).
- `uv run uvicorn app.api:app --app-dir backend --reload` — API on :8000 (data in `backend/data/`, or `DATA_DIR`).
- `uv run python backend/scripts/run_pipeline.py <pdf> [--out DIR] [--overlay] [--no-ai]` — run pipeline, print JSON.
- `uv run python backend/scripts/test_pdf.py <pdf-or-folder> [...] [--no-ai]` — run on any PDFs on disk; writes
  source copy, page PNGs, extract.json, proposal.json, summary.json and box overlays to `backend/out/<pdf name>/`.
- `uv run python backend/scripts/score.py [--run] [--model M] [-v]` — score proposals against `backend/test_pdfs/*.labels.json`
  (recall, precision, type/owner accuracy, end-to-end, confidence calibration). `--draft <pdf>` writes a labels draft to correct by hand.
