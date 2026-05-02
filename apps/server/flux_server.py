from __future__ import annotations

import argparse
import csv
import io
import json
import mimetypes
import re
import sqlite3
import uuid
from datetime import UTC, date, datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data" / "flux.db"
DEFAULT_STATIC = ROOT / "apps" / "client" / "web"
ATTACHMENTS_ROOT = ROOT / "data" / "attachments"
DISPLAY_TIMEZONE = timezone(timedelta(hours=8))
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
ALLOWED_ATTACHMENT_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".mp3",
    ".wav",
    ".ogg",
    ".m4a",
    ".pdf",
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".zip",
    ".rar",
    ".7z",
}


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def display_time_label(value: str) -> str:
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return str(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(DISPLAY_TIMEZONE).strftime("%Y-%m-%d %H:%M")


def new_id() -> str:
    return str(uuid.uuid4())


def first(query: dict[str, list[str]], key: str, default: str | None = None) -> str | None:
    values = query.get(key)
    return values[0] if values else default


def parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    return value.lower() in {"1", "true", "yes", "on"}


def normalize_todo_priority(value: Any, is_important: Any = False) -> str:
    important = is_important.lower() in {"1", "true", "yes", "on"} if isinstance(is_important, str) else bool(is_important)
    return "high" if value == "high" or important else "normal"


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


class FluxRepository:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _init_db(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS diaries (
                    id TEXT PRIMARY KEY,
                    entry_date TEXT NOT NULL,
                    entry_time TEXT,
                    title TEXT NOT NULL,
                    content_md TEXT NOT NULL DEFAULT '',
                    mood TEXT,
                    weather TEXT,
                    location_name TEXT,
                    is_favorite INTEGER NOT NULL DEFAULT 0,
                    word_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_diaries_date ON diaries(entry_date, deleted_at);
                CREATE INDEX IF NOT EXISTS idx_diaries_mood ON diaries(mood, deleted_at);

                CREATE TABLE IF NOT EXISTS diary_tags (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    color TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS diary_tag_links (
                    diary_id TEXT NOT NULL,
                    tag_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    deleted_at TEXT,
                    PRIMARY KEY(diary_id, tag_id),
                    FOREIGN KEY(diary_id) REFERENCES diaries(id),
                    FOREIGN KEY(tag_id) REFERENCES diary_tags(id)
                );
                CREATE INDEX IF NOT EXISTS idx_diary_tag_links_tag ON diary_tag_links(tag_id, deleted_at);

                CREATE TABLE IF NOT EXISTS todo_projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS todos (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending',
                    priority TEXT NOT NULL DEFAULT 'normal',
                    due_at TEXT,
                    start_at TEXT,
                    completed_at TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    is_important INTEGER NOT NULL DEFAULT 0,
                    reminder_minutes INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1,
                    FOREIGN KEY(project_id) REFERENCES todo_projects(id)
                );
                CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at, status, deleted_at);
                CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status, deleted_at);
                CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id, deleted_at);

                CREATE TABLE IF NOT EXISTS todo_subtasks (
                    id TEXT PRIMARY KEY,
                    todo_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    is_completed INTEGER NOT NULL DEFAULT 0,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1,
                    FOREIGN KEY(todo_id) REFERENCES todos(id)
                );

                CREATE TABLE IF NOT EXISTS todo_history (
                    id TEXT PRIMARY KEY,
                    todo_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(todo_id) REFERENCES todos(id)
                );
                CREATE INDEX IF NOT EXISTS idx_todo_history_todo ON todo_history(todo_id, created_at);

                CREATE TABLE IF NOT EXISTS calendar_events (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    start_at TEXT NOT NULL,
                    end_at TEXT NOT NULL,
                    all_day INTEGER NOT NULL DEFAULT 0,
                    color TEXT,
                    location_name TEXT,
                    reminder_minutes INTEGER,
                    recurrence_rule TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_events_start ON calendar_events(start_at, deleted_at);
                CREATE INDEX IF NOT EXISTS idx_events_range ON calendar_events(start_at, end_at, deleted_at);

                CREATE TABLE IF NOT EXISTS calendar_holidays (
                    day TEXT PRIMARY KEY,
                    is_holiday INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS calendar_static_holidays (
                    day TEXT PRIMARY KEY,
                    is_holiday INTEGER NOT NULL DEFAULT 1,
                    name TEXT,
                    source TEXT NOT NULL DEFAULT 'chinese-days',
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_outbox (
                    id TEXT PRIMARY KEY,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    base_version INTEGER,
                    created_at TEXT NOT NULL,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    status TEXT NOT NULL DEFAULT 'pending'
                );
                """
            )
            self._ensure_columns(conn)
            self._seed_projects(conn)

    def _ensure_columns(self, conn: sqlite3.Connection) -> None:
        todo_columns = {row["name"] for row in conn.execute("PRAGMA table_info(todos)").fetchall()}
        if "is_important" not in todo_columns:
            conn.execute("ALTER TABLE todos ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0")
        if "reminder_minutes" not in todo_columns:
            conn.execute("ALTER TABLE todos ADD COLUMN reminder_minutes INTEGER")
        diary_columns = {row["name"] for row in conn.execute("PRAGMA table_info(diaries)").fetchall()}
        if "entry_time" not in diary_columns:
            conn.execute("ALTER TABLE diaries ADD COLUMN entry_time TEXT")
        if "restored_at" not in diary_columns:
            conn.execute("ALTER TABLE diaries ADD COLUMN restored_at TEXT")
        if "restored_into_id" not in diary_columns:
            conn.execute("ALTER TABLE diaries ADD COLUMN restored_into_id TEXT")
        holiday_columns = {row["name"] for row in conn.execute("PRAGMA table_info(calendar_holidays)").fetchall()}
        if "is_holiday" not in holiday_columns:
            conn.execute("ALTER TABLE calendar_holidays ADD COLUMN is_holiday INTEGER NOT NULL DEFAULT 1")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS calendar_static_holidays (
                day TEXT PRIMARY KEY,
                is_holiday INTEGER NOT NULL DEFAULT 1,
                name TEXT,
                source TEXT NOT NULL DEFAULT 'chinese-days',
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS diaries_fts USING fts5(
                diary_id UNINDEXED,
                entry_date,
                entry_time,
                content_md,
                mood,
                weather,
                location_name,
                tags,
                tokenize='unicode61'
            )
            """
        )
        self._dedupe_diaries(conn)
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_diaries_one_active_per_day
            ON diaries(entry_date)
            WHERE deleted_at IS NULL
            """
        )
        self._rebuild_diary_fts(conn)

    def _dedupe_diaries(self, conn: sqlite3.Connection) -> None:
        duplicate_days = conn.execute(
            """
            SELECT entry_date
            FROM diaries
            WHERE deleted_at IS NULL
            GROUP BY entry_date
            HAVING COUNT(*) > 1
            """
        ).fetchall()
        if not duplicate_days:
            return
        removed_at = now_iso()
        for row in duplicate_days:
            diaries = conn.execute(
                """
                SELECT id
                FROM diaries
                WHERE entry_date = ? AND deleted_at IS NULL
                ORDER BY updated_at DESC, created_at DESC, id DESC
                """,
                (row["entry_date"],),
            ).fetchall()
            keep_id = diaries[0]["id"]
            remove_ids = [item["id"] for item in diaries[1:]]
            if not remove_ids:
                continue
            conn.executemany(
                "UPDATE diaries SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
                [(removed_at, removed_at, item_id) for item_id in remove_ids],
            )
            self._enqueue(
                conn,
                "diary",
                keep_id,
                "dedupe",
                {"entry_date": row["entry_date"], "kept_id": keep_id, "removed_ids": remove_ids},
                None,
            )

    def _fts_query(self, keyword: str) -> str:
        terms = [term.strip() for term in str(keyword or "").split() if term.strip()]
        if not terms and str(keyword or "").strip():
            terms = [str(keyword).strip()]
        phrases = []
        for term in terms:
            escaped = term.replace('"', '""')
            phrases.append(f'"{escaped}"')
        return " ".join(phrases)

    def _rebuild_diary_fts(self, conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM diaries_fts")
        rows = conn.execute("SELECT id FROM diaries WHERE deleted_at IS NULL").fetchall()
        for row in rows:
            self._refresh_diary_fts(conn, row["id"])

    def _delete_diary_fts(self, conn: sqlite3.Connection, diary_id: str) -> None:
        conn.execute("DELETE FROM diaries_fts WHERE diary_id = ?", (diary_id,))

    def _refresh_diary_fts(self, conn: sqlite3.Connection, diary_id: str) -> None:
        self._delete_diary_fts(conn, diary_id)
        row = conn.execute(
            """
            SELECT
                d.id,
                d.entry_date,
                d.entry_time,
                d.content_md,
                d.mood,
                d.weather,
                d.location_name,
                COALESCE(GROUP_CONCAT(t.name, ' '), '') AS tags
            FROM diaries d
            LEFT JOIN diary_tag_links dtl
              ON dtl.diary_id = d.id AND dtl.deleted_at IS NULL
            LEFT JOIN diary_tags t
              ON t.id = dtl.tag_id AND t.deleted_at IS NULL
            WHERE d.id = ? AND d.deleted_at IS NULL
            GROUP BY d.id
            """,
            (diary_id,),
        ).fetchone()
        if row is None:
            return
        conn.execute(
            """
            INSERT INTO diaries_fts
                (diary_id, entry_date, entry_time, content_md, mood, weather, location_name, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                row["entry_date"] or "",
                row["entry_time"] or "",
                row["content_md"] or "",
                row["mood"] or "",
                row["weather"] or "",
                row["location_name"] or "",
                row["tags"] or "",
            ),
        )

    def _seed_projects(self, conn: sqlite3.Connection) -> None:
        existing = conn.execute("SELECT COUNT(*) AS count FROM todo_projects").fetchone()["count"]
        if existing:
            return
        created = now_iso()
        for order, (name, color) in enumerate(
            [("工作", "#4dabf7"), ("个人", "#51cf66"), ("学习", "#ffd43b"), ("健康", "#ff8787")]
        ):
            conn.execute(
                "INSERT INTO todo_projects (id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (new_id(), name, color, order, created, created),
            )

    def _enqueue(
        self,
        conn: sqlite3.Connection,
        entity_type: str,
        entity_id: str,
        operation: str,
        payload: dict[str, Any],
        base_version: int | None,
    ) -> None:
        conn.execute(
            """
            INSERT INTO sync_outbox
                (id, entity_type, entity_id, operation, payload_json, base_version, created_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
            """,
            (new_id(), entity_type, entity_id, operation, json.dumps(payload, ensure_ascii=False), base_version, now_iso()),
        )

    def _title_from_content(self, content: str) -> str:
        for line in content.splitlines():
            line = line.strip().lstrip("#").strip()
            if line:
                return line[:80]
        return ""

    def _merge_diary_content(self, original: str, addition: str, restored_at: str) -> str:
        original = str(original or "").rstrip()
        addition = str(addition or "").strip()
        if not addition:
            return original
        if not original:
            return addition
        marker = f"\n\n---\n\n合并自回收站：{display_time_label(restored_at)}\n\n"
        return f"{original}{marker}{addition}"

    def _diary_tag_names(self, conn: sqlite3.Connection, diary_id: str) -> list[str]:
        rows = conn.execute(
            """
            SELECT t.name
            FROM diary_tags t
            JOIN diary_tag_links dtl ON dtl.tag_id = t.id
            WHERE dtl.diary_id = ?
              AND dtl.deleted_at IS NULL
              AND t.deleted_at IS NULL
            ORDER BY t.name
            """,
            (diary_id,),
        ).fetchall()
        return [row["name"] for row in rows]

    def _merge_diary_tag_names(self, conn: sqlite3.Connection, primary_id: str, secondary_id: str) -> list[str]:
        names: list[str] = []
        for name in [*self._diary_tag_names(conn, primary_id), *self._diary_tag_names(conn, secondary_id)]:
            if name not in names:
                names.append(name)
        return names

    def list_diaries(self, filters: dict[str, Any]) -> list[dict[str, Any]]:
        clauses = [
            "deleted_at IS NOT NULL AND restored_at IS NULL"
            if filters.get("deleted")
            else "deleted_at IS NULL"
        ]
        params: list[Any] = []
        if filters.get("date_from"):
            clauses.append("entry_date >= ?")
            params.append(filters["date_from"])
        if filters.get("date_to"):
            clauses.append("entry_date <= ?")
            params.append(filters["date_to"])
        if filters.get("mood"):
            clauses.append("mood = ?")
            params.append(filters["mood"])
        if filters.get("tag_id"):
            clauses.append(
                """
                EXISTS (
                    SELECT 1 FROM diary_tag_links dtl
                    WHERE dtl.diary_id = diaries.id
                      AND dtl.tag_id = ?
                      AND dtl.deleted_at IS NULL
                )
                """
            )
            params.append(filters["tag_id"])
        if filters.get("is_favorite") is not None:
            clauses.append("is_favorite = ?")
            params.append(1 if filters["is_favorite"] else 0)
        if filters.get("keyword"):
            like = f"%{filters['keyword']}%"
            clauses.append(
                """
                (
                    id IN (SELECT diary_id FROM diaries_fts WHERE diaries_fts MATCH ?)
                    OR title LIKE ?
                    OR content_md LIKE ?
                    OR entry_date LIKE ?
                    OR entry_time LIKE ?
                    OR mood LIKE ?
                    OR weather LIKE ?
                    OR location_name LIKE ?
                    OR EXISTS (
                        SELECT 1
                        FROM diary_tag_links dtl
                        JOIN diary_tags t ON t.id = dtl.tag_id
                        WHERE dtl.diary_id = diaries.id
                          AND dtl.deleted_at IS NULL
                          AND t.deleted_at IS NULL
                          AND t.name LIKE ?
                    )
                )
                """
            )
            params.extend([self._fts_query(filters["keyword"]), like, like, like, like, like, like, like, like])
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM diaries WHERE {' AND '.join(clauses)} ORDER BY entry_date DESC, updated_at DESC",
                params,
            ).fetchall()
            return [self._diary(conn, row) for row in rows]

    def create_diary(self, payload: dict[str, Any]) -> dict[str, Any]:
        title = str(payload.get("title") or "").strip()
        content = str(payload.get("content_md") or payload.get("content") or "")
        entry_date = str(payload.get("entry_date") or date.today().isoformat())
        entry_time = str(payload.get("entry_time") or "").strip() or None
        if not title:
            title = self._title_from_content(content)
        if not title:
            raise ApiError(400, "VALIDATION_ERROR", "日记标题或正文不能为空")
        created = now_iso()
        item = {
            "id": str(payload.get("id") or new_id()),
            "entry_date": entry_date,
            "entry_time": entry_time,
            "title": title,
            "content_md": content,
            "mood": payload.get("mood"),
            "weather": payload.get("weather"),
            "location_name": payload.get("location_name"),
            "is_favorite": 1 if payload.get("is_favorite") else 0,
            "word_count": len(content.strip()),
            "created_at": created,
            "updated_at": created,
        }
        with self.connect() as conn:
            existing = conn.execute(
                "SELECT * FROM diaries WHERE entry_date = ? AND deleted_at IS NULL",
                (entry_date,),
            ).fetchone()
            if existing is not None:
                return self.update_diary(
                    existing["id"],
                    {
                        "entry_date": entry_date,
                        "entry_time": entry_time,
                        "title": title,
                        "content_md": content,
                        "mood": payload.get("mood"),
                        "weather": payload.get("weather"),
                        "location_name": payload.get("location_name"),
                        "is_favorite": payload.get("is_favorite"),
                        "tag_names": payload.get("tag_names") or payload.get("tags") or [],
                    },
                )
            conn.execute(
                """
                INSERT INTO diaries
                    (id, entry_date, entry_time, title, content_md, mood, weather, location_name,
                     is_favorite, word_count, created_at, updated_at)
                VALUES
                    (:id, :entry_date, :entry_time, :title, :content_md, :mood, :weather, :location_name,
                     :is_favorite, :word_count, :created_at, :updated_at)
                """,
                item,
            )
            self._replace_diary_tags(conn, item["id"], payload.get("tag_names") or payload.get("tags") or [])
            self._refresh_diary_fts(conn, item["id"])
            self._enqueue(conn, "diary", item["id"], "create", item, None)
        return self.get_diary(item["id"])

    def get_diary(self, item_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM diaries WHERE id = ? AND deleted_at IS NULL", (item_id,)).fetchone()
            if row is not None:
                return self._diary(conn, row)
        if row is None:
            raise ApiError(404, "NOT_FOUND", "日记不存在")

    def update_diary(self, item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        current = self.get_diary(item_id)
        merged = {**current, **payload}
        content = str(merged.get("content_md") or "")
        merged["word_count"] = len(content.strip())
        merged["is_favorite"] = 1 if merged.get("is_favorite") else 0
        merged["updated_at"] = now_iso()
        with self.connect() as conn:
            duplicate = conn.execute(
                """
                SELECT id
                FROM diaries
                WHERE entry_date = ? AND deleted_at IS NULL AND id != ?
                """,
                (merged["entry_date"], item_id),
            ).fetchone()
            if duplicate is not None:
                raise ApiError(409, "DIARY_DATE_EXISTS", "这一天已经有一篇日记")
            conn.execute(
                """
                UPDATE diaries
                SET entry_date = ?, entry_time = ?, title = ?, content_md = ?, mood = ?, weather = ?,
                    location_name = ?, is_favorite = ?, word_count = ?, updated_at = ?,
                    version = version + 1
                WHERE id = ? AND deleted_at IS NULL
                """,
                (
                    merged["entry_date"],
                    str(merged.get("entry_time") or "").strip() or None,
                    merged["title"],
                    merged["content_md"],
                    merged.get("mood"),
                    merged.get("weather"),
                    merged.get("location_name"),
                    merged["is_favorite"],
                    merged["word_count"],
                    merged["updated_at"],
                    item_id,
                ),
            )
            if "tag_names" in payload or "tags" in payload:
                self._replace_diary_tags(conn, item_id, payload.get("tag_names") or payload.get("tags") or [])
            self._refresh_diary_fts(conn, item_id)
            self._enqueue(conn, "diary", item_id, "update", merged, current.get("version"))
        return self.get_diary(item_id)

    def delete_diary(self, item_id: str) -> dict[str, Any]:
        current = self.get_diary(item_id)
        deleted = now_iso()
        with self.connect() as conn:
            conn.execute("UPDATE diaries SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", (deleted, deleted, item_id))
            self._delete_diary_fts(conn, item_id)
            self._enqueue(conn, "diary", item_id, "delete", {"id": item_id, "deleted_at": deleted}, current["version"])
        return {"id": item_id, "deleted_at": deleted}

    def restore_diary(self, item_id: str) -> dict[str, Any]:
        restored = now_iso()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM diaries WHERE id = ? AND deleted_at IS NOT NULL AND restored_at IS NULL",
                (item_id,),
            ).fetchone()
            if row is None:
                raise ApiError(404, "NOT_FOUND", "可恢复的日记不存在")
            existing = conn.execute(
                "SELECT * FROM diaries WHERE entry_date = ? AND deleted_at IS NULL",
                (row["entry_date"],),
            ).fetchone()
            if existing is not None:
                merged_content = self._merge_diary_content(existing["content_md"], row["content_md"], restored)
                merged_title = existing["title"] or row["title"] or self._title_from_content(merged_content)
                tag_names = self._merge_diary_tag_names(conn, existing["id"], row["id"])
                conn.execute(
                    """
                    UPDATE diaries
                    SET entry_time = ?, title = ?, content_md = ?, mood = ?, weather = ?,
                        location_name = ?, is_favorite = ?, word_count = ?, updated_at = ?,
                        version = version + 1
                    WHERE id = ? AND deleted_at IS NULL
                    """,
                    (
                        existing["entry_time"] or row["entry_time"],
                        merged_title,
                        merged_content,
                        existing["mood"] or row["mood"],
                        existing["weather"] or row["weather"],
                        existing["location_name"] or row["location_name"],
                        1 if existing["is_favorite"] or row["is_favorite"] else 0,
                        len(merged_content.strip()),
                        restored,
                        existing["id"],
                    ),
                )
                self._replace_diary_tags(conn, existing["id"], tag_names)
                self._refresh_diary_fts(conn, existing["id"])
                self._delete_diary_fts(conn, item_id)
                conn.execute(
                    """
                    UPDATE diaries
                    SET restored_at = ?, restored_into_id = ?, updated_at = ?, version = version + 1
                    WHERE id = ?
                    """,
                    (restored, existing["id"], restored, item_id),
                )
                self._enqueue(
                    conn,
                    "diary",
                    existing["id"],
                    "merge_restore",
                    {"id": existing["id"], "merged_from_id": item_id, "restored_at": restored},
                    existing["version"],
                )
                self._enqueue(
                    conn,
                    "diary",
                    item_id,
                    "restore_into",
                    {"id": item_id, "restored_into_id": existing["id"], "restored_at": restored},
                    row["version"],
                )
                merged = self._diary(conn, conn.execute("SELECT * FROM diaries WHERE id = ?", (existing["id"],)).fetchone())
                merged["restore_mode"] = "merged"
                merged["merged_from_id"] = item_id
                return merged
            conn.execute(
                """
                UPDATE diaries
                SET deleted_at = NULL, restored_at = NULL, restored_into_id = NULL,
                    updated_at = ?, version = version + 1
                WHERE id = ?
                """,
                (restored, item_id),
            )
            self._refresh_diary_fts(conn, item_id)
            self._enqueue(conn, "diary", item_id, "restore", {"id": item_id}, row["version"])
        return self.get_diary(item_id)

    def list_tags(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT t.*, COUNT(dtl.diary_id) AS diary_count
                FROM diary_tags t
                LEFT JOIN diary_tag_links dtl
                  ON dtl.tag_id = t.id AND dtl.deleted_at IS NULL
                WHERE t.deleted_at IS NULL
                GROUP BY t.id
                ORDER BY t.name
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def create_tag(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ApiError(400, "VALIDATION_ERROR", "标签名称不能为空")
        created = now_iso()
        with self.connect() as conn:
            existing = conn.execute("SELECT * FROM diary_tags WHERE name = ? AND deleted_at IS NULL", (name,)).fetchone()
            if existing:
                return dict(existing)
            item = {
                "id": str(payload.get("id") or new_id()),
                "name": name,
                "color": payload.get("color") or "#748ffc",
                "created_at": created,
                "updated_at": created,
            }
            conn.execute(
                "INSERT INTO diary_tags (id, name, color, created_at, updated_at) VALUES (:id, :name, :color, :created_at, :updated_at)",
                item,
            )
            self._enqueue(conn, "diary_tag", item["id"], "create", item, None)
        return item

    def _diary(self, conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["is_favorite"] = bool(item["is_favorite"])
        tag_rows = conn.execute(
            """
            SELECT t.id, t.name, t.color
            FROM diary_tags t
            JOIN diary_tag_links dtl ON dtl.tag_id = t.id
            WHERE dtl.diary_id = ?
              AND dtl.deleted_at IS NULL
              AND t.deleted_at IS NULL
            ORDER BY t.name
            """,
            (item["id"],),
        ).fetchall()
        item["tags"] = [dict(tag) for tag in tag_rows]
        return item

    def _replace_diary_tags(self, conn: sqlite3.Connection, diary_id: str, raw_tags: list[Any]) -> None:
        names = []
        for tag in raw_tags:
            name = str(tag.get("name") if isinstance(tag, dict) else tag).strip()
            if name and name not in names:
                names.append(name[:40])
        now = now_iso()
        conn.execute("UPDATE diary_tag_links SET deleted_at = ? WHERE diary_id = ? AND deleted_at IS NULL", (now, diary_id))
        for name in names:
            tag = conn.execute("SELECT * FROM diary_tags WHERE name = ? AND deleted_at IS NULL", (name,)).fetchone()
            if tag is None:
                tag_id = new_id()
                conn.execute(
                    "INSERT INTO diary_tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (tag_id, name, "#748ffc", now, now),
                )
            else:
                tag_id = tag["id"]
            conn.execute(
                """
                INSERT INTO diary_tag_links (diary_id, tag_id, created_at, deleted_at)
                VALUES (?, ?, ?, NULL)
                ON CONFLICT(diary_id, tag_id) DO UPDATE SET deleted_at = NULL, created_at = excluded.created_at
                """,
                (diary_id, tag_id, now),
            )

    def list_projects(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM todo_projects WHERE deleted_at IS NULL ORDER BY sort_order, name").fetchall()
        return [dict(row) for row in rows]

    def create_project(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ApiError(400, "VALIDATION_ERROR", "标签名称不能为空")
        created = now_iso()
        item = {
            "id": str(payload.get("id") or new_id()),
            "name": name,
            "color": payload.get("color") or "#4dabf7",
            "sort_order": int(payload.get("sort_order") or 0),
            "created_at": created,
            "updated_at": created,
        }
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO todo_projects (id, name, color, sort_order, created_at, updated_at) VALUES (:id, :name, :color, :sort_order, :created_at, :updated_at)",
                item,
            )
            self._enqueue(conn, "todo_project", item["id"], "create", item, None)
        return item

    def get_project(self, item_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM todo_projects WHERE id = ? AND deleted_at IS NULL", (item_id,)).fetchone()
        if row is None:
            raise ApiError(404, "NOT_FOUND", "标签不存在")
        return dict(row)

    def update_project(self, item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        current = self.get_project(item_id)
        merged = {**current, **payload}
        merged["updated_at"] = now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE todo_projects
                SET name = ?, color = ?, sort_order = ?, updated_at = ?, version = version + 1
                WHERE id = ? AND deleted_at IS NULL
                """,
                (
                    str(merged.get("name") or "").strip(),
                    merged.get("color") or "#4dabf7",
                    int(merged.get("sort_order") or 0),
                    merged["updated_at"],
                    item_id,
                ),
            )
            self._enqueue(conn, "todo_project", item_id, "update", merged, current.get("version"))
        return self.get_project(item_id)

    def delete_project(self, item_id: str) -> dict[str, Any]:
        current = self.get_project(item_id)
        deleted = now_iso()
        with self.connect() as conn:
            conn.execute("UPDATE todos SET project_id = NULL, updated_at = ? WHERE project_id = ? AND deleted_at IS NULL", (deleted, item_id))
            conn.execute("UPDATE todo_projects SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", (deleted, deleted, item_id))
            self._enqueue(conn, "todo_project", item_id, "delete", {"id": item_id, "deleted_at": deleted}, current["version"])
        return {"id": item_id, "deleted_at": deleted}

    def list_todos(self, filters: dict[str, Any]) -> list[dict[str, Any]]:
        if filters.get("deleted"):
            clauses = ["t.deleted_at IS NOT NULL"]
        else:
            clauses = ["t.deleted_at IS NULL"]
        params: list[Any] = []
        if filters.get("project_id"):
            clauses.append("t.project_id = ?")
            params.append(filters["project_id"])
        if filters.get("status"):
            clauses.append("t.status = ?")
            params.append(filters["status"])
        if filters.get("priority") == "high":
            clauses.append("(t.priority = 'high' OR t.is_important = 1)")
        if filters.get("priority") == "normal":
            clauses.append("(t.priority IS NULL OR t.priority != 'high') AND t.is_important = 0")
        if filters.get("is_important") is not None:
            if filters["is_important"]:
                clauses.append("(t.priority = 'high' OR t.is_important = 1)")
            else:
                clauses.append("(t.priority IS NULL OR t.priority != 'high') AND t.is_important = 0")
        if filters.get("due_preset") in {"recent", "week"}:
            clauses.append(
                """
                t.due_at IS NOT NULL
                AND date(t.due_at) >= date('now', 'localtime')
                AND date(t.due_at) <= date('now', 'localtime', '+6 days')
                """
            )
        if filters.get("due_preset") == "overdue":
            clauses.append("t.due_at IS NOT NULL AND date(t.due_at) < date('now', 'localtime') AND t.status != 'completed'")
        if filters.get("due_preset") == "planned":
            clauses.append("t.due_at IS NOT NULL")
        if filters.get("due_from"):
            clauses.append("date(t.due_at) >= date(?)")
            params.append(filters["due_from"])
        if filters.get("due_to"):
            clauses.append("date(t.due_at) <= date(?)")
            params.append(filters["due_to"])
        if filters.get("keyword"):
            clauses.append("(t.title LIKE ? OR t.description LIKE ?)")
            like = f"%{filters['keyword']}%"
            params.extend([like, like])
        order_by = self._todo_order_by(str(filters.get("sort") or "smart"))
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT t.*, p.name AS project_name, p.color AS project_color
                FROM todos t
                LEFT JOIN todo_projects p ON p.id = t.project_id
                WHERE {' AND '.join(clauses)}
                ORDER BY {order_by}
                """,
                params,
            ).fetchall()
            return [self._todo(conn, row) for row in rows]

    def todo_summary(self) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status != 'completed' THEN 1 ELSE 0 END) AS open,
                    SUM(CASE WHEN status != 'completed' AND (priority = 'high' OR is_important = 1) THEN 1 ELSE 0 END) AS important,
                    SUM(CASE WHEN status != 'completed' AND due_at IS NOT NULL THEN 1 ELSE 0 END) AS planned,
                    SUM(CASE WHEN status != 'completed' AND due_at IS NOT NULL AND date(due_at) < date('now', 'localtime') THEN 1 ELSE 0 END) AS overdue
                FROM todos
                WHERE deleted_at IS NULL
                """
            ).fetchone()
        return {key: row[key] or 0 for key in row.keys()}

    def _todo_order_by(self, sort: str) -> str:
        high_priority = "(t.priority = 'high' OR t.is_important = 1)"
        options = {
            "priority": f"CASE t.status WHEN 'completed' THEN 1 ELSE 0 END, CASE WHEN {high_priority} THEN 0 ELSE 1 END, t.due_at IS NULL, t.due_at, t.created_at DESC",
            "due": f"CASE t.status WHEN 'completed' THEN 1 ELSE 0 END, t.due_at IS NULL, t.due_at, CASE WHEN {high_priority} THEN 0 ELSE 1 END",
            "created": "CASE t.status WHEN 'completed' THEN 1 ELSE 0 END, t.created_at DESC",
            "status": "CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, t.created_at DESC",
            "custom": "CASE t.status WHEN 'completed' THEN 1 ELSE 0 END, t.sort_order, t.created_at DESC",
            "smart": f"CASE t.status WHEN 'completed' THEN 1 ELSE 0 END, CASE WHEN {high_priority} THEN 0 ELSE 1 END, t.due_at IS NULL, t.due_at, t.sort_order, t.created_at DESC",
        }
        return options.get(sort, options["smart"])

    def create_todo(self, payload: dict[str, Any]) -> dict[str, Any]:
        title = str(payload.get("title") or "").strip()
        if not title:
            raise ApiError(400, "VALIDATION_ERROR", "任务标题不能为空")
        created = now_iso()
        priority = normalize_todo_priority(payload.get("priority"), payload.get("is_important"))
        item = {
            "id": str(payload.get("id") or new_id()),
            "project_id": payload.get("project_id"),
            "title": title,
            "description": payload.get("description") or "",
            "status": payload.get("status") or "pending",
            "priority": priority,
            "due_at": payload.get("due_at"),
            "start_at": payload.get("start_at"),
            "completed_at": payload.get("completed_at"),
            "sort_order": int(payload.get("sort_order") or 0),
            "is_important": 1 if priority == "high" else 0,
            "reminder_minutes": payload.get("reminder_minutes"),
            "created_at": created,
            "updated_at": created,
        }
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO todos
                    (id, project_id, title, description, status, priority, due_at, start_at,
                     completed_at, sort_order, is_important, reminder_minutes, created_at, updated_at)
                VALUES
                    (:id, :project_id, :title, :description, :status, :priority, :due_at, :start_at,
                     :completed_at, :sort_order, :is_important, :reminder_minutes, :created_at, :updated_at)
                """,
                item,
            )
            for order, subtask in enumerate(payload.get("subtasks") or []):
                self._create_subtask(conn, item["id"], str(subtask.get("title") or ""), order)
            self._record_todo_history(conn, item["id"], "create", "创建任务", item)
            self._enqueue(conn, "todo", item["id"], "create", item, None)
        return self.get_todo(item["id"])

    def get_todo(self, item_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT t.*, p.name AS project_name, p.color AS project_color
                FROM todos t
                LEFT JOIN todo_projects p ON p.id = t.project_id
                WHERE t.id = ? AND t.deleted_at IS NULL
                """,
                (item_id,),
            ).fetchone()
            if row is None:
                raise ApiError(404, "NOT_FOUND", "任务不存在")
            return self._todo(conn, row)

    def update_todo(self, item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        current = self.get_todo(item_id)
        merged = {**current, **payload}
        if "priority" in payload:
            merged["priority"] = normalize_todo_priority(payload.get("priority"), payload.get("is_important", False))
        elif "is_important" in payload:
            merged["priority"] = "high" if payload.get("is_important") else "normal"
        else:
            merged["priority"] = normalize_todo_priority(merged.get("priority"), merged.get("is_important"))
        merged["is_important"] = 1 if merged["priority"] == "high" else 0
        merged["updated_at"] = now_iso()
        if merged["status"] == "completed" and not merged.get("completed_at"):
            merged["completed_at"] = merged["updated_at"]
        if merged["status"] != "completed":
            merged["completed_at"] = None
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE todos
                SET project_id = ?, title = ?, description = ?, status = ?, priority = ?,
                    due_at = ?, start_at = ?, completed_at = ?, sort_order = ?,
                    is_important = ?, reminder_minutes = ?, updated_at = ?, version = version + 1
                WHERE id = ? AND deleted_at IS NULL
                """,
                (
                    merged.get("project_id"), merged["title"], merged.get("description") or "",
                    merged["status"], merged["priority"], merged.get("due_at"), merged.get("start_at"),
                    merged.get("completed_at"), int(merged.get("sort_order") or 0),
                    merged["is_important"], merged.get("reminder_minutes"), merged["updated_at"], item_id,
                ),
            )
            if "subtasks" in payload:
                conn.execute("UPDATE todo_subtasks SET deleted_at = ? WHERE todo_id = ?", (merged["updated_at"], item_id))
                for order, subtask in enumerate(payload.get("subtasks") or []):
                    self._create_subtask(conn, item_id, str(subtask.get("title") or ""), order, bool(subtask.get("is_completed")))
            action = "complete" if current.get("status") != "completed" and merged["status"] == "completed" else "update"
            if current.get("status") == "completed" and merged["status"] != "completed":
                action = "reopen"
            self._record_todo_history(conn, item_id, action, self._todo_history_summary(action, payload), payload)
            self._enqueue(conn, "todo", item_id, "update", merged, current.get("version"))
        return self.get_todo(item_id)

    def delete_todo(self, item_id: str) -> dict[str, Any]:
        current = self.get_todo(item_id)
        deleted = now_iso()
        with self.connect() as conn:
            conn.execute("UPDATE todos SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", (deleted, deleted, item_id))
            payload = {"deleted_at": deleted, "status": current.get("status"), "priority": current.get("priority")}
            self._record_todo_history(conn, item_id, "delete", "删除任务", payload)
            self._enqueue(conn, "todo", item_id, "delete", {"id": item_id, **payload}, current["version"])
        return {"id": item_id, "deleted_at": deleted}

    def restore_todo(self, item_id: str) -> dict[str, Any]:
        restored = now_iso()
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM todos WHERE id = ? AND deleted_at IS NOT NULL", (item_id,)).fetchone()
            if row is None:
                raise ApiError(404, "NOT_FOUND", "可恢复的任务不存在")
            conn.execute("UPDATE todos SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?", (restored, item_id))
            self._record_todo_history(conn, item_id, "restore", "恢复任务", {"restored_at": restored})
            self._enqueue(conn, "todo", item_id, "restore", {"id": item_id}, row["version"])
        return self.get_todo(item_id)

    def set_todo_status(self, item_id: str, status: str) -> dict[str, Any]:
        completed_at = now_iso() if status == "completed" else None
        return self.update_todo(item_id, {"status": status, "completed_at": completed_at})

    def list_todo_history(self, item_id: str) -> list[dict[str, Any]]:
        self.get_todo(item_id)
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM todo_history WHERE todo_id = ? ORDER BY created_at DESC LIMIT 80",
                (item_id,),
            ).fetchall()
        history = []
        for row in rows:
            item = dict(row)
            try:
                item["payload"] = json.loads(item.pop("payload_json") or "{}")
            except json.JSONDecodeError:
                item["payload"] = {}
            history.append(item)
        return history

    def _record_todo_history(
        self,
        conn: sqlite3.Connection,
        todo_id: str,
        action: str,
        summary: str,
        payload: dict[str, Any],
    ) -> None:
        conn.execute(
            """
            INSERT INTO todo_history (id, todo_id, action, summary, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (new_id(), todo_id, action, summary, json.dumps(payload, ensure_ascii=False), now_iso()),
        )

    def _todo_history_summary(self, action: str, payload: dict[str, Any]) -> str:
        labels = {
            "complete": "完成任务",
            "reopen": "重新打开任务",
            "update": "更新任务",
        }
        if payload.get("project_id") is not None:
            return "移动标签"
        if "due_at" in payload:
            return "调整截止时间"
        return labels.get(action, action)

    def bulk_update_todos(self, payload: dict[str, Any]) -> dict[str, Any]:
        ids = [str(item_id) for item_id in payload.get("ids") or [] if item_id]
        if not ids:
            raise ApiError(400, "VALIDATION_ERROR", "请选择要操作的任务")
        updates = dict(payload.get("updates") or {})
        operation = payload.get("operation")
        if operation == "complete":
            updates["status"] = "completed"
        if operation == "reopen":
            updates["status"] = "pending"
        if operation == "delete":
            deleted = [self.delete_todo(item_id) for item_id in ids]
            return {"updated": [], "deleted": deleted}
        allowed = {"project_id", "status", "priority", "due_at", "is_important", "reminder_minutes"}
        updates = {key: value for key, value in updates.items() if key in allowed}
        if not updates:
            raise ApiError(400, "VALIDATION_ERROR", "没有可更新的任务字段")
        updated = [self.update_todo(item_id, updates) for item_id in ids]
        return {"updated": updated, "deleted": []}

    def reorder_todos(self, payload: dict[str, Any]) -> dict[str, Any]:
        ordered_ids = [str(item_id) for item_id in payload.get("ordered_ids") or [] if item_id]
        if not ordered_ids:
            raise ApiError(400, "VALIDATION_ERROR", "排序列表不能为空")
        updated = now_iso()
        with self.connect() as conn:
            for order, item_id in enumerate(ordered_ids):
                conn.execute(
                    "UPDATE todos SET sort_order = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL",
                    (order, updated, item_id),
                )
            self._enqueue(conn, "todo", "bulk-reorder", "update", {"ordered_ids": ordered_ids}, None)
        return {"ordered_ids": ordered_ids, "updated_at": updated}

    def todo_stats(self) -> dict[str, Any]:
        today = date.today()
        week_start = today - timedelta(days=6)
        with self.connect() as conn:
            status_rows = conn.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM todos
                WHERE deleted_at IS NULL
                GROUP BY status
                """
            ).fetchall()
            priority_rows = conn.execute(
                """
                SELECT CASE WHEN priority = 'high' OR is_important = 1 THEN 'high' ELSE 'normal' END AS priority,
                       COUNT(*) AS count
                FROM todos
                WHERE deleted_at IS NULL AND status != 'completed'
                GROUP BY CASE WHEN priority = 'high' OR is_important = 1 THEN 'high' ELSE 'normal' END
                """
            ).fetchall()
            project_rows = conn.execute(
                """
                SELECT COALESCE(p.name, '无标签') AS name,
                       COUNT(t.id) AS total,
                       SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed
                FROM todos t
                LEFT JOIN todo_projects p ON p.id = t.project_id
                WHERE t.deleted_at IS NULL
                GROUP BY COALESCE(p.name, '无标签')
                ORDER BY total DESC, name
                """
            ).fetchall()
            trend_rows = conn.execute(
                """
                SELECT date(completed_at) AS day, COUNT(*) AS count
                FROM todos
                WHERE deleted_at IS NULL AND status = 'completed'
                  AND completed_at IS NOT NULL AND date(completed_at) >= date(?)
                GROUP BY date(completed_at)
                """,
                (week_start.isoformat(),),
            ).fetchall()
        trend_map = {row["day"]: row["count"] for row in trend_rows}
        trend = []
        cursor = week_start
        while cursor <= today:
            day = cursor.isoformat()
            trend.append({"date": day, "completed": trend_map.get(day, 0)})
            cursor += timedelta(days=1)
        status = {row["status"]: row["count"] for row in status_rows}
        open_count = sum(count for key, count in status.items() if key != "completed")
        completed = status.get("completed", 0)
        total = open_count + completed
        return {
            "total": total,
            "open": open_count,
            "completed": completed,
            "completion_rate": 0 if total == 0 else round(completed / total, 2),
            "by_status": [dict(row) for row in status_rows],
            "by_priority": [dict(row) for row in priority_rows],
            "by_project": [
                {
                    "name": row["name"],
                    "total": row["total"] or 0,
                    "completed": row["completed"] or 0,
                    "rate": 0 if not row["total"] else round((row["completed"] or 0) / row["total"], 2),
                }
                for row in project_rows
            ],
            "trend": trend,
        }

    def export_todos(self, export_format: str) -> dict[str, Any]:
        todos = self.list_todos({"sort": "custom"})
        export_format = export_format.lower()
        if export_format == "json":
            content = json.dumps(todos, ensure_ascii=False, indent=2)
            mime = "application/json"
        elif export_format == "csv":
            buffer = io.StringIO()
            writer = csv.DictWriter(
                buffer,
                fieldnames=["id", "title", "status", "priority", "due_at", "tag_name"],
            )
            writer.writeheader()
            for todo in todos:
                writer.writerow({
                    **{key: todo.get(key) for key in writer.fieldnames},
                    "tag_name": todo.get("project_name"),
                })
            content = buffer.getvalue()
            mime = "text/csv"
        elif export_format == "markdown":
            lines = ["# Flux Todo Export", ""]
            for todo in todos:
                marker = "x" if todo["status"] == "completed" else " "
                due = f" @ {todo['due_at']}" if todo.get("due_at") else ""
                project = f" #{todo['project_name']}" if todo.get("project_name") else ""
                lines.append(f"- [{marker}] {todo['title']}{due}{project}")
                for subtask in todo.get("subtasks") or []:
                    sub_marker = "x" if subtask["is_completed"] else " "
                    lines.append(f"  - [{sub_marker}] {subtask['title']}")
            content = "\n".join(lines) + "\n"
            mime = "text/markdown"
        else:
            raise ApiError(400, "VALIDATION_ERROR", "导出格式仅支持 json、csv、markdown")
        return {
            "format": export_format,
            "filename": f"flux-todos.{ 'md' if export_format == 'markdown' else export_format }",
            "mime": mime,
            "content": content,
        }

    def export_diaries(self, export_format: str, filters: dict[str, Any]) -> dict[str, Any]:
        diaries = self.list_diaries(filters)
        export_format = export_format.lower()
        if export_format == "json":
            content = json.dumps(diaries, ensure_ascii=False, indent=2)
            mime = "application/json"
        elif export_format == "csv":
            buffer = io.StringIO()
            writer = csv.DictWriter(
                buffer,
                fieldnames=[
                    "id",
                    "entry_date",
                    "entry_time",
                    "mood",
                    "weather",
                    "location_name",
                    "is_favorite",
                    "word_count",
                    "tags",
                    "content_md",
                    "created_at",
                    "updated_at",
                ],
            )
            writer.writeheader()
            for diary in diaries:
                row = {key: diary.get(key) for key in writer.fieldnames}
                row["tags"] = ", ".join(tag["name"] for tag in diary.get("tags") or [])
                writer.writerow(row)
            content = buffer.getvalue()
            mime = "text/csv"
        elif export_format == "markdown":
            lines = ["# Flux Diary Export", ""]
            for diary in diaries:
                heading = diary.get("entry_date") or "未命名日期"
                if diary.get("entry_time"):
                    heading = f"{heading} {diary['entry_time']}"
                lines.append(f"## {heading}")
                meta = []
                if diary.get("mood"):
                    meta.append(f"心情：{diary['mood']}")
                if diary.get("weather"):
                    meta.append(f"天气：{diary['weather']}")
                if diary.get("location_name"):
                    meta.append(f"位置：{diary['location_name']}")
                if diary.get("is_favorite"):
                    meta.append("收藏")
                tags = ", ".join(tag["name"] for tag in diary.get("tags") or [])
                if tags:
                    meta.append(f"标签：{tags}")
                if meta:
                    lines.append("")
                    lines.append("> " + " ｜ ".join(meta))
                lines.append("")
                lines.append(diary.get("content_md") or "")
                lines.append("")
            content = "\n".join(lines).rstrip() + "\n"
            mime = "text/markdown"
        else:
            raise ApiError(400, "VALIDATION_ERROR", "导出格式仅支持 json、csv、markdown")
        return {
            "format": export_format,
            "filename": f"flux-diaries.{ 'md' if export_format == 'markdown' else export_format }",
            "mime": mime,
            "content": content,
        }

    def _create_subtask(self, conn: sqlite3.Connection, todo_id: str, title: str, sort_order: int, is_completed: bool = False) -> None:
        title = title.strip()
        if not title:
            return
        created = now_iso()
        conn.execute(
            """
            INSERT INTO todo_subtasks
                (id, todo_id, title, is_completed, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (new_id(), todo_id, title, 1 if is_completed else 0, sort_order, created, created),
        )

    def create_subtask(self, todo_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.get_todo(todo_id)
        title = str(payload.get("title") or "").strip()
        if not title:
            raise ApiError(400, "VALIDATION_ERROR", "子任务标题不能为空")
        created = now_iso()
        item = {
            "id": str(payload.get("id") or new_id()),
            "todo_id": todo_id,
            "title": title,
            "is_completed": 1 if payload.get("is_completed") else 0,
            "sort_order": int(payload.get("sort_order") or 0),
            "created_at": created,
            "updated_at": created,
        }
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO todo_subtasks
                    (id, todo_id, title, is_completed, sort_order, created_at, updated_at)
                VALUES
                    (:id, :todo_id, :title, :is_completed, :sort_order, :created_at, :updated_at)
                """,
                item,
            )
            conn.execute("UPDATE todos SET updated_at = ?, version = version + 1 WHERE id = ?", (created, todo_id))
            self._enqueue(conn, "todo_subtask", item["id"], "create", item, None)
        return self.get_subtask(item["id"])

    def get_subtask(self, item_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM todo_subtasks WHERE id = ? AND deleted_at IS NULL", (item_id,)).fetchone()
        if row is None:
            raise ApiError(404, "NOT_FOUND", "子任务不存在")
        item = dict(row)
        item["is_completed"] = bool(item["is_completed"])
        return item

    def update_subtask(self, item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        current = self.get_subtask(item_id)
        merged = {**current, **payload}
        updated = now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE todo_subtasks
                SET title = ?, is_completed = ?, sort_order = ?, updated_at = ?, version = version + 1
                WHERE id = ? AND deleted_at IS NULL
                """,
                (
                    str(merged.get("title") or "").strip(),
                    1 if merged.get("is_completed") else 0,
                    int(merged.get("sort_order") or 0),
                    updated,
                    item_id,
                ),
            )
            conn.execute("UPDATE todos SET updated_at = ?, version = version + 1 WHERE id = ?", (updated, current["todo_id"]))
            self._enqueue(conn, "todo_subtask", item_id, "update", merged, current.get("version"))
        return self.get_subtask(item_id)

    def delete_subtask(self, item_id: str) -> dict[str, Any]:
        current = self.get_subtask(item_id)
        deleted = now_iso()
        with self.connect() as conn:
            conn.execute("UPDATE todo_subtasks SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", (deleted, deleted, item_id))
            conn.execute("UPDATE todos SET updated_at = ?, version = version + 1 WHERE id = ?", (deleted, current["todo_id"]))
            self._enqueue(conn, "todo_subtask", item_id, "delete", {"id": item_id, "deleted_at": deleted}, current["version"])
        return {"id": item_id, "deleted_at": deleted}

    def _todo(self, conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        for removed_key in ("is_my_day", "recurrence", "recurrence_interval", "recurrence_until", "parent_todo_id"):
            item.pop(removed_key, None)
        item["priority"] = normalize_todo_priority(item.get("priority"), item.get("is_important"))
        item["is_important"] = item["priority"] == "high"
        subtasks = conn.execute(
            "SELECT * FROM todo_subtasks WHERE todo_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at",
            (item["id"],),
        ).fetchall()
        item["subtasks"] = [{**dict(subtask), "is_completed": bool(subtask["is_completed"])} for subtask in subtasks]
        return item

    def list_events(self, filters: dict[str, Any]) -> list[dict[str, Any]]:
        clauses = ["deleted_at IS NOT NULL" if filters.get("deleted") else "deleted_at IS NULL"]
        params: list[Any] = []
        if filters.get("date_from"):
            clauses.append("date(start_at) >= date(?)")
            params.append(filters["date_from"])
        if filters.get("date_to"):
            clauses.append("date(start_at) <= date(?)")
            params.append(filters["date_to"])
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM calendar_events WHERE {' AND '.join(clauses)} ORDER BY start_at, end_at",
                params,
            ).fetchall()
        return [self._event(row) for row in rows]

    def create_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        title = str(payload.get("title") or "").strip()
        if not title:
            raise ApiError(400, "VALIDATION_ERROR", "事件标题不能为空")
        start_at = payload.get("start_at")
        end_at = payload.get("end_at")
        if not start_at or not end_at:
            raise ApiError(400, "VALIDATION_ERROR", "事件开始和结束时间不能为空")
        created = now_iso()
        item = {
            "id": str(payload.get("id") or new_id()),
            "title": title,
            "description": payload.get("description") or "",
            "start_at": start_at,
            "end_at": end_at,
            "all_day": 1 if payload.get("all_day") else 0,
            "color": payload.get("color") or "#4dabf7",
            "location_name": payload.get("location_name"),
            "reminder_minutes": payload.get("reminder_minutes"),
            "recurrence_rule": payload.get("recurrence_rule"),
            "created_at": created,
            "updated_at": created,
        }
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO calendar_events
                    (id, title, description, start_at, end_at, all_day, color, location_name,
                     reminder_minutes, recurrence_rule, created_at, updated_at)
                VALUES
                    (:id, :title, :description, :start_at, :end_at, :all_day, :color, :location_name,
                     :reminder_minutes, :recurrence_rule, :created_at, :updated_at)
                """,
                item,
            )
            self._enqueue(conn, "event", item["id"], "create", item, None)
        return self.get_event(item["id"])

    def get_event(self, item_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM calendar_events WHERE id = ? AND deleted_at IS NULL", (item_id,)).fetchone()
        if row is None:
            raise ApiError(404, "NOT_FOUND", "事件不存在")
        return self._event(row)

    def update_event(self, item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        current = self.get_event(item_id)
        merged = {**current, **payload}
        merged["all_day"] = 1 if merged.get("all_day") else 0
        merged["updated_at"] = now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE calendar_events
                SET title = ?, description = ?, start_at = ?, end_at = ?, all_day = ?,
                    color = ?, location_name = ?, reminder_minutes = ?, recurrence_rule = ?,
                    updated_at = ?, version = version + 1
                WHERE id = ? AND deleted_at IS NULL
                """,
                (
                    merged["title"], merged.get("description") or "", merged["start_at"], merged["end_at"],
                    merged["all_day"], merged.get("color"), merged.get("location_name"),
                    merged.get("reminder_minutes"), merged.get("recurrence_rule"), merged["updated_at"], item_id,
                ),
            )
            self._enqueue(conn, "event", item_id, "update", merged, current.get("version"))
        return self.get_event(item_id)

    def delete_event(self, item_id: str) -> dict[str, Any]:
        current = self.get_event(item_id)
        deleted = now_iso()
        with self.connect() as conn:
            conn.execute("UPDATE calendar_events SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", (deleted, deleted, item_id))
            self._enqueue(conn, "event", item_id, "delete", {"id": item_id, "deleted_at": deleted}, current["version"])
        return {"id": item_id, "deleted_at": deleted}

    def restore_event(self, item_id: str) -> dict[str, Any]:
        restored = now_iso()
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM calendar_events WHERE id = ? AND deleted_at IS NOT NULL", (item_id,)).fetchone()
            if row is None:
                raise ApiError(404, "NOT_FOUND", "可恢复的事件不存在")
            conn.execute("UPDATE calendar_events SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?", (restored, item_id))
            self._enqueue(conn, "event", item_id, "restore", {"id": item_id}, row["version"])
        return self.get_event(item_id)

    def toggle_holiday(self, day: str) -> dict[str, Any]:
        holiday_day = self._calendar_day(day)
        updated = now_iso()
        default_value, _ = self._default_holiday(holiday_day)
        next_value = not self.is_holiday(holiday_day)
        with self.connect() as conn:
            existing = conn.execute("SELECT day, is_holiday FROM calendar_holidays WHERE day = ?", (holiday_day,)).fetchone()
            if next_value == default_value:
                conn.execute("DELETE FROM calendar_holidays WHERE day = ?", (holiday_day,))
            elif existing:
                conn.execute(
                    "UPDATE calendar_holidays SET is_holiday = ?, updated_at = ? WHERE day = ?",
                    (1 if next_value else 0, updated, holiday_day),
                )
            else:
                conn.execute(
                    "INSERT INTO calendar_holidays (day, is_holiday, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    (holiday_day, 1 if next_value else 0, updated, updated),
                )
        return {"date": holiday_day, "is_holiday": next_value}

    def is_holiday(self, day: str) -> bool:
        holiday_day = self._calendar_day(day)
        with self.connect() as conn:
            row = conn.execute("SELECT is_holiday FROM calendar_holidays WHERE day = ?", (holiday_day,)).fetchone()
        if row is not None:
            return bool(row["is_holiday"])
        is_holiday, _ = self._default_holiday(holiday_day)
        return is_holiday

    def _default_holiday(self, day: str) -> tuple[bool, str | None]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT is_holiday, name FROM calendar_static_holidays WHERE day = ?",
                (day,),
            ).fetchone()
        if row is not None:
            return bool(row["is_holiday"]), row["name"]
        return self._is_weekend(day), None

    def day_aggregate(self, day: str) -> dict[str, Any]:
        target_day = self._calendar_day(day)
        diaries = self.list_diaries({"date_from": target_day, "date_to": target_day})
        deleted_diaries = self.list_diaries({"date_from": target_day, "date_to": target_day, "deleted": True})
        todos = self.list_todos({"due_from": target_day, "due_to": target_day})
        events = self.list_events({"date_from": target_day, "date_to": target_day})
        deleted_events = self.list_events({"date_from": target_day, "date_to": target_day, "deleted": True})
        open_todos = [todo for todo in todos if todo["status"] != "completed"]
        return {
            "date": target_day,
            "diaries": diaries,
            "deleted_diaries": deleted_diaries,
            "todos_due": todos,
            "events": events,
            "deleted_events": deleted_events,
            "summary": {
                "diary_count": len(diaries),
                "deleted_diary_count": len(deleted_diaries),
                "open_todo_count": len(open_todos),
                "completed_todo_count": len(todos) - len(open_todos),
                "event_count": len(events),
                "deleted_event_count": len(deleted_events),
                "is_holiday": self.is_holiday(target_day),
                "holiday_name": self._holiday_name(target_day),
            },
        }

    def calendar_history(self, day: str, mode: str) -> dict[str, Any]:
        target_day = self._calendar_day(day)
        target_date = date.fromisoformat(target_day)
        mode = "month" if mode == "month" else "day"
        if mode == "month":
            diary_clause = "substr(entry_date, 6, 2) = ?"
            todo_clause = "due_at IS NOT NULL AND substr(date(due_at), 6, 2) = ?"
            event_clause = "substr(date(start_at), 6, 2) = ?"
            params = (f"{target_date.month:02d}",)
        else:
            diary_clause = "substr(entry_date, 6, 5) = ?"
            todo_clause = "due_at IS NOT NULL AND substr(date(due_at), 6, 5) = ?"
            event_clause = "substr(date(start_at), 6, 5) = ?"
            params = (target_day[5:10],)
        with self.connect() as conn:
            diary_rows = conn.execute(
                f"SELECT * FROM diaries WHERE deleted_at IS NULL AND {diary_clause} ORDER BY entry_date DESC, updated_at DESC",
                params,
            ).fetchall()
            todo_rows = conn.execute(
                f"""
                SELECT t.*, p.name AS project_name, p.color AS project_color
                FROM todos t
                LEFT JOIN todo_projects p ON p.id = t.project_id
                WHERE t.deleted_at IS NULL AND {todo_clause}
                ORDER BY date(t.due_at) DESC, t.due_at DESC, t.created_at DESC
                """,
                params,
            ).fetchall()
            event_rows = conn.execute(
                f"""
                SELECT *
                FROM calendar_events
                WHERE deleted_at IS NULL AND {event_clause}
                ORDER BY date(start_at) DESC, start_at DESC
                """,
                params,
            ).fetchall()
            diaries = [self._diary(conn, row) for row in diary_rows]
            todos = [self._todo(conn, row) for row in todo_rows]
        events = [self._event(row) for row in event_rows]
        return {
            "mode": mode,
            "target_date": target_day,
            "target_month": f"{target_date.month:02d}",
            "target_day": target_day[5:10],
            "diaries": diaries,
            "todos_due": todos,
            "events": events,
            "summary": {
                "diary_count": len(diaries),
                "todo_count": len(todos),
                "event_count": len(events),
                "total_count": len(diaries) + len(todos) + len(events),
            },
        }

    def month_summary(self, year: int, month: int) -> list[dict[str, Any]]:
        first_day = date(year, month, 1)
        next_month = date(year + (1 if month == 12 else 0), 1 if month == 12 else month + 1, 1)
        last_day = next_month - timedelta(days=1)
        with self.connect() as conn:
            diary_rows = conn.execute(
                """
                SELECT entry_date AS day, COUNT(*) AS count, MAX(mood) AS mood
                FROM diaries
                WHERE deleted_at IS NULL AND entry_date BETWEEN ? AND ?
                GROUP BY entry_date
                """,
                (first_day.isoformat(), last_day.isoformat()),
            ).fetchall()
            deleted_diary_rows = conn.execute(
                """
                SELECT entry_date AS day, COUNT(*) AS count
                FROM diaries
                WHERE deleted_at IS NOT NULL
                  AND restored_at IS NULL
                  AND entry_date BETWEEN ? AND ?
                GROUP BY entry_date
                """,
                (first_day.isoformat(), last_day.isoformat()),
            ).fetchall()
            todo_rows = conn.execute(
                """
                SELECT date(due_at) AS day, COUNT(*) AS count
                FROM todos
                WHERE deleted_at IS NULL AND status != 'completed'
                  AND due_at IS NOT NULL AND date(due_at) BETWEEN date(?) AND date(?)
                GROUP BY date(due_at)
                """,
                (first_day.isoformat(), last_day.isoformat()),
            ).fetchall()
            event_rows = conn.execute(
                """
                SELECT date(start_at) AS day, COUNT(*) AS count
                FROM calendar_events
                WHERE deleted_at IS NULL AND date(start_at) BETWEEN date(?) AND date(?)
                GROUP BY date(start_at)
                """,
                (first_day.isoformat(), last_day.isoformat()),
            ).fetchall()
            deleted_event_rows = conn.execute(
                """
                SELECT date(start_at) AS day, COUNT(*) AS count
                FROM calendar_events
                WHERE deleted_at IS NOT NULL AND date(start_at) BETWEEN date(?) AND date(?)
                GROUP BY date(start_at)
                """,
                (first_day.isoformat(), last_day.isoformat()),
            ).fetchall()
            holiday_rows = conn.execute(
                """
                SELECT day, is_holiday
                FROM calendar_holidays
                WHERE day BETWEEN ? AND ?
                """,
                (first_day.isoformat(), last_day.isoformat()),
            ).fetchall()
            static_holiday_rows = conn.execute(
                """
                SELECT day, is_holiday, name
                FROM calendar_static_holidays
                WHERE day BETWEEN ? AND ?
                """,
                (first_day.isoformat(), last_day.isoformat()),
            ).fetchall()
        by_day: dict[str, dict[str, Any]] = {}
        cursor = first_day
        while cursor <= last_day:
            by_day[cursor.isoformat()] = {
                "date": cursor.isoformat(),
                "diary_count": 0,
                "deleted_diary_count": 0,
                "todo_due_count": 0,
                "event_count": 0,
                "deleted_event_count": 0,
                "mood": None,
                "is_holiday": self._is_weekend(cursor.isoformat()),
                "holiday_name": None,
            }
            cursor += timedelta(days=1)
        for row in diary_rows:
            by_day[row["day"]]["diary_count"] = row["count"]
            by_day[row["day"]]["mood"] = row["mood"]
        for row in deleted_diary_rows:
            by_day[row["day"]]["deleted_diary_count"] = row["count"]
        for row in todo_rows:
            by_day[row["day"]]["todo_due_count"] = row["count"]
        for row in event_rows:
            by_day[row["day"]]["event_count"] = row["count"]
        for row in deleted_event_rows:
            by_day[row["day"]]["deleted_event_count"] = row["count"]
        for row in static_holiday_rows:
            by_day[row["day"]]["is_holiday"] = bool(row["is_holiday"])
            by_day[row["day"]]["holiday_name"] = row["name"]
        for row in holiday_rows:
            by_day[row["day"]]["is_holiday"] = bool(row["is_holiday"])
            if not row["is_holiday"]:
                by_day[row["day"]]["holiday_name"] = None
        return list(by_day.values())

    def _calendar_day(self, value: str) -> str:
        try:
            return date.fromisoformat(str(value)).isoformat()
        except ValueError as exc:
            raise ApiError(400, "VALIDATION_ERROR", "日期格式必须为 YYYY-MM-DD") from exc

    def _is_weekend(self, value: str) -> bool:
        return date.fromisoformat(value).weekday() >= 5

    def _holiday_name(self, day: str) -> str | None:
        with self.connect() as conn:
            override = conn.execute("SELECT is_holiday FROM calendar_holidays WHERE day = ?", (day,)).fetchone()
            if override is not None and not override["is_holiday"]:
                return None
            row = conn.execute("SELECT name FROM calendar_static_holidays WHERE day = ?", (day,)).fetchone()
        return None if row is None else row["name"]

    def analytics_overview(self) -> dict[str, Any]:
        today = date.today().isoformat()
        week_start = (date.today() - timedelta(days=date.today().weekday())).isoformat()
        with self.connect() as conn:
            diary_count = conn.execute("SELECT COUNT(*) AS count FROM diaries WHERE deleted_at IS NULL").fetchone()["count"]
            completed_week = conn.execute(
                """
                SELECT COUNT(*) AS count FROM todos
                WHERE deleted_at IS NULL AND status = 'completed' AND date(completed_at) >= date(?)
                """,
                (week_start,),
            ).fetchone()["count"]
            due_today = conn.execute(
                """
                SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
                FROM todos
                WHERE deleted_at IS NULL AND due_at IS NOT NULL AND date(due_at) = date(?)
                """,
                (today,),
            ).fetchone()
            moods = conn.execute(
                """
                SELECT mood, COUNT(*) AS count
                FROM diaries
                WHERE deleted_at IS NULL AND mood IS NOT NULL AND mood != ''
                GROUP BY mood
                ORDER BY count DESC
                """
            ).fetchall()
            diary_dates = conn.execute(
                "SELECT DISTINCT entry_date FROM diaries WHERE deleted_at IS NULL ORDER BY entry_date DESC"
            ).fetchall()
        total_due = due_today["total"] or 0
        completed_due = due_today["completed"] or 0
        return {
            "diary_count": diary_count,
            "diary_streak_days": self._streak([row["entry_date"] for row in diary_dates]),
            "completed_todos_this_week": completed_week,
            "today_todo_completion_rate": 0 if total_due == 0 else round(completed_due / total_due, 2),
            "moods": [dict(row) for row in moods],
        }

    def _event(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["all_day"] = bool(item["all_day"])
        return item

    def _streak(self, days: list[str]) -> int:
        day_set = {date.fromisoformat(day) for day in days}
        cursor = date.today()
        streak = 0
        while cursor in day_set:
            streak += 1
            cursor -= timedelta(days=1)
        return streak


class FluxHandler(SimpleHTTPRequestHandler):
    repo: FluxRepository
    static_dir: Path

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(self.static_dir), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/attachments/"):
            return self._serve_attachment(parsed.path)
        if not parsed.path.startswith("/api/"):
            if parsed.path == "/":
                self.path = "/index.html"
            return super().do_GET()
        try:
            payload = self._handle_api(method, parsed.path, parse_qs(parsed.query))
            status = 201 if method == "POST" else 200
            self._json(status, {"data": payload, "meta": {}})
        except ApiError as error:
            self._json(error.status, {"error": {"code": error.code, "message": error.message, "details": error.details}})
        except Exception as error:
            self._json(500, {"error": {"code": "INTERNAL_ERROR", "message": str(error), "details": {}}})

    def _handle_api(self, method: str, path: str, query: dict[str, list[str]]) -> Any:
        parts = [part for part in path.removeprefix("/api/v1/").split("/") if part]
        body = {} if parts == ["attachments"] else self._read_json() if method in {"POST", "PATCH", "DELETE"} else {}

        if path == "/api/v1/health" and method == "GET":
            return {"status": "ok", "time": now_iso()}

        if parts == ["attachments"] and method == "GET":
            return self._list_attachments()
        if parts == ["attachments"] and method == "POST":
            return self._upload_attachment()
        if parts == ["attachments", "cleanup"] and method == "POST":
            return self._cleanup_attachments()
        if parts == ["attachments", "delete"] and method == "DELETE":
            return self._delete_attachment(body)

        if parts == ["diaries"] and method == "GET":
            return self.repo.list_diaries(
                {
                    "date_from": first(query, "date_from"),
                    "date_to": first(query, "date_to"),
                    "mood": first(query, "mood"),
                    "tag_id": first(query, "tag_id"),
                    "keyword": first(query, "keyword"),
                    "is_favorite": parse_bool(first(query, "is_favorite")),
                    "deleted": parse_bool(first(query, "deleted")),
                }
            )
        if parts == ["diaries", "export"] and method == "GET":
            return self.repo.export_diaries(
                first(query, "format", "markdown") or "markdown",
                {
                    "date_from": first(query, "date_from"),
                    "date_to": first(query, "date_to"),
                    "mood": first(query, "mood"),
                    "tag_id": first(query, "tag_id"),
                    "keyword": first(query, "keyword"),
                    "is_favorite": parse_bool(first(query, "is_favorite")),
                },
            )
        if parts == ["diaries"] and method == "POST":
            return self.repo.create_diary(body)
        if len(parts) == 3 and parts[:2] == ["diaries", "by-date"] and method == "GET":
            return self.repo.list_diaries({"date_from": parts[2], "date_to": parts[2]})
        if len(parts) == 2 and parts[0] == "diaries":
            if method == "GET":
                return self.repo.get_diary(parts[1])
            if method == "PATCH":
                return self.repo.update_diary(parts[1], body)
            if method == "DELETE":
                return self.repo.delete_diary(parts[1])
        if len(parts) == 3 and parts[0] == "diaries" and parts[2] == "restore" and method == "POST":
            return self.repo.restore_diary(parts[1])

        if parts == ["todo-projects"] and method == "GET":
            return self.repo.list_projects()
        if parts == ["todo-projects"] and method == "POST":
            return self.repo.create_project(body)
        if len(parts) == 2 and parts[0] == "todo-projects":
            if method == "GET":
                return self.repo.get_project(parts[1])
            if method == "PATCH":
                return self.repo.update_project(parts[1], body)
            if method == "DELETE":
                return self.repo.delete_project(parts[1])

        if parts == ["diary-tags"] and method == "GET":
            return self.repo.list_tags()
        if parts == ["diary-tags"] and method == "POST":
            return self.repo.create_tag(body)

        if parts == ["todos", "summary"] and method == "GET":
            return self.repo.todo_summary()
        if parts == ["todos", "stats"] and method == "GET":
            return self.repo.todo_stats()
        if parts == ["todos", "export"] and method == "GET":
            return self.repo.export_todos(first(query, "format", "markdown") or "markdown")
        if parts == ["todos", "bulk"] and method == "PATCH":
            return self.repo.bulk_update_todos(body)
        if parts == ["todos", "reorder"] and method == "POST":
            return self.repo.reorder_todos(body)
        if parts == ["todos"] and method == "GET":
            return self.repo.list_todos(
                {
                    "deleted": parse_bool(first(query, "deleted")),
                    "project_id": first(query, "project_id"),
                    "status": first(query, "status"),
                    "priority": first(query, "priority"),
                    "is_important": parse_bool(first(query, "is_important")),
                    "due_preset": first(query, "due_preset"),
                    "due_from": first(query, "due_from"),
                    "due_to": first(query, "due_to"),
                    "keyword": first(query, "keyword"),
                    "sort": first(query, "sort"),
                }
            )
        if parts == ["todos"] and method == "POST":
            return self.repo.create_todo(body)
        if len(parts) == 3 and parts[0] == "todos" and parts[2] == "complete" and method == "POST":
            return self.repo.set_todo_status(parts[1], "completed")
        if len(parts) == 3 and parts[0] == "todos" and parts[2] == "reopen" and method == "POST":
            return self.repo.set_todo_status(parts[1], "pending")
        if len(parts) == 2 and parts[0] == "todos":
            if method == "GET":
                return self.repo.get_todo(parts[1])
            if method == "PATCH":
                return self.repo.update_todo(parts[1], body)
            if method == "DELETE":
                return self.repo.delete_todo(parts[1])
        if len(parts) == 3 and parts[0] == "todos" and parts[2] == "history" and method == "GET":
            return self.repo.list_todo_history(parts[1])
        if len(parts) == 3 and parts[0] == "todos" and parts[2] == "restore" and method == "POST":
            return self.repo.restore_todo(parts[1])
        if len(parts) == 3 and parts[0] == "todos" and parts[2] == "subtasks" and method == "POST":
            return self.repo.create_subtask(parts[1], body)

        if len(parts) == 2 and parts[0] == "subtasks":
            if method == "GET":
                return self.repo.get_subtask(parts[1])
            if method == "PATCH":
                return self.repo.update_subtask(parts[1], body)
            if method == "DELETE":
                return self.repo.delete_subtask(parts[1])

        if parts == ["events"] and method == "GET":
            return self.repo.list_events({
                "date_from": first(query, "date_from"),
                "date_to": first(query, "date_to"),
                "deleted": parse_bool(first(query, "deleted")),
            })
        if parts == ["events"] and method == "POST":
            return self.repo.create_event(body)
        if len(parts) == 2 and parts[0] == "events":
            if method == "GET":
                return self.repo.get_event(parts[1])
            if method == "PATCH":
                return self.repo.update_event(parts[1], body)
            if method == "DELETE":
                return self.repo.delete_event(parts[1])
        if len(parts) == 3 and parts[0] == "events" and parts[2] == "restore" and method == "POST":
            return self.repo.restore_event(parts[1])

        if parts == ["calendar", "month"] and method == "GET":
            today = date.today()
            year = int(first(query, "year", str(today.year)) or today.year)
            month = int(first(query, "month", str(today.month)) or today.month)
            return self.repo.month_summary(year, month)
        if len(parts) == 3 and parts[:2] == ["calendar", "day"] and method == "GET":
            return self.repo.day_aggregate(parts[2])
        if parts == ["calendar", "history"] and method == "GET":
            return self.repo.calendar_history(
                first(query, "date", date.today().isoformat()) or date.today().isoformat(),
                first(query, "mode", "day") or "day",
            )
        if len(parts) == 4 and parts[:2] == ["calendar", "holidays"] and parts[3] == "toggle" and method == "POST":
            return self.repo.toggle_holiday(parts[2])

        if parts == ["analytics", "overview"] and method == "GET":
            return self.repo.analytics_overview()

        raise ApiError(404, "NOT_FOUND", f"接口不存在: {method} {path}")

    def _serve_attachment(self, request_path: str) -> None:
        relative_parts = [part for part in request_path.removeprefix("/attachments/").split("/") if part]
        target = (ATTACHMENTS_ROOT.joinpath(*relative_parts)).resolve()
        root = ATTACHMENTS_ROOT.resolve()
        if root not in target.parents and target != root:
            self.send_error(404)
            return
        if not target.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _upload_attachment(self) -> dict[str, Any]:
        filename, content = self._read_multipart_file()
        suffix = Path(filename).suffix.lower()
        if suffix not in ALLOWED_ATTACHMENT_EXTENSIONS:
            raise ApiError(400, "VALIDATION_ERROR", "仅支持图片、音频、文档和常见压缩文件")
        if len(content) >= MAX_ATTACHMENT_BYTES:
            raise ApiError(413, "PAYLOAD_TOO_LARGE", "附件必须小于 100MB")
        today = date.today()
        folder = ATTACHMENTS_ROOT / "diaries" / str(today.year) / f"{today.month:02d}"
        folder.mkdir(parents=True, exist_ok=True)
        safe_name = f"{new_id()}{suffix}"
        target = folder / safe_name
        target.write_bytes(content)
        url = f"/attachments/diaries/{today.year}/{today.month:02d}/{safe_name}"
        return {
            "name": Path(filename).name,
            "url": url,
            "mime": mimetypes.guess_type(safe_name)[0] or "application/octet-stream",
            "size": len(content),
        }

    def _list_attachments(self) -> dict[str, Any]:
        root = ATTACHMENTS_ROOT.resolve()
        references = self._attachment_reference_map()
        used = set(references.keys())
        items: list[dict[str, Any]] = []
        if root.exists():
            for path in sorted(root.rglob("*")):
                if not path.is_file():
                    continue
                resolved = path.resolve()
                mime = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
                stat = resolved.stat()
                items.append(
                    {
                        "name": resolved.name,
                        "url": "/attachments/" + resolved.relative_to(root).as_posix(),
                        "mime": mime,
                        "kind": "audio" if mime.startswith("audio/") else "image" if mime.startswith("image/") else "file",
                        "size": stat.st_size,
                        "used": resolved in used,
                        "references": references.get(resolved, []),
                        "updated_at": datetime.fromtimestamp(stat.st_mtime, UTC).replace(microsecond=0).isoformat(),
                    }
                )
        total_bytes = sum(item["size"] for item in items)
        used_bytes = sum(item["size"] for item in items if item["used"])
        unused_bytes = total_bytes - used_bytes
        return {
            "total_count": len(items),
            "used_count": sum(1 for item in items if item["used"]),
            "unused_count": sum(1 for item in items if not item["used"]),
            "total_bytes": total_bytes,
            "used_bytes": used_bytes,
            "unused_bytes": unused_bytes,
            "items": sorted(items, key=lambda item: (not item["used"], item["updated_at"]), reverse=True),
        }

    def _read_multipart_file(self) -> tuple[str, bytes]:
        content_type = self.headers.get("Content-Type") or ""
        marker = "boundary="
        if "multipart/form-data" not in content_type or marker not in content_type:
            raise ApiError(400, "VALIDATION_ERROR", "请使用 multipart/form-data 上传文件")
        boundary = content_type.split(marker, 1)[1].split(";", 1)[0].strip().strip('"')
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            raise ApiError(400, "VALIDATION_ERROR", "上传文件不能为空")
        if length > MAX_ATTACHMENT_BYTES + 1024 * 1024:
            raise ApiError(413, "PAYLOAD_TOO_LARGE", "附件必须小于 100MB")
        body = self.rfile.read(length)
        delimiter = f"--{boundary}".encode("utf-8")
        for raw_part in body.split(delimiter):
            part = raw_part
            if part.startswith(b"\r\n"):
                part = part[2:]
            if part.endswith(b"\r\n"):
                part = part[:-2]
            if not part or part == b"--" or b"\r\n\r\n" not in part:
                continue
            header_blob, content = part.split(b"\r\n\r\n", 1)
            if content.endswith(b"--"):
                content = content[:-2]
            if content.endswith(b"\r\n"):
                content = content[:-2]
            headers = header_blob.decode("utf-8", "ignore")
            if "filename=" not in headers:
                continue
            filename = ""
            disposition = next((line for line in headers.splitlines() if line.lower().startswith("content-disposition:")), "")
            for piece in disposition.split(";"):
                piece = piece.strip()
                if piece.startswith("filename="):
                    filename = piece.split("=", 1)[1].strip().strip('"')
                    break
            if not filename:
                continue
            return Path(filename).name, content
        raise ApiError(400, "VALIDATION_ERROR", "没有找到上传文件")

    def _cleanup_attachments(self) -> dict[str, Any]:
        root = ATTACHMENTS_ROOT.resolve()
        if not root.exists():
            return {"deleted_count": 0, "deleted_bytes": 0, "deleted": []}
        used = self._used_attachment_paths()
        deleted: list[str] = []
        deleted_bytes = 0
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            resolved = path.resolve()
            if resolved in used:
                continue
            size = resolved.stat().st_size
            resolved.unlink()
            deleted_bytes += size
            deleted.append("/attachments/" + resolved.relative_to(root).as_posix())
        for path in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
            if path.is_dir():
                try:
                    path.rmdir()
                except OSError:
                    pass
        return {"deleted_count": len(deleted), "deleted_bytes": deleted_bytes, "deleted": deleted}

    def _delete_attachment(self, payload: dict[str, Any]) -> dict[str, Any]:
        root = ATTACHMENTS_ROOT.resolve()
        url = str(payload.get("url") or "").strip()
        target = self._attachment_url_path(root, url)
        if target is None or not target.is_file():
            raise ApiError(404, "NOT_FOUND", "附件不存在")
        references = self._attachment_reference_map().get(target, [])
        size = target.stat().st_size
        target.unlink()
        for path in sorted(target.parents, key=lambda item: len(item.parts), reverse=True):
            if path == root or root not in path.parents:
                break
            try:
                path.rmdir()
            except OSError:
                break
        return {
            "url": url,
            "deleted_bytes": size,
            "reference_count": len(references),
            "references": references,
        }

    def _used_attachment_paths(self) -> set[Path]:
        return set(self._attachment_reference_map().keys())

    def _attachment_reference_map(self) -> dict[Path, list[dict[str, Any]]]:
        root = ATTACHMENTS_ROOT.resolve()
        pattern = re.compile(r"(?!!)\[[^\]]*]\((/attachments/[^)\s]+)\)|!\[[^\]]*]\((/attachments/[^)\s]+)\)")
        references: dict[Path, list[dict[str, Any]]] = {}
        with self.repo.connect() as conn:
            rows = conn.execute(
                """
                SELECT id, entry_date, entry_time, content_md
                FROM diaries
                WHERE deleted_at IS NULL
                ORDER BY entry_date DESC, updated_at DESC
                """
            ).fetchall()
        for row in rows:
            for line_number, line in enumerate((row["content_md"] or "").splitlines(), start=1):
                for match in pattern.findall(line):
                    url = next((part for part in match if part), "")
                    target = self._attachment_url_path(root, url)
                    if target is None or not target.is_file():
                        continue
                    references.setdefault(target, []).append(
                        {
                            "diary_id": row["id"],
                            "entry_date": row["entry_date"],
                            "entry_time": row["entry_time"],
                            "line": line_number,
                            "excerpt": self._attachment_excerpt(line),
                        }
                    )
        return references

    def _attachment_url_path(self, root: Path, url: str) -> Path | None:
        if not url.startswith("/attachments/"):
            return None
        relative_parts = [part for part in url.removeprefix("/attachments/").split("/") if part]
        target = root.joinpath(*relative_parts).resolve()
        return target if root in target.parents else None

    def _attachment_excerpt(self, line: str) -> str:
        excerpt = re.sub(r"!\[([^\]]*)]\(/attachments/[^)\s]+\)", r"\1", line)
        excerpt = re.sub(r"\[([^\]]*)]\(/attachments/[^)\s]+\)", r"\1", excerpt).strip()
        if not excerpt:
            return "附件引用"
        return excerpt[:100]

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ApiError(400, "VALIDATION_ERROR", "请求体不是合法 JSON") from exc
        if not isinstance(payload, dict):
            raise ApiError(400, "VALIDATION_ERROR", "请求体必须是 JSON 对象")
        return payload

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def build_handler(repo: FluxRepository, static_dir: Path) -> type[FluxHandler]:
    class ConfiguredFluxHandler(FluxHandler):
        pass

    ConfiguredFluxHandler.repo = repo
    ConfiguredFluxHandler.static_dir = static_dir
    return ConfiguredFluxHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Flux local-first MVP server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--static", type=Path, default=DEFAULT_STATIC)
    args = parser.parse_args()

    repo = FluxRepository(args.db)
    handler = build_handler(repo, args.static)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Flux MVP running at http://{args.host}:{args.port}")
    print(f"SQLite database: {args.db}")
    server.serve_forever()


if __name__ == "__main__":
    main()
