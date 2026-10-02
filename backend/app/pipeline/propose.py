"""Candidates + page text + page images -> Claude -> who signs what.

Claude classifies candidates by ID. The output schema has no coordinates, so Claude cannot place fields;
place.py maps candidate IDs back to geometry.
"""

from __future__ import annotations

import base64
import json
import sys
import time
from pathlib import Path
from typing import Literal

import anthropic
import cv2
import numpy as np
from pydantic import BaseModel, Field

from .extract import Candidate, Extraction, PageInfo

MODEL = "claude-sonnet-5-5"
EFFORT = "medium"
MAX_TOKENS = 64000  # thinking counts toward this; streaming avoids HTTP timeouts at this size
MAX_IMAGES = 20  # API allows 100 images/request; page text for every page is always sent
# $ per 1M tokens: (input, output, cache_read). A server-side fallback may be served by another model.
PRICES = {
    "claude-sonnet-5-5": (2.00, 10.00, 0.20),
    "claude-sonnet-5": (2.00, 10.00, 0.20),
    "claude-opus-5-5": (4.00, 20.00, 0.20),
    "claude-opus-5": (5.00, 25.00, 0.50),
    "claude-opus-4-8": (5.00, 25.00, 0.50),
    "claude-fable-5-1": (10.00, 50.00, 0.25),
    "claude-haiku-4-5": (1.00, 5.00, 0.10),
    "claude-haiku-4-5-20251001": (1.00, 5.00, 0.10),
}
LOG_PATH = Path(__file__).resolve().parents[2] / "out" / "llm_calls.jsonl"

FieldType = Literal["signature", "initials", "date", "text", "checkbox"]


# ---------- what Claude returns (no coordinates anywhere) ----------


class Party(BaseModel):
    id: str = Field(description="p1, p2, ...")
    name: str | None = Field(description="Name as written in the document; null if left blank")
    role: str = Field(description="Role in the agreement, e.g. 'Disclosing Party', 'Tenant', 'Guarantor'")
    evidence: str = Field(description="Where in the document this party is identified, e.g. 'page 1, preamble'")


class Signer(BaseModel):
    id: str = Field(description="s1, s2, ...")
    party_id: str
    label: str = Field(description="Short human label, e.g. 'Signer for Acme Corp', 'Tenant 2'")
    required: bool = Field(description="False for optional signers, e.g. 'Guarantor (if applicable)'")
    order: int = Field(description="Signing order; use 1 for everyone unless the document implies a sequence")
    confidence: float = Field(ge=0, le=1)
    reason: str


class FieldAssignment(BaseModel):
    candidate_id: str
    signer_id: str | None = Field(description="Signer who fills this in; null when filled_by is 'sender'")
    filled_by: Literal["signer", "sender"] = Field(
        description="'sender' for blanks completed before sending (party names in the preamble, amounts, "
                    "effective dates, addresses of the sender's side); 'signer' for what the signer provides")
    type: FieldType
    label: str = Field(description="The document's own label text, e.g. 'Print Name:'")
    description: str = Field(description="Plain-English description, e.g. 'Company signatory's printed name'")
    required: bool
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(description="One sentence of evidence: heading, label, position")


class Rejection(BaseModel):
    candidate_id: str
    reason: str = Field(description="e.g. 'table border', 'underlined heading', 'caption under another field'")


class MissingField(BaseModel):
    page: int
    signer_id: str | None
    type: FieldType
    description: str = Field(description="What should be here and why, e.g. 'Landlord signature under RECEIPT FOR PAYMENT'")


class ClaudeProposal(BaseModel):
    doc_type: str
    summary: str = Field(description="One sentence: what the document is and between whom")
    parties: list[Party]
    signers: list[Signer]
    fields: list[FieldAssignment]
    rejected: list[Rejection]
    missing_fields: list[MissingField]
    warnings: list[str] = Field(description="Problems the sender should know about, e.g. a party name left blank")


SYSTEM = """You set up documents for electronic signature. A geometry engine has already found every \
candidate blank in the PDF (typed underscores, drawn lines, checkboxes, existing form widgets, and \
speculative spots after labels like "Date:"). Your job is to classify those candidates; you never place fields.

For each document:
1. Identify the parties to the agreement and the people who will sign for them. A company party is usually \
one signer (its officer). Create one signer per distinct signature block: if the document repeats a block \
for the same role (e.g. four tenant blocks), create that many signers (Tenant 1..4), with the extras \
required=false. Mark optional signers ("if applicable") as required=false.
2. Classify EVERY candidate exactly once: either as a field (in `fields`) or as not-a-field (in `rejected`).
   - Use the heading, the left/above/below labels, the position (x, y in points from the top-left; \
pages are about 612 wide) and the page images to decide which signer owns a blank. Blocks under a \
party's heading belong to that party's signer. Pages may have side-by-side columns whose text interleaves \
in the document text, so trust x positions and the images over reading order.
   - A signature, its printed name and its date form one block and belong to the same signer. The field's \
description must name the same signer it is assigned to.
   - type: signature for Signed/Signature/By lines; initials for Initials boxes; date for Date lines; \
checkbox for check boxes; text for everything else (names, titles, addresses, amounts).
   - filled_by='sender' for blanks that should be completed before the document is sent: party names in \
the preamble, effective/start dates, rent or fee amounts, property details. filled_by='signer' for what each \
signer provides: their signature, printed name, title, signing date, initials, their own contact details.
   - Reject table borders, separator rules, underlined text, and captions that sit beneath another blank \
(e.g. a 'Signature' caption under a 'By:' line). src=label_offset candidates are guesses: accept them only \
when the label clearly asks for a value next to it.
   - in_table=true means the line touches vertical rules at both ends: often a table border, but sometimes \
a real line inside a table cell. Decide from the labels.
3. List in `missing_fields` any signature, initials or date you expect but that no candidate covers.
4. Be honest with confidence: below 0.6 when you are guessing. Never invent candidate IDs.

The page images show every candidate as a red box labelled with its ID. Scanned pages have no text layer: \
their candidates come with empty labels and their document text is blank, so read the labels, headings and \
party names from the image. Use the boxes to tie what you read to candidate IDs."""


def _candidate_line(c: Candidate) -> str:
    x0, y0, x1, _ = (round(v) for v in c.bbox)
    parts = [f"{c.id} p{c.page} {c.src} at x={x0}-{x1} y={y0}"]
    if c.in_table:
        parts.append("in_table")
    labels = " ".join(f'{k}="{v}"' for k, v in (("left", c.left_label), ("above", c.above_label),
                                                 ("below", c.below_label), ("heading", c.heading)) if v)
    parts.append(labels)
    if c.line_text:
        parts.append(f'line="{c.line_text}"')
    if c.existing_text:
        parts.append(f'existing_text="{c.existing_text}"')
    if c.widget:
        parts.append(f"widget={json.dumps(c.widget)}")
    return " | ".join(p for p in parts if p)


def _image_pages(ex: Extraction) -> set[int]:
    """Pages to send as images, capped at MAX_IMAGES.

    Priority: the last page, pages with candidates (most first), then scanned pages without candidates,
    which have no text layer and may still name the parties.
    """
    counts: dict[int, int] = {}
    for c in ex.candidates:
        counts[c.page] = counts.get(c.page, 0) + 1
    scanned = [p.n for p in ex.pages if not p.text_layer and p.n not in counts]
    last = ex.pages[-1].n if ex.pages else None
    ranked = [p for p in sorted(counts, key=lambda p: -counts[p]) if p != last] + scanned
    wanted = ([last] if last in counts or last in scanned else []) + [p for p in ranked if p != last]
    return set(wanted[:MAX_IMAGES])


def _marked_image(page: PageInfo, candidates: list[Candidate]) -> bytes:
    """The rendered page with each candidate drawn as a red box labelled with its ID.

    Lets Claude tie IDs to what it sees, which matters most on scanned pages where labels can't be extracted.
    Candidate bboxes are in display-space points, the same space as the PNG, so one scale factor maps them.
    """
    img = cv2.imread(page.image)
    scale = img.shape[1] / page.width
    for c in candidates:
        x0, y0, x1, y1 = (int(round(v * scale)) for v in c.bbox)
        cv2.rectangle(img, (x0, y0), (x1, y1), (0, 0, 220), 2)
        (tw, th), _ = cv2.getTextSize(c.id, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        ty = y0 - 3 if y0 - th - 4 > 0 else y1 + th + 3
        cv2.rectangle(img, (x0, ty - th - 2), (x0 + tw + 2, ty + 2), (255, 255, 255), -1)
        cv2.putText(img, c.id, (x0 + 1, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 220), 1, cv2.LINE_AA)
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def _build_content(ex: Extraction, debug_dir: Path | None = None) -> list[dict]:
    def header(i: int) -> str:
        p = ex.pages[i]
        return f"--- page {p.n} ---" if p.text_layer else f"--- page {p.n} (scanned: no text layer, read the image) ---"

    text = "\n\n".join(f"{header(i)}\n{t.strip()}" for i, t in enumerate(ex.page_text))
    cands = "\n".join(_candidate_line(c) for c in ex.candidates)
    content: list[dict] = []
    send = _image_pages(ex)
    for p in ex.pages:
        if p.n in send and p.image:
            png = _marked_image(p, [c for c in ex.candidates if c.page == p.n])
            if debug_dir:
                (Path(debug_dir) / f"sent_{p.n}.png").write_bytes(png)
            content.append({"type": "text", "text": f"Page {p.n} image:"})
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                        "data": base64.standard_b64encode(png).decode()}})
    content.append({"type": "text", "text": f"<document_text>\n{text}\n</document_text>\n\n"
                                            f"<candidates>\n{cands}\n</candidates>"})
    return content


def _cost(model: str, usage) -> float:
    pin, pout, pcache = PRICES.get(model, PRICES[MODEL])  # unknown model: estimate, flagged in meta
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    return (usage.input_tokens * pin + cache_write * pin * 1.25 + cache_read * pcache
            + usage.output_tokens * pout) / 1_000_000


def _validate(ex: Extraction, cp: ClaudeProposal) -> list[str]:
    """Make the output internally consistent; every fix becomes a visible warning."""
    warnings: list[str] = []
    cand_ids = {c.id for c in ex.candidates}
    party_ids = {p.id for p in cp.parties}
    signer_ids = {s.id for s in cp.signers}

    for s in list(cp.signers):
        if s.party_id not in party_ids:
            warnings.append(f"Signer '{s.label}' referenced unknown party {s.party_id}")

    seen: set[str] = set()
    kept_fields = []
    for f in cp.fields:
        if f.candidate_id not in cand_ids:
            warnings.append(f"AI referenced unknown candidate {f.candidate_id}; ignored")
            continue
        if f.candidate_id in seen:
            warnings.append(f"AI classified {f.candidate_id} twice; kept the first")
            continue
        if f.signer_id is not None and f.signer_id not in signer_ids:
            warnings.append(f"Field {f.candidate_id} pointed to unknown signer {f.signer_id}; left unassigned")
            f.signer_id, f.confidence = None, min(f.confidence, 0.3)
        if f.filled_by == "signer" and f.signer_id is None:
            f.confidence = min(f.confidence, 0.3)
        seen.add(f.candidate_id)
        kept_fields.append(f)
    cp.fields = kept_fields

    cp.rejected = [r for r in cp.rejected if r.candidate_id in cand_ids and r.candidate_id not in seen]
    seen |= {r.candidate_id for r in cp.rejected}

    for c in ex.candidates:
        if c.id not in seen:
            cp.fields.append(FieldAssignment(
                candidate_id=c.id, signer_id=None, filled_by="signer", type="text",
                label=c.left_label or c.above_label or "", description="Unclassified blank",
                required=False, confidence=0.0, reason="Not classified by AI"))
            warnings.append(f"AI did not classify {c.id}; added as an unassigned field")

    signers_with_fields = {f.signer_id for f in cp.fields}
    for s in cp.signers:
        if s.id not in signers_with_fields:
            warnings.append(f"Signer '{s.label}' has no fields to fill")
    for p in cp.parties:
        if not any(s.party_id == p.id for s in cp.signers):
            warnings.append(f"Party '{p.name or p.role}' has no signer")
    return warnings


def propose(ex: Extraction, model: str = MODEL, debug_dir: str | Path | None = None) -> dict:
    """Returns {'proposal': ClaudeProposal dict, 'warnings': [...], 'meta': {...}}."""
    client = anthropic.Anthropic()
    t0 = time.monotonic()
    # Haiku 4.5 rejects `effort` and has no server-side fallback; current Sonnet/Opus take both.
    extra = {} if model.startswith("claude-haiku") else {
        "output_config": {"effort": EFFORT}, "betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    with client.beta.messages.stream(
        model=model,
        max_tokens=MAX_TOKENS,
        system=SYSTEM,
        messages=[{"role": "user", "content": _build_content(ex, debug_dir)}],
        output_format=ClaudeProposal,
        **extra,
    ) as stream:
        response = stream.get_final_message()
    duration_ms = int((time.monotonic() - t0) * 1000)

    served_by = response.model
    meta = {
        "model": served_by,
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cost_usd": round(_cost(served_by, response.usage), 5),
        "duration_ms": duration_ms,
        "stop_reason": response.stop_reason,
        "images_sent": len(_image_pages(ex)),
    }
    if served_by not in PRICES:
        meta["cost_note"] = f"no price for {served_by}; cost estimated at {MODEL} rates"
    _log(meta, ex)

    if response.stop_reason == "max_tokens":
        raise RuntimeError(f"Claude ran out of output tokens ({MAX_TOKENS}) before finishing the proposal; "
                           "the document may have too many blanks for one call")
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise RuntimeError(f"Claude returned no proposal (stop_reason={response.stop_reason})")

    cp: ClaudeProposal = response.parsed_output
    warnings = _validate(ex, cp)
    return {"proposal": cp.model_dump(), "warnings": warnings, "meta": meta}


def _log(meta: dict, ex: Extraction) -> None:
    print(f"[llm] {meta['model']} in={meta['input_tokens']} out={meta['output_tokens']} "
          f"${meta['cost_usd']:.4f} {meta['duration_ms']}ms stop={meta['stop_reason']}", file=sys.stderr)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a") as f:
        f.write(json.dumps({"ts": time.time(), "pages": len(ex.pages), "candidates": len(ex.candidates), **meta}) + "\n")
