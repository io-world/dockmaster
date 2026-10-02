"""Write field values and signature images into the PDF and save the completed copy.

Field bboxes are in display space (rotation applied). PyMuPDF's drawing calls take unrotated page coordinates,
so each box is converted with page.derotation_matrix. Content is inserted unrotated in that space, which runs it
in the same direction as the document's own text (on a /Rotate page the text and the stamp turn together).
"""

from __future__ import annotations

import base64
from pathlib import Path

import pymupdf


def _png_bytes(data_url: str) -> bytes:
    return base64.b64decode(data_url.split(",", 1)[1] if data_url.startswith("data:") else data_url)


def _fit_text(page: pymupdf.Page, rect: pymupdf.Rect, text: str) -> None:
    """Largest font size (up to 11pt) at which the text fits the box; never silently drops text."""
    size = max(min(11.0, rect.height * 0.75), 4.0)
    while size >= 4.0:
        # insert_textbox writes nothing and returns a negative number when the text doesn't fit
        if page.insert_textbox(rect, text, fontsize=size, fontname="helv", color=(0, 0, 0.55),
                               overlay=True) >= 0:
            return
        size -= 0.5
    # Box too small even at 4pt: draw a single line starting at the box anyway so the value is never lost.
    page.insert_text(rect.bl + (1, -1), text, fontsize=4, fontname="helv", color=(0, 0, 0.55))


def stamp(pdf_path: str | Path, fields: list[dict], out_path: str | Path) -> Path:
    """fields: dicts with page, bbox, type, value. Empty values are skipped."""
    doc = pymupdf.open(pdf_path)
    for f in fields:
        value = f.get("value")
        if value in (None, "", "false"):
            continue
        page = doc[f["page"] - 1]
        rect = pymupdf.Rect(f["bbox"]) * page.derotation_matrix
        rect.normalize()
        if f["type"] in ("signature", "initials"):
            page.insert_image(rect, stream=_png_bytes(value), keep_proportion=True, overlay=True)
        elif f["type"] == "checkbox":
            _fit_text(page, rect, "X")
        else:
            _fit_text(page, rect, str(value))
    out_path = Path(out_path)
    doc.save(out_path, garbage=3, deflate=True)
    doc.close()
    return out_path
