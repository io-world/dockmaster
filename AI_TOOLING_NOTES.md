# AI tooling notes

How AI tools were used to build DockMaster: what they did, where the human took over, and what they got wrong.
Dates are 2026-10-01 to 2026-10-02.

> **To finish (owner):** the "Where I took over" section is a record of decisions made in the session. Add your own
> view of what you'd do differently and anything not captured here.

## Tools
- **Claude Code** (Claude Opus 5.5) wrote nearly all the code, scripts and docs, working step by step from the brief
  (`CLAUDE.md`) and stopping for review after each build step.
- **Claude Sonnet 5.5 (API)** is the model inside the product (`propose.py`). Haiku 4.5 was evaluated and rejected
  (DECISIONS.md).
- **Playwright (headless Chromium)** let Claude Code drive the real UI. That's how every frontend step was verified,
  using screenshots plus numeric checks such as box-position drift after a window resize.

## What the AI did
- Built the pipeline (extract → propose → place → stamp), the FastAPI backend, the React frontend, the Dockerfile,
  `score.py`, the labels drafts and `e2e_journey.py`.
- Proposed the product additions the brief didn't specify:
  - `filled_by: sender` and a "You fill" column;
  - `missing_fields`;
  - `initials` as a field type;
  - "Remove signer";
  - marked page images (in place of OCR);
  - an AI-failure fallback draft.

  The human approved each one.
- Kept DECISIONS.md and TECH_STACK.md up to date as it went.

## Where I took over (human decisions)
- Ordering: build the backend before the frontend, once it turned out the frontend spec assumed an API that didn't exist.
- The "You fill" column for sender fields; cutting radio; generating non-Letter test PDFs.
- **No OCR engine.** I questioned why OCR was needed at all, and chose Claude's vision on marked images over RapidOCR/PaddleOCR.
- **Project-local tooling.** No system-wide installs (Tesseract, Node), so Node lives in `.venv` via nodeenv.
- **Privacy.** Personal test PDFs, labels and the brief stay out of the public repo, and the commit author was scrubbed.
- Kept Sonnet over Haiku after the measured comparison.

## What the AI got wrong (and how it was caught)
| Mistake | Caught by | Fix |
|---|---|---|
| `.env` wasn't gitignored in the initial scaffold | AI, while setting up | Added to `.gitignore` before any commit |
| Rotated pages: boxes in the wrong place (PyMuPDF gives text unrotated, pages render rotated) | AI review probe | Convert with `rotation_matrix`; size and stamp in the right space |
| Two-column signature page: fields assigned to the wrong column | Overlay screenshot | Headings found per column; candidate x/y given to Claude |
| Claude made 2 tenant signers for 4 tenant blocks | Reading the AI output | Prompt rule: one signer per signature block |
| Rotated stamping wrapped text one character pair per line | Visual check of the PDF | Insert unrotated in the page's own coordinates |
| `process.env` in `vite.config.ts` broke the Docker build (built locally only before the edit) | Docker build | Added `@types/node` |
| Box tags covered document text; every unnamed signer showed as "S" | Screenshot | Compact icon + number tags |
| Signer colours shifted when a signer was removed | Screenshot | Colour derived from the signer id |
| Box click sometimes didn't select its card (react-draggable start/stop) | Playwright test | Plain `onClick` |
| Restored cards said "AI: Restored by you" | Screenshot | "AI:" prefix only on the AI's own reasons |
| First public commit: author line showed first name and Mac hostname; DECISIONS named the personal document types | Human privacy request, then an AI audit of the GitHub clone | Text scrubbed, noreply author, history rewritten (old SHA still reachable: see CLAUDE.md status) |
| Several failures in its own Playwright tests (selectors, stale coordinates) were at first suspected to be product bugs | AI debugging | Test fixes; no product change |

## Cost of building with AI
- **Product AI calls during development:** 27 logged calls, $1.26 in total, in `backend/out/llm_calls.jsonl`
  (gitignored). A few more ran inside Docker test containers and aren't in that log; roughly 6 calls, about $0.25.
- **Claude Code usage:** not tracked here.
