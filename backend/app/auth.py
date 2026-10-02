"""Email + password accounts with a server-side session in an httpOnly cookie.

Passwords use PBKDF2-SHA256 from the standard library (no extra dependency). Not hardened (out of scope).
"""

import hashlib
import hmac
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlmodel import Session, select

from .db import get_session
from .models import AuthSession, User

COOKIE = "dm_session"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
router = APIRouter(prefix="/api/auth", tags=["auth"])


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    salt, digest = stored.split("$", 1)
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
    return hmac.compare_digest(check, digest)


def current_user(request: Request, db: Session = Depends(get_session)) -> User:
    token = request.cookies.get(COOKIE)
    sess = db.get(AuthSession, token) if token else None
    user = db.get(User, sess.user_id) if sess else None
    if not user:
        raise HTTPException(401, "Please sign in")
    return user


class Credentials(BaseModel):
    email: str
    password: str


def _start_session(db: Session, user: User, response: Response) -> dict:
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(token=token, user_id=user.id))
    db.commit()
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", max_age=30 * 24 * 3600)
    return {"id": user.id, "email": user.email}


@router.post("/signup")
def signup(body: Credentials, response: Response, db: Session = Depends(get_session)):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Enter a valid email address")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    if db.exec(select(User).where(User.email == email)).first():
        raise HTTPException(409, "An account with this email already exists. Sign in instead.")
    user = User(email=email, password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return _start_session(db, user, response)


@router.post("/login")
def login(body: Credentials, response: Response, db: Session = Depends(get_session)):
    user = db.exec(select(User).where(User.email == body.email.strip().lower())).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Email or password is incorrect")
    return _start_session(db, user, response)


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_session)):
    token = request.cookies.get(COOKIE)
    if token and (sess := db.get(AuthSession, token)):
        db.delete(sess)
        db.commit()
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return {"id": user.id, "email": user.email}
