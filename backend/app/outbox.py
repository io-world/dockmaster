"""Notification log. No real email: entries are shown in the app's Outbox, with working signing links."""

from sqlmodel import Session

from .models import Envelope, OutboxEmail


def notify(db: Session, env: Envelope, to: str, event: str, subject: str, body: str, link: str | None = None) -> None:
    db.add(OutboxEmail(owner_id=env.owner_id, envelope_id=env.id, to=to, subject=subject, body=body,
                       event=event, link=link))
