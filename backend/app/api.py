"""FastAPI app: JSON API under /api, page images, PDFs, and (in production) the built frontend.

Run (dev):  uv run uvicorn app.api:app --app-dir backend --reload
The backend never renders HTML; the SPA is served as static files with an index.html fallback.
"""

from __future__ import annotations

import re
import secrets
from contextlib import asynccontextmanager
import shutil
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlmodel import Session, select

from . import auth
from .auth import EMAIL_RE, current_user
from .db import envelope_dir, get_session, init_db
from .models import Envelope, FieldRow, OutboxEmail, Signer, User, now
from .outbox import notify
from .pipeline.extract import extract
from .pipeline.place import fallback_proposal, place
from .pipeline.propose import propose
from .pipeline.stamp import stamp

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=True)

FIELD_TYPES = {"signature", "initials", "date", "text", "checkbox"}
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="DockMaster API", lifespan=lifespan)
app.include_router(auth.router)


# ---------- helpers ----------


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _own_envelope(db: Session, envelope_id: int, user: User) -> Envelope:
    env = db.get(Envelope, envelope_id)
    if not env or env.owner_id != user.id:
        raise HTTPException(404, "Envelope not found")
    return env


def _signers(db: Session, env_id: int) -> list[Signer]:
    return list(db.exec(select(Signer).where(Signer.envelope_id == env_id).order_by(Signer.order, Signer.id)))


def _fields(db: Session, env_id: int) -> list[FieldRow]:
    return list(db.exec(select(FieldRow).where(FieldRow.envelope_id == env_id).order_by(FieldRow.page, FieldRow.id)))


def _pages(env: Envelope, base: str) -> list[dict]:
    return [{**{k: p[k] for k in ("n", "width", "height", "rotation", "text_layer")},
             "image_url": f"{base}/pages/{p['n']}.png"} for p in env.document.get("pages", [])]


def _signer_json(s: Signer) -> dict:
    return {"id": s.key, "party_id": s.party_id, "label": s.label, "role": s.role, "name": s.name,
            "email": s.email, "is_self": s.is_self, "order": s.order, "required": s.required,
            "confidence": s.confidence, "reason": s.reason, "source": s.source, "status": s.status,
            "signed_at": _iso(s.signed_at)}


def _field_json(f: FieldRow) -> dict:
    return {"id": f.key, "signer_id": f.signer_key, "filled_by": f.filled_by, "type": f.type, "label": f.label,
            "description": f.description, "page": f.page, "bbox": f.bbox, "required": f.required,
            "candidate_id": f.candidate_id, "placement": f.placement, "confidence": f.confidence,
            "reason": f.reason, "source": f.source, "value": f.value}


def _counts(db: Session, env_id: int) -> tuple[int, int]:
    signers = _signers(db, env_id)
    return sum(s.status == "signed" for s in signers), len(signers)


def _detail(db: Session, env: Envelope) -> dict:
    d = env.document
    signed, total = _counts(db, env.id)
    return {
        "id": env.id, "filename": env.filename, "status": env.status, "created_at": _iso(env.created_at),
        "sent_at": _iso(env.sent_at), "completed_at": _iso(env.completed_at),
        "doc_type": d.get("doc_type"), "summary": d.get("summary"),
        "pages": _pages(env, f"/api/envelopes/{env.id}"),
        "parties": d.get("parties", []),
        "signers": [_signer_json(s) for s in _signers(db, env.id)],
        "fields": [_field_json(f) for f in _fields(db, env.id)],
        "rejected": env.rejected,
        "missing_fields": d.get("missing_fields", []),
        "warnings": d.get("warnings", []),
        "ai": {"ok": d.get("meta", {}).get("error") is None, **{k: d.get("meta", {}).get(k)
                                                                  for k in ("model", "cost_usd", "duration_ms")}},
        "signed_count": signed, "signer_count": total,
    }


def _store_proposal(db: Session, env: Envelope, ex, proposal: dict) -> None:
    cands = {c.id: c for c in ex.candidates}
    roles = {p["id"]: p["role"] for p in proposal["parties"]}
    doc = proposal["document"]
    env.document = {
        "doc_type": doc["doc_type"], "summary": doc.get("summary", ""),
        "pages": [{k: p[k] for k in ("n", "width", "height", "rotation", "text_layer")} for p in doc["pages"]],
        "parties": proposal["parties"], "warnings": proposal["warnings"],
        "missing_fields": proposal["missing_fields"], "meta": proposal["meta"],
    }
    env.rejected = [{"candidate_id": r["candidate_id"], "page": cands[r["candidate_id"]].page,
                     "bbox": cands[r["candidate_id"]].bbox, "reason": r["reason"],
                     "label": cands[r["candidate_id"]].left_label or cands[r["candidate_id"]].above_label or ""}
                    for r in proposal["rejected_candidates"] if r["candidate_id"] in cands]
    for s in proposal["signers"]:
        db.add(Signer(envelope_id=env.id, key=s["id"], party_id=s["party_id"], label=s["label"],
                      role=roles.get(s["party_id"], ""), order=s["order"], required=s["required"],
                      confidence=s["confidence"], reason=s["reason"]))
    for f in proposal["fields"]:
        db.add(FieldRow(envelope_id=env.id, key=f["id"], signer_key=f["signer_id"], filled_by=f["filled_by"],
                        type=f["type"], label=f["label"], description=f["description"], page=f["page"],
                        bbox=f["bbox"], required=f["required"], candidate_id=f["candidate_id"],
                        placement=f["placement"], confidence=f["confidence"], reason=f["reason"]))


# ---------- envelopes ----------


@app.get("/api/envelopes")
def list_envelopes(user: User = Depends(current_user), db: Session = Depends(get_session)):
    envs = db.exec(select(Envelope).where(Envelope.owner_id == user.id).order_by(Envelope.created_at.desc()))
    out = []
    for e in envs:
        signed, total = _counts(db, e.id)
        out.append({"id": e.id, "filename": e.filename, "status": e.status, "created_at": _iso(e.created_at),
                    "signed_count": signed, "signer_count": total})
    return out


@app.post("/api/envelopes")
def create_envelope(file: UploadFile = File(...), user: User = Depends(current_user),
                    db: Session = Depends(get_session)):
    name = Path(file.filename or "document.pdf").name
    if not name.lower().endswith(".pdf"):
        raise HTTPException(400, "Please upload a PDF file")
    env = Envelope(owner_id=user.id, filename=name, pdf_path="")
    db.add(env)
    db.commit()
    db.refresh(env)
    folder = envelope_dir(env.id)
    pdf_path = folder / "source.pdf"
    with pdf_path.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)
    env.pdf_path = str(pdf_path)

    try:
        ex = extract(pdf_path, image_dir=folder / "pages")
    except ValueError as e:  # password-protected, damaged, not a PDF, no pages
        db.delete(env)
        db.commit()
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(400, str(e))
    try:
        proposal = place(ex, propose(ex))
    except Exception as e:  # AI failure must not lose the upload: fall back to a manual draft
        print(f"[api] AI step failed for envelope {env.id}: {e!r}", file=sys.stderr)
        proposal = fallback_proposal(ex, e.__class__.__name__)
    _store_proposal(db, env, ex, proposal)
    db.add(env)
    db.commit()
    db.refresh(env)
    return _detail(db, env)


@app.get("/api/envelopes/{envelope_id}")
def get_envelope(envelope_id: int, user: User = Depends(current_user), db: Session = Depends(get_session)):
    return _detail(db, _own_envelope(db, envelope_id, user))


@app.delete("/api/envelopes/{envelope_id}")
def delete_envelope(envelope_id: int, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """Delete an envelope in any state: its rows, its outbox entries and its files (PDF, page images, signed PDF).
    Signing links for it stop working (they return "not valid")."""
    env = _own_envelope(db, envelope_id, user)
    for row in [*_signers(db, env.id), *_fields(db, env.id),
                *db.exec(select(OutboxEmail).where(OutboxEmail.envelope_id == env.id))]:
        db.delete(row)
    db.delete(env)
    db.commit()
    shutil.rmtree(envelope_dir(envelope_id), ignore_errors=True)
    return {"ok": True}


@app.get("/api/envelopes/{envelope_id}/pages/{n}.png")
def envelope_page(envelope_id: int, n: int, user: User = Depends(current_user), db: Session = Depends(get_session)):
    env = _own_envelope(db, envelope_id, user)
    path = envelope_dir(env.id) / "pages" / f"{n}.png"
    if not path.exists():
        raise HTTPException(404, "Page not found")
    return FileResponse(path, media_type="image/png")


class SignerIn(BaseModel):
    id: str
    party_id: str | None = None
    label: str = ""
    role: str = ""
    name: str | None = None
    email: str | None = None
    is_self: bool = False
    order: int = 1
    required: bool = True
    confidence: float | None = None
    reason: str = ""
    source: str = "ai"


class FieldIn(BaseModel):
    id: str
    signer_id: str | None = None
    filled_by: str = "signer"
    type: str
    label: str = ""
    description: str = ""
    page: int
    bbox: list[float]
    required: bool = True
    candidate_id: str | None = None
    placement: str = "user"
    confidence: float | None = None
    reason: str = ""
    source: str = "user"
    value: str | None = None


class RejectedIn(BaseModel):
    candidate_id: str
    page: int
    bbox: list[float]
    label: str = ""
    reason: str = ""


class DraftIn(BaseModel):
    signers: list[SignerIn]
    fields: list[FieldIn]
    rejected: list[RejectedIn] = []


@app.put("/api/envelopes/{envelope_id}")
def save_draft(envelope_id: int, body: DraftIn, user: User = Depends(current_user), db: Session = Depends(get_session)):
    env = _own_envelope(db, envelope_id, user)
    if env.status != "draft":
        raise HTTPException(409, "This envelope has been sent and can no longer be edited")
    signer_keys = [s.id for s in body.signers]
    if len(set(signer_keys)) != len(signer_keys) or len({f.id for f in body.fields}) != len(body.fields):
        raise HTTPException(400, "Duplicate signer or field id")
    n_pages = len(env.document.get("pages", []))
    for f in body.fields:
        if f.type not in FIELD_TYPES:
            raise HTTPException(400, f"Unknown field type '{f.type}'")
        if f.filled_by not in ("signer", "sender"):
            raise HTTPException(400, f"Field {f.id}: filled_by must be 'signer' or 'sender'")
        if f.signer_id is not None and f.signer_id not in signer_keys:
            raise HTTPException(400, f"Field {f.id} refers to unknown signer {f.signer_id}")
        if not 1 <= f.page <= n_pages or len(f.bbox) != 4 or f.bbox[2] <= f.bbox[0] or f.bbox[3] <= f.bbox[1]:
            raise HTTPException(400, f"Field {f.id} has an invalid page or box")

    for row in _signers(db, env.id) + _fields(db, env.id):
        db.delete(row)
    for s in body.signers:
        db.add(Signer(envelope_id=env.id, key=s.id, party_id=s.party_id, label=s.label, role=s.role,
                      name=(s.name or "").strip() or None, email=(s.email or "").strip().lower() or None,
                      is_self=s.is_self, order=s.order, required=s.required, confidence=s.confidence,
                      reason=s.reason, source=s.source))
    for f in body.fields:
        db.add(FieldRow(envelope_id=env.id, key=f.id, signer_key=f.signer_id if f.filled_by == "signer" else None,
                        filled_by=f.filled_by, type=f.type, label=f.label, description=f.description, page=f.page,
                        bbox=f.bbox, required=f.required, candidate_id=f.candidate_id, placement=f.placement,
                        confidence=f.confidence, reason=f.reason, source=f.source,
                        value=f.value if f.filled_by == "sender" else None))
    env.rejected = [r.model_dump() for r in body.rejected]
    db.add(env)
    db.commit()
    return _detail(db, env)


def send_problems(signers: list[Signer], fields: list[FieldRow]) -> list[str]:
    """Hard rules the backend enforces. The UI shows the same list, plus soft warnings of its own."""
    problems = []
    if not signers:
        problems.append("Add at least one signer")
    for s in signers:
        who = s.label or s.key
        if not s.name:
            problems.append(f"{who}: enter a name")
        if not s.email or not EMAIL_RE.match(s.email):
            problems.append(f"{who}: enter a valid email")
    keys = {s.key for s in signers}
    unassigned = [f for f in fields if f.filled_by == "signer" and f.signer_key not in keys]
    if unassigned:
        problems.append(f"{len(unassigned)} field(s) have no signer")
    empty_sender = [f for f in fields if f.filled_by == "sender" and f.required and not (f.value or "").strip()]
    if empty_sender:
        problems.append(f"{len(empty_sender)} field(s) you fill before sending are empty")
    return problems


def _notify_next(db: Session, env: Envelope, signers: list[Signer], sender_email: str) -> None:
    """Notify every unsigned signer in the lowest signing-order group that hasn't been notified yet."""
    waiting = [s for s in signers if s.status != "signed"]
    if not waiting:
        return
    group = min(s.order for s in waiting)
    for s in waiting:
        if s.order == group and s.status == "pending":
            s.status = "notified"
            db.add(s)
            notify(db, env, s.email, "your_turn", f"Please sign: {env.filename}",
                   f"{sender_email} sent you \"{env.filename}\" to sign as {s.label}. Open the link to review and sign.",
                   link=f"/sign/{s.token}")


@app.post("/api/envelopes/{envelope_id}/send")
def send_envelope(envelope_id: int, user: User = Depends(current_user), db: Session = Depends(get_session)):
    env = _own_envelope(db, envelope_id, user)
    if env.status != "draft":
        raise HTTPException(409, "This envelope has already been sent")
    signers, fields = _signers(db, env.id), _fields(db, env.id)
    problems = send_problems(signers, fields)
    if problems:
        raise HTTPException(400, {"message": "Not ready to send", "problems": problems})
    for s in signers:
        s.token = secrets.token_urlsafe(24)
        s.status = "pending"
        db.add(s)
    env.status, env.sent_at = "sent", now()
    db.add(env)
    notify(db, env, user.email, "sent", f"Sent: {env.filename}",
           f"You sent \"{env.filename}\" to " + ", ".join(f"{s.name} <{s.email}>" for s in signers) + ".",
           link=f"/envelopes/{env.id}")
    _notify_next(db, env, signers, user.email)
    db.commit()
    me = next((s for s in signers if s.is_self and s.status == "notified"), None)
    return {"status": env.status, "self_sign_token": me.token if me else None}


@app.get("/api/envelopes/{envelope_id}/status")
def envelope_status(envelope_id: int, user: User = Depends(current_user), db: Session = Depends(get_session)):
    env = _own_envelope(db, envelope_id, user)
    entries = db.exec(select(OutboxEmail).where(OutboxEmail.envelope_id == env.id).order_by(OutboxEmail.created_at))
    signed, total = _counts(db, env.id)
    return {"id": env.id, "filename": env.filename, "status": env.status, "sent_at": _iso(env.sent_at),
            "completed_at": _iso(env.completed_at), "signed_count": signed, "signer_count": total,
            "final_pdf_url": f"/api/envelopes/{env.id}/final.pdf" if env.final_pdf_path else None,
            "signers": [{k: v for k, v in _signer_json(s).items() if k in
                         ("id", "label", "role", "name", "email", "is_self", "order", "status", "signed_at")}
                        | {"sign_url": f"/sign/{s.token}" if s.is_self and s.token and s.status != "signed" else None}
                        for s in _signers(db, env.id)],
            "outbox": [_outbox_json(o) for o in entries]}


@app.get("/api/envelopes/{envelope_id}/final.pdf")
def envelope_final(envelope_id: int, user: User = Depends(current_user), db: Session = Depends(get_session)):
    env = _own_envelope(db, envelope_id, user)
    if not env.final_pdf_path:
        raise HTTPException(404, "The signed PDF is available once everyone has signed")
    return FileResponse(env.final_pdf_path, media_type="application/pdf", filename=_signed_name(env.filename))


def _signed_name(filename: str) -> str:
    return re.sub(r"\.pdf$", "", filename, flags=re.I) + " (signed).pdf"


# ---------- signing (no login; the token is the credential) ----------


def _by_token(db: Session, token: str) -> tuple[Signer, Envelope]:
    s = db.exec(select(Signer).where(Signer.token == token)).first()
    env = db.get(Envelope, s.envelope_id) if s else None
    if not s or not env or env.status == "draft":
        raise HTTPException(404, "This signing link is not valid")
    return s, env


@app.get("/api/sign/{token}")
def signing_view(token: str, db: Session = Depends(get_session)):
    s, env = _by_token(db, token)
    owner = db.get(User, env.owner_id)
    fields = _fields(db, env.id)
    return {
        "envelope": {"filename": env.filename, "doc_type": env.document.get("doc_type"), "status": env.status,
                     "sender_email": owner.email if owner else None},
        "signer": {"id": s.key, "label": s.label, "name": s.name, "email": s.email, "status": s.status,
                   "signed_at": _iso(s.signed_at)},
        "can_sign": s.status == "notified",
        "waiting_for_others": s.status == "pending",
        "pages": _pages(env, f"/api/sign/{token}"),
        "fields": [_field_json(f) | {"value": f.value} for f in fields if f.signer_key == s.key],
        "others": [{"page": f.page, "bbox": f.bbox, "type": f.type} for f in fields
                   if f.signer_key != s.key and f.filled_by == "signer"],
        "prefilled": [{"page": f.page, "bbox": f.bbox, "type": f.type, "value": f.value} for f in fields
                      if f.filled_by == "sender" and f.value],
        "final_pdf_url": f"/api/sign/{token}/final.pdf" if env.final_pdf_path else None,
    }


@app.get("/api/sign/{token}/pages/{n}.png")
def signing_page(token: str, n: int, db: Session = Depends(get_session)):
    s, env = _by_token(db, token)
    path = envelope_dir(env.id) / "pages" / f"{n}.png"
    if not path.exists():
        raise HTTPException(404, "Page not found")
    return FileResponse(path, media_type="image/png")


class SignIn(BaseModel):
    values: dict[str, str | None]


@app.post("/api/sign/{token}")
def submit_signature(token: str, body: SignIn, db: Session = Depends(get_session)):
    s, env = _by_token(db, token)
    if s.status == "signed":
        raise HTTPException(409, "You have already signed this document")
    if s.status != "notified":
        raise HTTPException(409, "It isn't your turn to sign yet")
    mine = [f for f in _fields(db, env.id) if f.signer_key == s.key]
    missing = []
    for f in mine:
        v = (body.values.get(f.key) or "").strip()
        if f.type in ("signature", "initials") and v and not v.startswith("data:image/png;base64,"):
            raise HTTPException(400, f"{f.label or f.type}: signature must be a PNG image")
        if f.type == "checkbox":
            v = "true" if v == "true" else "false"
        if f.required and f.type != "checkbox" and not v:  # a checkbox's answer is checked or unchecked
            missing.append(f.label or f.type)
        f.value = v or None
        db.add(f)
    if missing:
        raise HTTPException(400, {"message": "Some required fields are empty", "problems": missing})
    s.status, s.signed_at = "signed", now()
    db.add(s)
    owner = db.get(User, env.owner_id)
    notify(db, env, owner.email, "signed", f"{s.name or s.label} signed {env.filename}",
           f"{s.name} <{s.email}> signed \"{env.filename}\".", link=f"/envelopes/{env.id}")
    db.commit()

    signers = _signers(db, env.id)
    if all(x.status == "signed" for x in signers):
        out = envelope_dir(env.id) / "final.pdf"
        stamp(env.pdf_path, [_field_json(f) for f in _fields(db, env.id)], out)
        env.status, env.completed_at, env.final_pdf_path = "completed", now(), str(out)
        db.add(env)
        body_text = f"Everyone has signed \"{env.filename}\". The completed PDF is ready to download."
        notify(db, env, owner.email, "completed", f"Completed: {env.filename}", body_text, link=f"/envelopes/{env.id}")
        for x in signers:
            notify(db, env, x.email, "completed", f"Completed: {env.filename}", body_text, link=f"/sign/{x.token}")
    else:
        _notify_next(db, env, signers, owner.email)
    db.commit()
    return {"status": "signed", "envelope_status": env.status}


@app.get("/api/sign/{token}/final.pdf")
def signing_final(token: str, db: Session = Depends(get_session)):
    s, env = _by_token(db, token)
    if not env.final_pdf_path:
        raise HTTPException(404, "The signed PDF is available once everyone has signed")
    return FileResponse(env.final_pdf_path, media_type="application/pdf", filename=_signed_name(env.filename))


# ---------- outbox ----------


def _outbox_json(o: OutboxEmail) -> dict:
    return {"id": o.id, "envelope_id": o.envelope_id, "to": o.to, "subject": o.subject, "body": o.body,
            "event": o.event, "link": o.link, "created_at": _iso(o.created_at)}


@app.get("/api/outbox")
def outbox(user: User = Depends(current_user), db: Session = Depends(get_session)):
    rows = db.exec(select(OutboxEmail).where(OutboxEmail.owner_id == user.id).order_by(OutboxEmail.created_at.desc()))
    return [_outbox_json(o) for o in rows]


# ---------- built frontend (production) ----------

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        file = FRONTEND_DIST / path
        return FileResponse(file if path and file.is_file() else FRONTEND_DIST / "index.html")
