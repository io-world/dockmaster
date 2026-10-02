"""Claude's classification + extraction geometry -> proposal JSON (the shape in CLAUDE.md).

Only this module turns candidate IDs into bboxes. All coordinates are PyMuPDF points, origin top-left.
"""

from __future__ import annotations

from .extract import Extraction

MIN_HEIGHT = {"signature": 24.0, "initials": 18.0, "date": 14.0, "text": 14.0}
PLACEMENT = {"widget": "widget", "underscore": "underscore", "line": "line", "scan_line": "line",
             "checkbox": "checkbox", "label_offset": "label_offset"}
REVIEW_BELOW = 0.6


def _size(bbox: list[float], ftype: str, src: str, rotation: int = 0) -> list[float]:
    """Grow a field away from its line (towards where text is written) so there is room to write.

    "Above the line" depends on page rotation: up for 0, +x for 90, down for 180, -x for 270 (display space).
    Widgets and checkboxes keep their exact rects.
    """
    if src in ("widget", "checkbox") or ftype == "checkbox":
        return bbox
    x0, y0, x1, y1 = bbox
    need = MIN_HEIGHT.get(ftype, 14.0)
    rot = rotation % 360
    if rot == 0 and y1 - y0 < need:
        y0 = max(y1 - need, 0)
    elif rot == 90 and x1 - x0 < need:
        x1 = x0 + need
    elif rot == 180 and y1 - y0 < need:
        y1 = y0 + need
    elif rot == 270 and x1 - x0 < need:
        x0 = max(x1 - need, 0)
    return [round(v, 2) for v in (x0, y0, x1, y1)]


def place(ex: Extraction, proposed: dict) -> dict:
    cp, meta = proposed["proposal"], proposed["meta"]
    cands = {c.id: c for c in ex.candidates}
    rotation = {p.n: p.rotation for p in ex.pages}

    # Renumber Claude's ids into stable p1/s1/f1 sequences.
    party_map = {p["id"]: f"p{i}" for i, p in enumerate(cp["parties"], 1)}
    signer_map = {s["id"]: f"s{i}" for i, s in enumerate(cp["signers"], 1)}

    parties = [{**p, "id": party_map[p["id"]], "source": "ai"} for p in cp["parties"]]
    signers = [{"id": signer_map[s["id"]], "party_id": party_map.get(s["party_id"]), "label": s["label"],
                "name": None, "email": None, "is_self": False, "order": s["order"], "required": s["required"],
                "confidence": s["confidence"], "reason": s["reason"]} for s in cp["signers"]]

    fields = []
    for f in sorted(cp["fields"], key=lambda f: (cands[f["candidate_id"]].page, cands[f["candidate_id"]].bbox[1],
                                                 cands[f["candidate_id"]].bbox[0])):
        c = cands[f["candidate_id"]]
        placement = PLACEMENT.get(c.src, c.src)
        fields.append({
            "id": f"f{len(fields) + 1}",
            "signer_id": signer_map.get(f["signer_id"]) if f["signer_id"] else None,
            "filled_by": f["filled_by"],
            "type": f["type"],
            "label": f["label"],
            "description": f["description"],
            "page": c.page,
            "bbox": _size(c.bbox, f["type"], c.src, rotation.get(c.page, 0)),
            "required": f["required"],
            "candidate_id": c.id,
            "placement": placement,
            "confidence": f["confidence"],
            "reason": f["reason"],
            "needs_review": placement == "label_offset" or f["confidence"] < REVIEW_BELOW,
            "source": "ai",
            "value": None,
        })

    missing = [{**m, "signer_id": signer_map.get(m["signer_id"]) if m["signer_id"] else None}
               for m in cp["missing_fields"]]
    warnings = list(cp["warnings"]) + proposed["warnings"]
    warnings += [f"Expected a {m['type']} on page {m['page']} but found no blank: {m['description']}" for m in missing]

    return {
        "document": {
            "doc_type": cp["doc_type"],
            "summary": cp["summary"],
            "pages": [{"n": p.n, "width": p.width, "height": p.height, "image": p.image,
                       "text_layer": p.text_layer, "rotation": p.rotation} for p in ex.pages],
        },
        "parties": parties,
        "signers": signers,
        "fields": fields,
        "rejected_candidates": cp["rejected"],
        "missing_fields": missing,
        "warnings": warnings + ex.warnings,
        "meta": meta,
    }


def fallback_proposal(ex: Extraction, error: str) -> dict:
    """Used when the AI step fails: every detected blank becomes an unassigned field, so the sender can still
    finish the envelope by hand. Same shape as place()."""
    fields = []
    for c in sorted(ex.candidates, key=lambda c: (c.page, c.bbox[1], c.bbox[0])):
        ftype = "checkbox" if c.src == "checkbox" else "text"
        fields.append({
            "id": f"f{len(fields) + 1}", "signer_id": None, "filled_by": "signer", "type": ftype,
            "label": c.left_label or c.above_label or c.below_label or "", "description": "",
            "page": c.page, "bbox": _size(c.bbox, ftype, c.src), "required": True, "candidate_id": c.id,
            "placement": PLACEMENT.get(c.src, c.src), "confidence": 0.0,
            "reason": "AI step unavailable; assign this field by hand", "needs_review": True,
            "source": "ai", "value": None,
        })
    return {
        "document": {"doc_type": "Document", "summary": "",
                     "pages": [{"n": p.n, "width": p.width, "height": p.height, "image": p.image,
                                "text_layer": p.text_layer, "rotation": p.rotation} for p in ex.pages]},
        "parties": [], "signers": [], "fields": fields, "rejected_candidates": [], "missing_fields": [],
        "warnings": [f"The AI step failed ({error}). All detected blanks are listed below for you to assign; "
                     "add signers and fields by hand."] + ex.warnings,
        "meta": {"model": None, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "duration_ms": 0,
                 "error": error},
    }
