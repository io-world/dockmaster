# Tech stack

The libraries, services and tools DockMaster uses, with what each one is for and where its source lives.
Versions are the ones installed via `uv.lock` as of 2026-10-01.

## In use

### Python libraries

| Library | Version | Used for | Where in the code | GitHub | License |
|---|---|---|---|---|---|
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) | 1.28.2 | Reading PDFs: words with positions, drawn lines, form widgets, page rendering to PNG, drawing overlays. Writes the signed PDF (`stamp.py`). | `extract.py`, `run_pipeline.py`, `test_pdf.py` | pymupdf/PyMuPDF | AGPL-3.0 or commercial (see note) |
| [opencv-python-headless](https://github.com/opencv/opencv-python) | 5.0.0.93 | Finding horizontal signature lines on scanned pages (threshold + morphological open); drawing candidate boxes + IDs onto the images sent to Claude | `extract.py` (`_scan_lines`), `propose.py` (`_marked_image`) | opencv/opencv-python | Apache-2.0 |
| [NumPy](https://github.com/numpy/numpy) | 2.5.3 | Turning rendered page pixels into an image array for OpenCV | `extract.py` | numpy/numpy | BSD-3-Clause |
| [anthropic](https://github.com/anthropics/anthropic-sdk-python) | 1.11.0 | Calling Claude with page images + candidate list, structured output parsing | `propose.py` | anthropics/anthropic-sdk-python | MIT |
| [Pydantic](https://github.com/pydantic/pydantic) | 2.13.5 | Schema for Claude's answer (parties, signers, fields). The schema has no coordinate fields, so Claude cannot place boxes. | `propose.py` | pydantic/pydantic | MIT |
| [python-dotenv](https://github.com/theskumar/python-dotenv) | 1.2.4 | Loading `ANTHROPIC_API_KEY` from the gitignored `.env` | `run_pipeline.py`, `api.py` | theskumar/python-dotenv | BSD-3-Clause |
| [FastAPI](https://github.com/fastapi/fastapi) | 0.142.2 | HTTP API under `/api`; serves page images, PDFs and the built frontend | `api.py`, `auth.py` | fastapi/fastapi | MIT |
| [Uvicorn](https://github.com/encode/uvicorn) | 0.54.0 | ASGI server that runs the FastAPI app | command line / Dockerfile | encode/uvicorn | BSD-3-Clause |
| [SQLModel](https://github.com/fastapi/sqlmodel) | 0.0.47 | SQLite tables: users, sessions, envelopes, signers, fields, outbox | `models.py`, `db.py` | fastapi/sqlmodel | MIT |
| [python-multipart](https://github.com/Kludex/python-multipart) | 0.0.32 | Parsing PDF uploads (`UploadFile`) | `api.py` | Kludex/python-multipart | Apache-2.0 |

### AI service

| Service | Model | Used for | Where |
|---|---|---|---|
| Anthropic Claude API | `claude-sonnet-5-5`, effort `medium`, server-side fallback on | Classifying candidate blanks by ID: which signer, what type, who fills it, how confident. It never outputs coordinates. | `propose.py` |

Measured cost: about $0.05 for a 4-page NDA and $0.10 for an 18-page lease. Every call is logged to `backend/out/llm_calls.jsonl`.

### Runtime and tooling

| Tool | Version | Used for | GitHub |
|---|---|---|---|
| Python | 3.12 | Language runtime | [python/cpython](https://github.com/python/cpython) |
| uv | 0.12.5 | Dependency management and running scripts (no pip/conda) | [astral-sh/uv](https://github.com/astral-sh/uv) |

### Scanned PDFs: no OCR engine

Scanned pages have no text layer. Instead of an OCR engine, Claude reads them from the page images. Each image it
receives has every candidate blank drawn as a red box labelled with its ID (`propose.py`, `_marked_image`).

| Tool | Status |
|---|---|
| Tesseract OCR ([tesseract-ocr/tesseract](https://github.com/tesseract-ocr/tesseract)) | **Not used.** PyMuPDF's `get_textpage_ocr()` is still tried and is used automatically if Tesseract happens to be installed, but nothing depends on it. |
| RapidOCR ([RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR)), PaddleOCR ([PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)) | **Considered, not used.** See DECISIONS.md (2026-10-01). |

### Frontend (`frontend/`, npm via the project-local Node)

| Library | Version | Used for | GitHub | License |
|---|---|---|---|---|
| React | 19.3.0 | UI | [facebook/react](https://github.com/facebook/react) | MIT |
| Vite | 8.3.2 | Dev server (proxies `/api` to FastAPI) and production build | [vitejs/vite](https://github.com/vitejs/vite) | MIT |
| TypeScript | 7.0.2 | Type checking | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 |
| Tailwind CSS | 4.3.3 | Styling (via `@tailwindcss/vite`) | [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) | MIT |
| @dnd-kit/core | 6.3.1 | Dragging cards between review columns (sortable removed: cards are ordered by page position) | [clauderic/dnd-kit](https://github.com/clauderic/dnd-kit) | MIT |
| react-rnd | 10.5.3 | Moving and resizing field boxes on the page preview | [bokuweb/react-rnd](https://github.com/bokuweb/react-rnd) | MIT |
| signature_pad | 5.1.4 | Drawing signatures | [szimek/signature_pad](https://github.com/szimek/signature_pad) | MIT |
| Dancing Script (Google Fonts) | n/a | Script font for typed signatures, loaded at runtime from fonts.googleapis.com; falls back to a system cursive font if unavailable | [google/fonts](https://github.com/google/fonts) | OFL-1.1 |

### Dev-only tools (not in the Docker image)

| Tool | Version | Used for | GitHub | License |
|---|---|---|---|---|
| nodeenv | 1.11.0 | Installs Node.js 24 inside `.venv` | [ekalinin/nodeenv](https://github.com/ekalinin/nodeenv) | BSD-3-Clause |
| Playwright (Python) | 1.63.0 | Driving the UI in headless Chromium for checks and screenshots | [microsoft/playwright-python](https://github.com/microsoft/playwright-python) | Apache-2.0 |

### Deployment

| Technology | For | GitHub |
|---|---|---|
| Docker | Single-container deploy (`Dockerfile`): Node build stage plus Python runtime, with `/data` volume | [docker](https://github.com/docker) |

## Licensing note

PyMuPDF is dual-licensed: AGPL-3.0 or a commercial license from Artifex. AGPL is fine for this project. A commercial
product served over a network would need either the commercial license or its full source released under AGPL.
Every other dependency is under a permissive license (MIT, BSD or Apache-2.0).
