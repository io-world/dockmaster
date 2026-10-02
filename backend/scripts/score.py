"""Score pipeline output against hand-labelled ground truth.

    uv run python backend/scripts/score.py                      # score every labelled PDF (uses existing output)
    uv run python backend/scripts/score.py --run                # re-run the pipeline first (costs API calls)
    uv run python backend/scripts/score.py --run --model claude-haiku-4-5   # compare another model
    uv run python backend/scripts/score.py --draft path/to.pdf  # write a draft labels file to correct by hand

Ground truth lives next to each PDF: backend/test_pdfs/<name>.labels.json. Fields are labelled by page + bbox
(PyMuPDF points, top-left origin), not candidate ID, so labels survive changes to extraction.

Label field keys:
    page, bbox, label, type (signature|initials|date|text|checkbox), filled_by (signer|sender),
    signer (a key from "signers", or null for sender fields), required,
    owner_any (true when the document is genuinely ambiguous about who fills it: only detection + type are scored)

A proposal field matches a label when they are on the same page and their boxes overlap by at least half of the
smaller box. Proposal signers are mapped to label signers by whichever pairing agrees on the most fields.
"""

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

LABELS_DIR = Path(__file__).resolve().parents[1] / "test_pdfs"
OUT_ROOT = Path(__file__).resolve().parents[1] / "out"
MATCH_IOS = 0.5  # intersection over the smaller box
BUCKETS = [(0.8, 1.01, "high (>=0.8)"), (0.6, 0.8, "medium (0.6-0.8)"), (0.0, 0.6, "low (<0.6)")]


# ---------- matching ----------


def _ios(a: list[float], b: list[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return ix * iy / smaller if smaller > 0 else 0.0


def match_fields(labels: list[dict], fields: list[dict]) -> dict[int, int]:
    """Greedy one-to-one match, best overlap first. Returns {label_index: field_index}."""
    pairs = sorted(((_ios(lab["bbox"], f["bbox"]), li, fi)
                    for li, lab in enumerate(labels) for fi, f in enumerate(fields)
                    if lab["page"] == f["page"]), reverse=True)
    used_l, used_f, out = set(), set(), {}
    for score, li, fi in pairs:
        if score < MATCH_IOS:
            break
        if li not in used_l and fi not in used_f:
            out[li] = fi
            used_l.add(li)
            used_f.add(fi)
    return out


def map_signers(labels: list[dict], fields: list[dict], matches: dict[int, int]) -> dict[str, str]:
    """Map proposal signer ids -> label signer keys, maximising agreement (greedy on co-occurrence counts)."""
    counts: dict[tuple[str, str], int] = {}
    for li, fi in matches.items():
        lab, f = labels[li], fields[fi]
        if lab.get("owner_any") or lab["filled_by"] != "signer" or not f.get("signer_id"):
            continue
        key = (f["signer_id"], lab["signer"])
        counts[key] = counts.get(key, 0) + 1
    mapping, used = {}, set()
    for (sid, lkey), _ in sorted(counts.items(), key=lambda kv: -kv[1]):
        if sid not in mapping and lkey not in used:
            mapping[sid] = lkey
            used.add(lkey)
    return mapping


# ---------- scoring ----------


def _covered_by_candidate(lab: dict, candidates: list[dict]) -> str | None:
    best = max(((c["id"], _ios(lab["bbox"], c["bbox"])) for c in candidates if c["page"] == lab["page"]),
               key=lambda t: t[1], default=(None, 0.0))
    return best[0] if best[1] >= MATCH_IOS else None


def score_doc(truth: dict, proposal: dict, extraction: dict) -> dict:
    labels, fields = truth["fields"], proposal["fields"]
    matches = match_fields(labels, fields)
    smap = map_signers(labels, fields, matches)

    correct_type = correct_owner = owner_scored = fully_correct = 0
    errors, calib = [], []  # calib: (confidence, fully_correct)
    for li, lab in enumerate(labels):
        where = f"p{lab['page']} {lab['label']!r}"
        if li not in matches:
            cand = _covered_by_candidate(lab, extraction["candidates"])
            rejected = cand and any(r["candidate_id"] == cand for r in proposal["rejected_candidates"])
            cause = (f"AI rejected {cand}" if rejected else
                     f"candidate {cand} exists but no field" if cand else "extraction found no candidate")
            errors.append(f"MISSED   {where} ({lab['type']}): {cause}")
            continue
        f = fields[matches[li]]
        ok_type = f["type"] == lab["type"]
        correct_type += ok_type
        if not ok_type:
            errors.append(f"TYPE     {where}: got {f['type']}, expected {lab['type']}")
        ok_owner = True
        if not lab.get("owner_any"):
            owner_scored += 1
            if lab["filled_by"] == "sender":
                ok_owner = f["filled_by"] == "sender"
            else:
                ok_owner = f["filled_by"] == "signer" and smap.get(f.get("signer_id")) == lab["signer"]
            correct_owner += ok_owner
            if not ok_owner:
                got = "sender" if f["filled_by"] == "sender" else smap.get(f.get("signer_id"), f.get("signer_id") or "unassigned")
                expected = "sender" if lab["filled_by"] == "sender" else lab["signer"]
                errors.append(f"OWNER    {where}: got {got}, expected {expected}")
        good = ok_type and ok_owner
        fully_correct += good
        calib.append((f["confidence"], good))

    matched_fields = set(matches.values())
    extra = [f for i, f in enumerate(fields) if i not in matched_fields]
    for f in extra:
        errors.append(f"EXTRA    p{f['page']} {f['label']!r} ({f['type']}, conf {f['confidence']:.2f}): not in labels")

    n_labels, n_fields = len(labels), len(fields)
    return {
        "parties": {"expected": len(truth["parties"]), "got": len(proposal["parties"])},
        "signers": {"expected": len(truth["signers"]), "got": len(proposal["signers"])},
        "labels": n_labels,
        "fields": n_fields,
        "matched": len(matches),
        "recall": len(matches) / n_labels if n_labels else 1.0,
        "precision": len(matches) / n_fields if n_fields else 1.0,
        "type_acc": correct_type / len(matches) if matches else 0.0,
        "owner_acc": correct_owner / owner_scored if owner_scored else 1.0,
        "fully_correct": fully_correct,
        "end_to_end": fully_correct / n_labels if n_labels else 1.0,
        "calibration": calib,
        "errors": errors,
        "signer_map": smap,
        "cost_usd": proposal["meta"]["cost_usd"],
        "model": proposal["meta"]["model"],
        "verified": truth.get("verified", False),
    }


def calibration_table(calib: list[tuple[float, bool]]) -> list[str]:
    rows = []
    for lo, hi, name in BUCKETS:
        hits = [ok for c, ok in calib if lo <= c < hi]
        if hits:
            rows.append(f"  {name:<18} {sum(hits)}/{len(hits)} correct ({sum(hits) / len(hits):.0%})")
    return rows


# ---------- running / drafting ----------


def run_pipeline(pdf: Path, model: str | None, out: Path) -> None:
    from app.pipeline.extract import extract
    from app.pipeline.place import place
    from app.pipeline.propose import MODEL, propose
    import run_pipeline  # noqa: F401  (loads .env)

    out.mkdir(parents=True, exist_ok=True)
    ex = extract(pdf, image_dir=out / "pages")
    (out / "extract.json").write_text(json.dumps(ex.to_dict(), indent=2))
    proposal = place(ex, propose(ex, model=model or MODEL))
    (out / "proposal.json").write_text(json.dumps(proposal, indent=2))


def draft_labels(pdf: Path) -> Path:
    """Write <name>.labels.json from the current proposal, for a human to correct. Never overwrites."""
    out = OUT_ROOT / pdf.stem
    proposal = json.loads((out / "proposal.json").read_text())
    target = LABELS_DIR / f"{pdf.stem}.labels.json"
    if target.exists():
        sys.exit(f"{target} already exists; edit it instead")
    keys = {s["id"]: s["label"].lower().replace(" ", "_")[:30] for s in proposal["signers"]}
    truth = {
        "pdf": pdf.name,
        "verified": False,
        "notes": "DRAFT generated from the AI's proposal. Correct every field, then set verified=true.",
        "parties": [p["name"] or p["role"] for p in proposal["parties"]],
        "signers": [{"key": keys[s["id"]], "label": s["label"], "required": s["required"]} for s in proposal["signers"]],
        "fields": [{"page": f["page"], "bbox": f["bbox"], "label": f["label"], "type": f["type"],
                    "filled_by": f["filled_by"], "signer": keys.get(f["signer_id"]) if f["signer_id"] else None,
                    "required": f["required"], "owner_any": False} for f in proposal["fields"]],
    }
    target.write_text(json.dumps(truth, indent=2))
    return target


# ---------- main ----------


def main() -> None:
    ap = argparse.ArgumentParser(description="Score proposals against labelled ground truth")
    ap.add_argument("--run", action="store_true", help="re-run the pipeline before scoring (costs API calls)")
    ap.add_argument("--model", help="model to use with --run (default: the pipeline's MODEL)")
    ap.add_argument("--draft", type=Path, help="write a draft labels file for this PDF from its current proposal")
    ap.add_argument("--verbose", "-v", action="store_true", help="list every error")
    args = ap.parse_args()

    if args.draft:
        print(f"Draft written: {draft_labels(args.draft.expanduser().resolve())}")
        return

    label_files = sorted(LABELS_DIR.glob("*.labels.json"))
    if not label_files:
        sys.exit(f"No labels in {LABELS_DIR}. Create one with --draft <pdf>.")

    results = {}
    for lf in label_files:
        truth = json.loads(lf.read_text())
        pdf = LABELS_DIR / truth["pdf"]
        out = OUT_ROOT / "_runs" / args.model / pdf.stem if args.model else OUT_ROOT / pdf.stem
        if args.run:
            if not pdf.exists():
                print(f"skip {truth['pdf']}: PDF not found", file=sys.stderr)
                continue
            print(f"running {pdf.name} ...", file=sys.stderr)
            run_pipeline(pdf, args.model, out)
        if not (out / "proposal.json").exists():
            print(f"skip {truth['pdf']}: no proposal.json in {out} (use --run)", file=sys.stderr)
            continue
        results[truth["pdf"]] = score_doc(truth, json.loads((out / "proposal.json").read_text()),
                                          json.loads((out / "extract.json").read_text()))

    if not results:
        sys.exit("Nothing scored.")

    print(f"\n{'document':<34} {'parties':>8} {'signers':>8} {'recall':>7} {'precis':>7} {'type':>6} "
          f"{'owner':>6} {'e2e':>6} {'cost':>7}")
    for name, r in results.items():
        flag = "" if r["verified"] else " *"
        print(f"{(name[:31] + flag):<34} {r['parties']['got']:>3}/{r['parties']['expected']:<4} "
              f"{r['signers']['got']:>3}/{r['signers']['expected']:<4} {r['recall']:>7.0%} {r['precision']:>7.0%} "
              f"{r['type_acc']:>6.0%} {r['owner_acc']:>6.0%} {r['end_to_end']:>6.0%} ${r['cost_usd']:>6.3f}")

    n_labels = sum(r["labels"] for r in results.values())
    n_matched = sum(r["matched"] for r in results.values())
    n_fields = sum(r["fields"] for r in results.values())
    n_correct = sum(r["fully_correct"] for r in results.values())
    calib = [c for r in results.values() for c in r["calibration"]]
    print(f"\nOVERALL  recall {n_matched}/{n_labels} ({n_matched / n_labels:.0%})  "
          f"precision {n_matched}/{n_fields} ({n_matched / n_fields:.0%})  "
          f"end-to-end {n_correct}/{n_labels} ({n_correct / n_labels:.0%})  "
          f"cost ${sum(r['cost_usd'] for r in results.values()):.3f}  model {next(iter(results.values()))['model']}")
    print("\nCONFIDENCE vs ACCURACY (matched fields)")
    print("\n".join(calibration_table(calib)) or "  (none)")
    if any(not r["verified"] for r in results.values()):
        print("\n* labels not yet verified by a human: treat these scores as provisional")

    for name, r in results.items():
        if r["errors"]:
            shown = r["errors"] if args.verbose else r["errors"][:8]
            print(f"\n{name}: {len(r['errors'])} issue(s)")
            print("\n".join(f"  {e}" for e in shown))
            if len(shown) < len(r["errors"]):
                print(f"  ... {len(r['errors']) - len(shown)} more (use -v)")

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    report = {"ts": time.time(), "model": next(iter(results.values()))["model"],
              "overall": {"recall": n_matched / n_labels, "precision": n_matched / n_fields,
                          "end_to_end": n_correct / n_labels},
              "docs": {k: {kk: vv for kk, vv in v.items() if kk != "calibration"} for k, v in results.items()}}
    (OUT_ROOT / "score_report.json").write_text(json.dumps(report, indent=2))
    with (OUT_ROOT / "scores.jsonl").open("a") as fh:
        fh.write(json.dumps({"ts": report["ts"], "model": report["model"], **report["overall"],
                             "docs": len(results)}) + "\n")


if __name__ == "__main__":
    main()
