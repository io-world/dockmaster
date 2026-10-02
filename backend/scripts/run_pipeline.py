"""Run the pipeline on a PDF and print JSON.

    uv run python backend/scripts/run_pipeline.py path/to/doc.pdf [--out DIR] [--overlay] [--no-ai]

Writes extract.json and (unless --no-ai) proposal.json to the output dir.
--overlay writes page PNGs with boxes drawn on them, for eyeballing (coloured by signer once AI has run).
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

from app.pipeline.extract import extract  # noqa: E402
from app.pipeline.place import place  # noqa: E402
from app.pipeline.propose import propose  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=True)  # project .env beats a stale shell export

SRC_COLORS = {"underscore": (0, 0.6, 0), "line": (0, 0, 1), "scan_line": (0, 0.5, 1),
              "widget": (0.6, 0, 0.6), "checkbox": (1, 0.5, 0), "label_offset": (1, 0, 0)}
SIGNER_COLORS = [(0, 0.45, 0.85), (0.85, 0.3, 0), (0, 0.6, 0.2), (0.6, 0, 0.6), (0.7, 0.6, 0), (0, 0.6, 0.6)]
GREY = (0.5, 0.5, 0.5)


def overlay(pdf: Path, boxes: list[tuple[int, list[float], str, tuple]], out: Path) -> None:
    doc = pymupdf.open(pdf)
    for page_no, bbox, tag, color in boxes:
        page = doc[page_no - 1]
        page.draw_rect(pymupdf.Rect(bbox), color=color, width=1)
        page.insert_text((bbox[0], bbox[1] - 1), tag, fontsize=6, color=color)
    out.mkdir(parents=True, exist_ok=True)
    for page in doc:
        page.get_pixmap(dpi=110).save(out / f"overlay_{page.number + 1}.png")
    doc.close()


def print_summary(p: dict, err=sys.stderr) -> None:
    print(f"\n{p['document']['doc_type']}: {p['document']['summary']}", file=err)
    print(f"\nPARTIES ({len(p['parties'])})", file=err)
    for party in p["parties"]:
        print(f"  {party['id']} {party['role']}: {party['name'] or '(blank)'}  [{party['evidence']}]", file=err)
    for s in p["signers"]:
        opt = "" if s["required"] else " (optional)"
        print(f"\n{s['id']} {s['label']}{opt}  conf={s['confidence']:.2f}", file=err)
        for f in [f for f in p["fields"] if f["signer_id"] == s["id"]]:
            flag = " REVIEW" if f["needs_review"] else ""
            print(f"    {f['id']:>4} p{f['page']} {f['type']:<9} {f['label'][:22]!r:<25} {f['description'][:50]}"
                  f"  ({f['confidence']:.2f}){flag}", file=err)
    sender = [f for f in p["fields"] if f["filled_by"] == "sender"]
    if sender:
        print("\nSENDER FILLS BEFORE SENDING", file=err)
        for f in sender:
            print(f"    {f['id']:>4} p{f['page']} {f['type']:<9} {f['description'][:60]}", file=err)
    unassigned = [f for f in p["fields"] if f["filled_by"] == "signer" and not f["signer_id"]]
    if unassigned:
        print("\nUNASSIGNED", file=err)
        for f in unassigned:
            print(f"    {f['id']:>4} p{f['page']} {f['candidate_id']} {f['reason']}", file=err)
    print(f"\nREJECTED ({len(p['rejected_candidates'])})", file=err)
    for r in p["rejected_candidates"]:
        print(f"    {r['candidate_id']}: {r['reason']}", file=err)
    for w in p["warnings"]:
        print(f"WARNING: {w}", file=err)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--out", type=Path, help="output dir (default backend/out/<stem>)")
    ap.add_argument("--overlay", action="store_true")
    ap.add_argument("--no-ai", action="store_true", help="stop after extraction")
    args = ap.parse_args()

    out = args.out or Path(__file__).resolve().parents[1] / "out" / args.pdf.stem
    ex = extract(args.pdf, image_dir=out / "pages")
    (out / "extract.json").write_text(json.dumps(ex.to_dict(), indent=2))
    print(f"{len(ex.candidates)} candidates -> {out / 'extract.json'}", file=sys.stderr)

    if args.no_ai:
        for c in ex.candidates:
            print(f"{c.id:>4} p{c.page} {c.src:<12} {str([round(v) for v in c.bbox]):<22} "
                  f"L={c.left_label!r:<22} A={c.above_label[:25]!r:<27} B={c.below_label[:20]!r:<22} "
                  f"H={c.heading[:25]!r}", file=sys.stderr)
        if args.overlay:
            overlay(args.pdf, [(c.page, c.bbox, c.id, SRC_COLORS.get(c.src, GREY)) for c in ex.candidates], out)
        print(json.dumps(ex.to_dict()))
        return

    proposal = place(ex, propose(ex))
    (out / "proposal.json").write_text(json.dumps(proposal, indent=2))
    print_summary(proposal)
    print(f"\n-> {out / 'proposal.json'}", file=sys.stderr)

    if args.overlay:
        color_of = {s["id"]: SIGNER_COLORS[i % len(SIGNER_COLORS)] for i, s in enumerate(proposal["signers"])}
        overlay(args.pdf, [(f["page"], f["bbox"], f"{f['id']} {f['type']}", color_of.get(f["signer_id"], GREY))
                           for f in proposal["fields"]], out)
    print(json.dumps(proposal))


if __name__ == "__main__":
    main()
