"""Run the full pipeline on any PDF(s) on disk and write everything to backend/out/<pdf name>/.

Set PDF_PATH below and run with no arguments:
    uv run python backend/scripts/test_pdf.py

Or pass paths on the command line (these override PDF_PATH):
    uv run python backend/scripts/test_pdf.py ~/Downloads/contract.pdf
    uv run python backend/scripts/test_pdf.py ~/Downloads/some_folder/        # every PDF in the folder
    uv run python backend/scripts/test_pdf.py a.pdf b.pdf --no-ai             # extraction only, no API cost

Output per PDF:
    source.pdf            copy of the input
    pages/N.png           rendered pages
    extract.json          candidate blanks + labels + page text (no AI)
    candidates_N.png      pages with every candidate box drawn, coloured by source
    sent_N.png            the marked page images Claude saw (boxes + candidate IDs)
    proposal.json         parties, signers, fields (AI)
    fields_N.png          pages with fields drawn, coloured by signer
    summary.json          parties -> signers -> fields, sender fields, rejections, warnings, cost
"""

import argparse
import json
import shutil
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pymupdf  # noqa: E402
from run_pipeline import GREY, SIGNER_COLORS, SRC_COLORS, print_summary  # noqa: E402  (also loads .env)

from app.pipeline.extract import extract  # noqa: E402
from app.pipeline.place import place  # noqa: E402
from app.pipeline.propose import propose  # noqa: E402

# >>> Set this to the PDF (or a folder of PDFs) you want to test. ~ is expanded. <<<
PDF_PATH = "~/Documents/DevelopmentProjects/NDAI/backend/test_pdfs/nda-confidentiality_2.21.2020.pdf"
USE_AI = True  # False = extraction only, no Claude call, no cost

OUT_ROOT = Path(__file__).resolve().parents[1] / "out"


def draw(pdf: Path, boxes: list[tuple[int, list[float], str, tuple]], out: Path, prefix: str) -> None:
    doc = pymupdf.open(pdf)
    for page_no, bbox, tag, color in boxes:
        page = doc[page_no - 1]
        page.draw_rect(pymupdf.Rect(bbox), color=color, width=1)
        page.insert_text((bbox[0], bbox[1] - 1), tag, fontsize=6, color=color)
    for page in doc:
        page.get_pixmap(dpi=110).save(out / f"{prefix}_{page.number + 1}.png")
    doc.close()


def build_summary(p: dict) -> dict:
    """Compact view of the proposal: each signer with the fields they fill in."""
    def field(f):
        return {"id": f["id"], "page": f["page"], "type": f["type"], "label": f["label"],
                "description": f["description"], "required": f["required"],
                "confidence": f["confidence"], "needs_review": f["needs_review"]}

    return {
        "doc_type": p["document"]["doc_type"],
        "summary": p["document"]["summary"],
        "party_count": len(p["parties"]),
        "parties": [{"id": x["id"], "role": x["role"], "name": x["name"], "evidence": x["evidence"]}
                    for x in p["parties"]],
        "signers": [{"id": s["id"], "party_id": s["party_id"], "label": s["label"], "required": s["required"],
                     "confidence": s["confidence"],
                     "fields": [field(f) for f in p["fields"] if f["signer_id"] == s["id"]]}
                    for s in p["signers"]],
        "sender_fields": [field(f) for f in p["fields"] if f["filled_by"] == "sender"],
        "unassigned_fields": [{**field(f), "reason": f["reason"]} for f in p["fields"]
                              if f["filled_by"] == "signer" and not f["signer_id"]],
        "rejected": p["rejected_candidates"],
        "missing_fields": p["missing_fields"],
        "warnings": p["warnings"],
        "cost_usd": p["meta"]["cost_usd"],
    }


GENERATED = ["source.pdf", "extract.json", "proposal.json", "summary.json", "summary.txt",
             "candidates_*.png", "fields_*.png", "overlay_*.png", "sent_*.png", "pages/*.png"]


def clear_generated(out: Path) -> None:
    """Remove files from a previous run so a changed PDF can't leave stale pages or overlays behind."""
    for pattern in GENERATED:
        for f in out.glob(pattern):
            f.unlink()


def run_one(pdf: Path, use_ai: bool) -> dict:
    out = OUT_ROOT / pdf.stem
    out.mkdir(parents=True, exist_ok=True)
    clear_generated(out)
    shutil.copy2(pdf, out / "source.pdf")
    t0 = time.monotonic()

    ex = extract(pdf, image_dir=out / "pages")
    (out / "extract.json").write_text(json.dumps(ex.to_dict(), indent=2))
    draw(pdf, [(c.page, c.bbox, c.id, SRC_COLORS.get(c.src, GREY)) for c in ex.candidates], out, "candidates")
    result = {"pdf": str(pdf), "out": str(out), "pages": len(ex.pages), "candidates": len(ex.candidates)}

    if use_ai:
        proposal = place(ex, propose(ex, debug_dir=out))
        (out / "proposal.json").write_text(json.dumps(proposal, indent=2))
        color_of = {s["id"]: SIGNER_COLORS[i % len(SIGNER_COLORS)] for i, s in enumerate(proposal["signers"])}
        draw(pdf, [(f["page"], f["bbox"], f"{f['id']} {f['type']}", color_of.get(f["signer_id"], GREY))
                   for f in proposal["fields"]], out, "fields")
        (out / "summary.json").write_text(json.dumps(build_summary(proposal), indent=2))
        (out / "summary.txt").unlink(missing_ok=True)  # replaced by summary.json
        print_summary(proposal)  # readable version on the console
        result |= {"parties": len(proposal["parties"]), "signers": len(proposal["signers"]),
                   "fields": len(proposal["fields"]),
                   "needs_review": sum(f["needs_review"] for f in proposal["fields"]),
                   "warnings": len(proposal["warnings"]), "cost_usd": proposal["meta"]["cost_usd"]}

    result["seconds"] = round(time.monotonic() - t0, 1)
    return result


def collect(paths: list[str]) -> list[Path]:
    pdfs: list[Path] = []
    for raw in paths:
        p = Path(raw).expanduser().resolve()
        if p.is_dir():
            pdfs += sorted(x for x in p.iterdir() if x.suffix.lower() == ".pdf")
        elif p.is_file() and p.suffix.lower() == ".pdf":
            pdfs.append(p)
        else:
            print(f"skip: {raw} (not a PDF or folder)", file=sys.stderr)
    return pdfs


def main() -> None:
    ap = argparse.ArgumentParser(description="Run the pipeline on PDFs and write results to backend/out/")
    ap.add_argument("paths", nargs="*", help="PDF files and/or folders (default: PDF_PATH in this file)")
    ap.add_argument("--no-ai", action="store_true", help="extraction only (no Claude call, no cost)")
    args = ap.parse_args()

    pdfs = collect(args.paths or [PDF_PATH])
    if not pdfs:
        sys.exit("No PDFs found.")

    results = []
    for pdf in pdfs:
        print(f"\n=== {pdf.name}", file=sys.stderr)
        try:
            r = run_one(pdf, use_ai=USE_AI and not args.no_ai)
            results.append(r)
        except Exception as e:  # keep going on a batch; report at the end
            traceback.print_exc()
            results.append({"pdf": str(pdf), "error": f"{e.__class__.__name__}: {e}"})

    print("\n=== RESULTS", file=sys.stderr)
    for r in results:
        if "error" in r:
            print(f"FAIL  {Path(r['pdf']).name}: {r['error']}", file=sys.stderr)
            continue
        line = f"OK    {Path(r['pdf']).name}: {r['pages']} pages, {r['candidates']} candidates"
        if "fields" in r:
            line += (f", {r['parties']} parties, {r['signers']} signers, {r['fields']} fields "
                     f"({r['needs_review']} need review), {r['warnings']} warnings, ${r['cost_usd']:.3f}")
        print(f"{line}, {r['seconds']}s\n      -> {r['out']}", file=sys.stderr)
    total = sum(r.get("cost_usd", 0) for r in results)
    if total:
        print(f"Total cost: ${total:.3f}", file=sys.stderr)
    sys.exit(1 if any("error" in r for r in results) else 0)


if __name__ == "__main__":
    main()
