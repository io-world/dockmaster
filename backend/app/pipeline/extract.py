"""PDF -> candidate blanks + labels + page images. No AI here.

Everything is in PyMuPDF space: points, origin top-left, as the page is displayed (rotation applied).
Detection runs in the page's unrotated space, where text runs horizontally; output bboxes are converted
with page.rotation_matrix so they line up with page.rect and the rendered PNGs.
Geometry comes only from this module; Claude later classifies candidates by ID.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

import pymupdf

# --- tunables (general, not per-document) ---
MIN_LINE_LEN = 40.0  # drawn lines shorter than this are usually decoration
MIN_UNDERSCORE_LEN = 18.0  # typed underscores are intentional; allow short "____ day of" blanks
MIN_INLINE_LINE_LEN = 12.0  # a drawn line with text right next to it on the row ("20__") is a blank
MAX_WIDTH_FRAC = 0.85  # full-width rules are separators, not blanks
ROW_TOL = 3.0  # vertical tolerance for "same row"
SCAN_TEXT_MIN_CHARS = 20  # fewer chars than this => treat page as scanned
RENDER_DPI = 110
SCANNED_RENDER_DPI = 150  # scanned pages: Claude reads labels from the image, so keep small print legible
SCAN_DPI = 150
LABEL_OFFSET_WIDTH = 150.0
MIN_LABEL_OFFSET_WIDTH = 30.0  # skip speculative boxes squeezed against the page edge
IMAGE_PAGE_FRAC = 0.5  # an image covering this much of the page => also look for raster lines

UNDERSCORE_RE = re.compile(r"_{3,}")
CHECKBOX_GLYPHS = {"☐", "□", "❏", "❑"}  # ☐ □ ❏ ❑
RADIO_GLYPHS = {"○", "◯", "⚪", "❍", "◦"}  # round option markers; Claude rejects the ones used as list bullets
LABEL_WORDS = r"(signature|signed|sign|by|name|print(ed)? name|title|its|date|dated|initials?|email|phone|fax|address)"
LABEL_COLON_RE = re.compile(rf"^{LABEL_WORDS}\s*:$", re.IGNORECASE)
LABEL_BARE_RE = re.compile(rf"^{LABEL_WORDS}$", re.IGNORECASE)  # only when alone on its row


@dataclass
class Candidate:
    id: str
    page: int  # 1-based
    bbox: list[float]  # [x0, y0, x1, y1] points, top-left origin
    src: str  # widget | underscore | line | scan_line | checkbox | radio | label_offset
    left_label: str = ""
    above_label: str = ""
    below_label: str = ""
    heading: str = ""
    line_text: str = ""  # the row's text with this blank shown as [id]
    existing_text: str = ""  # text already sitting on the blank, if any
    widget: dict | None = None  # name/type for pre-existing form fields
    in_table: bool = False  # line meets vertical rules at its ends: likely a table border


@dataclass
class PageInfo:
    n: int
    width: float
    height: float
    text_layer: bool
    rotation: int = 0  # /Rotate of the page; stamp.py converts back with page.derotation_matrix
    image: str | None = None


@dataclass
class Extraction:
    pages: list[PageInfo]
    candidates: list[Candidate]
    page_text: list[str]
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------- small geometry helpers ----------


def _overlap_x(a, b) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0]))


def _overlap_y(a, b) -> float:
    return max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def _same_row(a, b) -> bool:
    ca, cb = (a[1] + a[3]) / 2, (b[1] + b[3]) / 2
    return abs(ca - cb) <= max(ROW_TOL, 0.5 * min(a[3] - a[1], b[3] - b[1]))


def _intersects(a, b, pad=0.0) -> bool:
    return not (a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1])


# ---------- words & rows ----------


@dataclass
class Word:
    bbox: list[float]
    text: str
    bold: bool = False


def _words(page: pymupdf.Page, textpage=None) -> list[Word]:
    raw = page.get_text("words", textpage=textpage)
    words = [Word([w[0], w[1], w[2], w[3]], w[4]) for w in raw if w[4].strip()]
    # Bold flags come from spans; map by overlap (cheap, good enough for heading detection).
    if textpage is None:
        bold_boxes = []
        for b in page.get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                for s in ln["spans"]:
                    if s["flags"] & 16 or "bold" in s["font"].lower():
                        bold_boxes.append(s["bbox"])
        for w in words:
            w.bold = any(_overlap_x(w.bbox, bb) > 0 and _overlap_y(w.bbox, bb) > 0 for bb in bold_boxes)
    return words


def _merge_letterspaced(row: list[Word]) -> list[Word]:
    """Join runs of single-character words ("D a t e :") into one word."""
    out: list[Word] = []
    run_open = False  # is out[-1] built only from single characters?
    for w in row:
        single = len(w.text) == 1
        if single and run_open and w.bbox[0] - out[-1].bbox[2] < 30:
            prev = out[-1]
            prev.text += w.text
            prev.bbox = [prev.bbox[0], min(prev.bbox[1], w.bbox[1]), w.bbox[2], max(prev.bbox[3], w.bbox[3])]
            continue
        out.append(Word(list(w.bbox), w.text, w.bold))
        run_open = single
    return out


def _rows(words: list[Word]) -> list[list[Word]]:
    rows: list[list[Word]] = []
    for w in sorted(words, key=lambda w: ((w.bbox[1] + w.bbox[3]) / 2, w.bbox[0])):
        if rows and _same_row(rows[-1][0].bbox, w.bbox):
            rows[-1].append(w)
        else:
            rows.append([w])
    for r in rows:
        r.sort(key=lambda w: w.bbox[0])
    return [_merge_letterspaced(r) for r in rows]


def _row_bbox(row: list[Word]) -> list[float]:
    return [min(w.bbox[0] for w in row), min(w.bbox[1] for w in row),
            max(w.bbox[2] for w in row), max(w.bbox[3] for w in row)]


# ---------- candidate sources ----------


def _underscore_runs(words: list[Word]) -> list[list[float]]:
    """Find ___ runs inside words (label and underscores may be one word). Sub-bbox by char width."""
    runs = []
    for w in words:
        if "_" not in w.text:
            continue
        cw = (w.bbox[2] - w.bbox[0]) / max(len(w.text), 1)
        for m in UNDERSCORE_RE.finditer(w.text):
            runs.append([w.bbox[0] + m.start() * cw, w.bbox[1], w.bbox[0] + m.end() * cw, w.bbox[3]])
    return _merge_horizontal(runs, gap=6.0)


def _drawn_lines(page: pymupdf.Page) -> list[list[float]]:
    segs = []
    for d in page.get_drawings():
        for item in d["items"]:
            if item[0] == "l":
                p1, p2 = item[1], item[2]
                if abs(p1.y - p2.y) < 1 and abs(p1.x - p2.x) > 1:
                    y = (p1.y + p2.y) / 2
                    segs.append([min(p1.x, p2.x), y - 0.5, max(p1.x, p2.x), y + 0.5])
            elif item[0] == "re":
                r = item[1]
                if r.height < 2 and r.width > r.height:  # Word exports underlines as thin rects
                    segs.append([r.x0, r.y0, r.x1, r.y1])
    return _merge_horizontal(segs, gap=3.0)


def _vertical_rules(page: pymupdf.Page) -> list[list[float]]:
    out = []
    for d in page.get_drawings():
        for item in d["items"]:
            if item[0] == "l" and abs(item[1].x - item[2].x) < 1 and abs(item[1].y - item[2].y) > 5:
                p1, p2 = item[1], item[2]
                out.append([p1.x, min(p1.y, p2.y), p1.x, max(p1.y, p2.y)])
            elif item[0] == "re" and item[1].width < 2 and item[1].height > 5:
                r = item[1]
                out.append([r.x0, r.y0, r.x1, r.y1])
    return out


def _checkbox_squares(page: pymupdf.Page, words: list[Word]) -> list[list[float]]:
    boxes = []
    for d in page.get_drawings():
        for item in d["items"]:
            if item[0] == "re":
                r = item[1]
                if 6 <= r.width <= 16 and abs(r.width - r.height) < 2:
                    boxes.append([r.x0, r.y0, r.x1, r.y1])
    for w in words:
        if w.text.strip() in CHECKBOX_GLYPHS:
            boxes.append(list(w.bbox))
    out = []
    for b in boxes:
        if not any(_intersects(b, o) for o in out):
            out.append(b)
    return out


def _radio_marks(page: pymupdf.Page, words: list[Word]) -> list[list[float]]:
    """Round option markers: radio glyphs (alone or stuck to their label, e.g. "○Yes") and small drawn circles."""
    boxes = []
    for w in words:
        t = w.text.strip()
        if t and t[0] in RADIO_GLYPHS:
            cw = (w.bbox[2] - w.bbox[0]) / max(len(t), 1)  # the glyph's width (it may be glued to its label)
            side = max(cw, 6.0)
            cx, cy = w.bbox[0] + cw / 2, w.bbox[1] + 0.6 * (w.bbox[3] - w.bbox[1])  # glyphs sit below mid-line
            boxes.append([cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2])
    for d in page.get_drawings():
        r = d["rect"]
        items = d["items"]
        # A drawn circle is a closed path of curves only (usually 4 beziers), roughly square, checkbox-sized.
        if items and all(it[0] == "c" for it in items) and 6 <= r.width <= 16 and abs(r.width - r.height) < 2:
            boxes.append([r.x0, r.y0, r.x1, r.y1])
    out = []
    for b in sorted(boxes, key=lambda b: (round(b[1]), b[0])):
        if not any(_intersects(b, o) for o in out):
            out.append(b)
    return out


def _option_label(b: list[float], row: list[Word], stops: list[list[float]]) -> str:
    """Text to the right of an option marker, up to the next marker on the same row."""
    nxt = min((o[0] for o in stops if o[0] > b[2] + 1 and _same_row(o, b)), default=float("inf"))
    # bbox[0] >= b[0] - 1 (not b[2]) keeps a label glued to its glyph ("○Yes"); the glyph is stripped below.
    words = [w.text for w in row if w.bbox[0] >= b[0] - 1 and w.bbox[2] > b[2] + 1 and w.bbox[2] <= nxt + 1]
    return " ".join(words).lstrip("".join(RADIO_GLYPHS))[:80].strip()


def _scan_lines(page: pymupdf.Page) -> list[list[float]]:
    """Horizontal lines on a scanned page via OpenCV morphological open."""
    import cv2
    import numpy as np

    pix = page.get_pixmap(dpi=SCAN_DPI, colorspace=pymupdf.csGRAY)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    _, bw = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (40, 1))
    lines = cv2.morphologyEx(bw, cv2.MORPH_OPEN, kernel)
    contours, _ = cv2.findContours(lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    s = 72.0 / SCAN_DPI
    out = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if h <= 6:
            r = pymupdf.Rect(x * s, y * s, (x + w) * s, (y + h) * s) * page.derotation_matrix
            out.append([r.x0, r.y0, r.x1, r.y1])
    # On a rotated page, lines horizontal on screen are vertical in unrotated space; keep the horizontal ones there.
    return _merge_horizontal([b for b in out if b[2] - b[0] > b[3] - b[1]], gap=3.0)


def _image_coverage(page: pymupdf.Page) -> float:
    """Largest image area as a fraction of the page (area is the same rotated or not)."""
    page_area = page.rect.width * page.rect.height
    areas = [pymupdf.Rect(i["bbox"]).get_area() for i in page.get_image_info()]
    return max(areas, default=0.0) / page_area if page_area else 0.0


def _merge_horizontal(boxes: list[list[float]], gap: float) -> list[list[float]]:
    boxes = sorted(boxes, key=lambda b: (round((b[1] + b[3]) / 2), b[0]))
    merged: list[list[float]] = []
    for b in boxes:
        if merged:
            m = merged[-1]
            if abs((m[1] + m[3]) / 2 - (b[1] + b[3]) / 2) <= 1.5 and b[0] - m[2] <= gap:
                merged[-1] = [m[0], min(m[1], b[1]), max(m[2], b[2]), max(m[3], b[3])]
                continue
        merged.append(list(b))
    return merged


# ---------- labels ----------


def _text_on(box, words: list[Word]) -> tuple[str, float]:
    """Text sitting directly on top of a line (bottom of glyphs within a few pt above it)."""
    hits = [w for w in words if "_" not in w.text
            and _overlap_x(w.bbox, box) > 0.5 * (w.bbox[2] - w.bbox[0])
            and -3 <= box[1] - w.bbox[3] <= 4]
    covered = sum(_overlap_x(w.bbox, box) for w in hits)
    return " ".join(w.text for w in hits), covered / max(box[2] - box[0], 1)


def _left_label(box, row_words: list[Word]) -> str:
    left = [w for w in row_words if w.bbox[2] <= box[0] + 2 and "___" not in w.text]
    left.sort(key=lambda w: -w.bbox[2])
    picked, edge = [], box[0]
    for w in left:
        if edge - w.bbox[2] > 30 or len(picked) >= 8:
            break
        picked.append(w)
        edge = w.bbox[0]
    # A word like "ZIP_____" carries its label inline.
    for w in row_words:
        if "___" in w.text and _overlap_x(w.bbox, box) > 0:
            prefix = w.text.split("_")[0].strip()
            if prefix:
                return prefix
    return " ".join(w.text for w in reversed(picked))


def _band_text(box, rows: list[list[Word]], below: bool, max_gap: float) -> str:
    """Text of the nearest row just below/above the box that horizontally overlaps it."""
    best, best_d = "", max_gap
    for row in rows:
        rb = _row_bbox(row)
        d = rb[1] - box[3] if below else box[1] - rb[3]
        if 0 <= d <= best_d:
            ws = [w for w in row if _overlap_x(w.bbox, [box[0] - 40, 0, box[2] + 10, 0]) > 0 and "___" not in w.text]
            if ws:
                best, best_d = " ".join(w.text for w in ws), d
    return best


def _heading(box, rows: list[list[Word]]) -> str:
    """Nearest heading-like text above (short, ALL CAPS or bold) within ~350pt, in the candidate's own column.

    Only words horizontally near the candidate count, so side-by-side signature blocks
    (TENANT | LANDLORD) each get their own heading.
    """
    band = [box[0] - 120, 0, box[2], 0]
    for row in sorted(rows, key=lambda r: -_row_bbox(r)[3]):
        seg = [w for w in row if _overlap_x(w.bbox, band) > 0]
        if not seg:
            continue
        sb = _row_bbox(seg)
        if sb[3] > box[1] or box[1] - sb[3] > 350:
            continue
        text = " ".join(w.text for w in seg).strip()
        letters = [c for c in text if c.isalpha()]
        if len(letters) < 3 or len(seg) > 8:
            continue
        caps = sum(c.isupper() for c in letters) / len(letters) > 0.8
        if caps or all(w.bold for w in seg):
            # Headings can wrap: prepend the line directly above if it is in the same column.
            above = [w for r in rows for w in r if _overlap_x(w.bbox, band) > 0 and 0 <= sb[1] - w.bbox[3] < 6]
            return (" ".join(w.text for w in sorted(above, key=lambda w: w.bbox[0])) + " " + text).strip()
    return ""


def _line_text(box, row_words: list[Word], cid: str) -> str:
    parts, placed = [], False
    for w in row_words:
        if not placed and w.bbox[0] >= box[0] - 2:
            parts.append(f"[{cid}]")
            placed = True
        if "___" in w.text and _overlap_x(w.bbox, box) > 0:
            pre = w.text.split("_")[0]
            post = w.text.rstrip("_").split("_")[-1] if not w.text.endswith("_") else ""
            if pre:
                parts.insert(len(parts) - 1 if placed else len(parts), pre)
            if post:
                parts.append(post)
            continue
        parts.append(w.text)
    if not placed:
        parts.append(f"[{cid}]")
    return " ".join(parts)


# ---------- main ----------


def extract(pdf_path: str | Path, image_dir: str | Path | None = None) -> Extraction:
    try:
        doc = pymupdf.open(pdf_path)
    except (pymupdf.FileDataError, RuntimeError) as e:
        raise ValueError("Could not open the file as a PDF; it may be damaged or not a PDF") from e
    if doc.needs_pass:
        doc.close()
        raise ValueError("PDF is password-protected; remove the password and upload again")
    if doc.page_count == 0:
        doc.close()
        raise ValueError("PDF has no pages")
    pages: list[PageInfo] = []
    page_text: list[str] = []
    candidates: list[Candidate] = []
    warnings: list[str] = []
    n = 0

    def add(page_no, bbox, src, **kw):
        nonlocal n
        n += 1
        r = pymupdf.Rect(bbox) * page.rotation_matrix  # unrotated -> displayed
        r.normalize()
        c = Candidate(id=f"c{n}", page=page_no, bbox=[round(v, 2) for v in (r.x0, r.y0, r.x1, r.y1)], src=src, **kw)
        candidates.append(c)
        return c

    for page in doc:
        pno = page.number + 1
        W, H = page.rect.width, page.rect.height  # as displayed
        unrot = page.rect * page.derotation_matrix
        UW = abs(unrot.width)  # width in the unrotated space detection runs in
        text_layer = len(page.get_text("text").strip()) >= SCAN_TEXT_MIN_CHARS
        textpage = None
        if not text_layer:
            try:
                textpage = page.get_textpage_ocr(dpi=300, full=True)
            except Exception:  # OCR is optional (needs Tesseract); Claude reads scanned pages from the image
                textpage = None
            if textpage is None:
                warnings.append(f"Page {pno} is scanned (no text layer); the AI reads its labels from the page image")
        words = _words(page, textpage)
        rows = _rows(words)
        page_text.append(page.get_text("text", sort=True, textpage=textpage))

        info = PageInfo(n=pno, width=W, height=H, text_layer=text_layer, rotation=page.rotation)
        if image_dir:
            Path(image_dir).mkdir(parents=True, exist_ok=True)
            out = Path(image_dir) / f"{pno}.png"
            page.get_pixmap(dpi=RENDER_DPI if text_layer else SCANNED_RENDER_DPI).save(out)
            info.image = str(out)
        pages.append(info)

        # 1. Existing widgets: highest trust, taken as-is.
        widget_boxes = []
        widgets = list(page.widgets() or [])
        option_boxes = [[w.rect.x0, w.rect.y0, w.rect.x1, w.rect.y1] for w in widgets
                        if w.field_type_string in ("RadioButton", "CheckBox")]
        for wd in widgets:
            r = wd.rect
            b = [r.x0, r.y0, r.x1, r.y1]
            widget_boxes.append(b)
            row = next((rw for rw in rows if _same_row(_row_bbox(rw), [0, r.y0, 0, r.y1])), [])
            info = {"name": wd.field_name, "type": wd.field_type_string, "value": wd.field_value}
            if wd.field_type_string in ("RadioButton", "CheckBox"):  # their label is usually to the right
                info["option_label"] = _option_label(b, row, option_boxes)
                if wd.field_type_string == "RadioButton":
                    try:
                        info["option"] = wd.on_state()  # the option's export value; options share `name`
                    except Exception:
                        pass
            add(pno, b, "widget", left_label=_left_label(b, row), widget=info)

        # 2. Geometry: underscores, then drawn/scanned lines (deduped against underscores).
        found: list[tuple[list[float], str]] = []
        for b in _underscore_runs(words):
            found.append((b, "underscore"))
        if text_layer:
            for b in _drawn_lines(page):
                if not any(_intersects(b, f[0], pad=2) for f in found):
                    found.append((b, "line"))
        # Scanned pages, including scans that carry an OCR text layer: their lines are pixels, not vectors.
        if not text_layer or _image_coverage(page) > IMAGE_PAGE_FRAC:
            for b in _scan_lines(page):
                if not any(_intersects(b, f[0], pad=2) for f in found):
                    found.append((b, "scan_line"))

        verticals = _vertical_rules(page)
        page_cands: list[list[float]] = []
        for b, src in sorted(found, key=lambda f: (f[0][1], f[0][0])):
            length = b[2] - b[0]
            row = next((r for r in rows if _same_row(_row_bbox(r), [b[0], b[3] - 10, b[2], b[3]])), [])
            inline = any(0 <= b[0] - w.bbox[2] < 8 or 0 <= w.bbox[0] - b[2] < 8 for w in row)
            min_len = MIN_UNDERSCORE_LEN if src == "underscore" else (MIN_INLINE_LINE_LEN if inline else MIN_LINE_LEN)
            if length < min_len:
                continue
            if length > MAX_WIDTH_FRAC * UW:
                continue
            if any(_intersects(b, wb, pad=2) for wb in widget_boxes):
                continue
            existing, frac = ("", 0.0) if src == "underscore" else _text_on(b, words)
            if frac > 0.6:  # underlined text, not a blank
                continue
            # Give thin lines a usable height: the blank is the space just above the line.
            box = b if src == "underscore" else [b[0], b[3] - 14, b[2], b[3]]
            row = next((r for r in rows if _same_row(_row_bbox(r), box)), [])
            c = add(pno, box, src, existing_text=existing)
            c.in_table = sum(any(_intersects([x, b[1], x, b[3]], v, pad=2) for v in verticals)
                             for x in (b[0], b[2])) == 2
            c.left_label = _left_label(box, row)
            c.above_label = _band_text(box, rows, below=False, max_gap=10)
            c.below_label = _band_text(b, rows, below=True, max_gap=14)
            c.heading = _heading(box, rows)
            c.line_text = _line_text(box, row, c.id)
            page_cands.append(box)

        # 3. Checkboxes.
        for b in _checkbox_squares(page, words):
            if any(_intersects(b, wb) for wb in widget_boxes):
                continue
            row = next((r for r in rows if _same_row(_row_bbox(r), b)), [])
            right = " ".join(w.text for w in row if w.bbox[0] >= b[2] - 1)[:80]
            c = add(pno, b, "checkbox", left_label=right, heading=_heading(b, rows))
            c.line_text = _line_text(b, row, c.id)
            page_cands.append(b)

        # 3b. Radio options (round markers). Grouping into questions is Claude's job.
        radios = [b for b in _radio_marks(page, words)
                  if not any(_intersects(b, o) for o in widget_boxes + page_cands)]
        for b in radios:
            row = next((r for r in rows if _same_row(_row_bbox(r), b)), [])
            c = add(pno, b, "radio", left_label=_option_label(b, row, radios), heading=_heading(b, rows),
                    above_label=_band_text(b, rows, below=False, max_gap=24))
            c.line_text = _line_text(b, row, c.id)
            page_cands.append(b)

        geometry = list(page_cands) + widget_boxes
        # 4. Label-only blanks ("Date:" with nothing after it): speculative placement.
        for row in rows:
            for i, w in enumerate(row):
                two = f"{row[i-1].text} {w.text}" if i > 0 else ""
                label = (w.text if LABEL_COLON_RE.match(w.text) else
                         two if two and LABEL_COLON_RE.match(two) else None)
                if not label:
                    first = i - 1 if two and LABEL_BARE_RE.match(two) else i
                    alone = first == 0 or row[first].bbox[0] - row[first - 1].bbox[2] > 60
                    if alone and (LABEL_BARE_RE.match(w.text) or (two and LABEL_BARE_RE.match(two))):
                        label = two if first == i - 1 else w.text
                if not label:
                    continue
                rest = [x for x in row[i + 1:] if x.bbox[0] - w.bbox[2] < LABEL_OFFSET_WIDTH]
                if rest:
                    continue
                start = row[i - 1] if label == two else w
                served = any(
                    (_same_row(g, w.bbox) and 0 <= g[0] - w.bbox[2] + 2 < 250)  # line to the right
                    or (0 <= g[3] - w.bbox[3] <= 18 and abs(g[0] - start.bbox[0]) < 25)  # line just below
                    for g in geometry)
                if served:
                    continue
                x0 = w.bbox[2] + 4
                box = [x0, w.bbox[1], min(x0 + LABEL_OFFSET_WIDTH, UW - 36), w.bbox[3]]
                if box[2] - box[0] < MIN_LABEL_OFFSET_WIDTH:
                    continue
                c = add(pno, box, "label_offset", left_label=label, heading=_heading(box, rows),
                        above_label=_band_text(box, rows, below=False, max_gap=10))
                c.line_text = _line_text(box, row, c.id)
                page_cands.append(box)

    doc.close()
    if not candidates:
        warnings.append("No candidate blanks found; fields will need to be placed manually")
    return Extraction(pages=pages, candidates=candidates, page_text=page_text, warnings=warnings)
