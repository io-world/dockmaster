"""SQLModel tables.

Signers and fields keep a string `key` ("s1", "f12", or a client-made id for new ones) that is unique within an
envelope. The API speaks in keys; integer primary keys never leave the server. Fields reference signers by key.
All bboxes are PyMuPDF points, origin top-left, display space (page rotation applied).
"""

from datetime import datetime, timezone

from sqlalchemy import Column
from sqlalchemy.types import JSON
from sqlmodel import Field, SQLModel


def now() -> datetime:
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(index=True, unique=True)
    password_hash: str
    created_at: datetime = Field(default_factory=now)


class AuthSession(SQLModel, table=True):
    token: str = Field(primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    created_at: datetime = Field(default_factory=now)


class Envelope(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    filename: str
    pdf_path: str
    status: str = "draft"  # draft -> sent -> completed
    created_at: datetime = Field(default_factory=now)
    sent_at: datetime | None = None
    completed_at: datetime | None = None
    final_pdf_path: str | None = None
    # Pipeline output that isn't edited row-by-row: pages, doc_type, summary, parties, warnings, missing, meta.
    document: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # Candidates the AI (or the sender) decided are not fields: {candidate_id, page, bbox, label, reason}.
    rejected: list = Field(default_factory=list, sa_column=Column(JSON))


class Signer(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    envelope_id: int = Field(foreign_key="envelope.id", index=True)
    key: str
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
    token: str | None = Field(default=None, index=True)
    status: str = "pending"  # pending -> notified -> signed
    signed_at: datetime | None = None


class FieldRow(SQLModel, table=True):
    __tablename__ = "field"
    id: int | None = Field(default=None, primary_key=True)
    envelope_id: int = Field(foreign_key="envelope.id", index=True)
    key: str
    signer_key: str | None = None
    filled_by: str = "signer"  # signer | sender
    type: str = "text"  # signature | initials | date | text | checkbox
    label: str = ""
    description: str = ""
    page: int = 1
    bbox: list = Field(default_factory=list, sa_column=Column(JSON))
    required: bool = True
    candidate_id: str | None = None
    placement: str = "user"  # widget | line | underscore | label_offset | checkbox | user
    confidence: float | None = None
    reason: str = ""
    source: str = "ai"  # ai | user
    value: str | None = None  # text/date: the text; checkbox: "true"/"false"; signature/initials: PNG data URL


class OutboxEmail(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)  # whose outbox this appears in
    envelope_id: int = Field(foreign_key="envelope.id", index=True)
    to: str
    subject: str
    body: str
    event: str  # sent | your_turn | signed | completed
    link: str | None = None  # app path, e.g. /sign/<token>
    created_at: datetime = Field(default_factory=now)
