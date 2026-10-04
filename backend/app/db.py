"""Database engine, data directory, and session dependency.

SQLite file + uploaded/generated files live under DATA_DIR (env var; default backend/data, gitignored).
In Docker, DATA_DIR points at the persistent volume.
"""

import os
from pathlib import Path

from sqlalchemy import text
from sqlmodel import Session, SQLModel, create_engine

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

engine = create_engine(f"sqlite:///{DATA_DIR / 'dockmaster.db'}", connect_args={"check_same_thread": False})


def envelope_dir(envelope_id: int) -> Path:
    d = DATA_DIR / "envelopes" / str(envelope_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def init_db() -> None:
    from . import models  # noqa: F401  (register tables)

    SQLModel.metadata.create_all(engine)
    _add_missing_columns()


# Columns added after the first release. create_all never alters existing tables, so add them by hand.
NEW_COLUMNS = {"field": {"group_id": "VARCHAR"}}


def _add_missing_columns() -> None:
    with engine.begin() as conn:
        for table, cols in NEW_COLUMNS.items():
            have = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            for name, sqltype in cols.items():
                if name not in have:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sqltype}"))


def get_session():
    with Session(engine) as session:
        yield session
