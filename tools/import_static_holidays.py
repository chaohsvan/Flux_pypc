from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
from datetime import UTC, datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "flux.db"
DEFAULT_HOLIDAYS_DIR = ROOT / "vendor" / "chinese-days"
DEFAULT_START = "1900-01-01"
DEFAULT_END = "2100-12-31"
SOURCE = "chinese-days"


NODE_EXPORTER = r"""
const path = require("path");
const holidaysDir = path.resolve(process.argv[1]);
const start = process.argv[2];
const end = process.argv[3];
const hd = require(holidaysDir);

function localHolidayName(detail) {
  if (!detail || !detail.name) return "";
  const parts = String(detail.name).split(",").map((part) => part.trim()).filter(Boolean);
  return parts.find((part) => /[\u4e00-\u9fff]/.test(part)) || parts[0] || "";
}

const days = hd.getHolidaysInRange(start, end, false);
const records = days.map((day) => {
  const detail = hd.getDayDetail(day);
  return {
    day,
    is_holiday: true,
    name: localHolidayName(detail),
  };
});

process.stdout.write(JSON.stringify(records));
"""


def load_static_holidays(holidays_dir: Path, start: str, end: str) -> list[dict[str, object]]:
    result = subprocess.run(
        ["node", "-e", NODE_EXPORTER, str(holidays_dir), start, end],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    records = json.loads(result.stdout)
    if not isinstance(records, list):
        raise RuntimeError("holidays exporter did not return a list")
    return records


def import_holidays(db_path: Path, records: list[dict[str, object]]) -> None:
    updated_at = datetime.now(UTC).replace(microsecond=0).isoformat()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
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
        conn.execute("DELETE FROM calendar_static_holidays WHERE source = ?", (SOURCE,))
        conn.executemany(
            """
            INSERT INTO calendar_static_holidays (day, is_holiday, name, source, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(day) DO UPDATE SET
                is_holiday = excluded.is_holiday,
                name = excluded.name,
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            [
                (
                    str(record["day"]),
                    1 if record.get("is_holiday") else 0,
                    str(record.get("name") or ""),
                    SOURCE,
                    updated_at,
                )
                for record in records
            ],
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Import chinese-days static holidays into Flux SQLite.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--holidays-dir", type=Path, default=DEFAULT_HOLIDAYS_DIR)
    parser.add_argument("--start", default=DEFAULT_START)
    parser.add_argument("--end", default=DEFAULT_END)
    args = parser.parse_args()

    records = load_static_holidays(args.holidays_dir, args.start, args.end)
    import_holidays(args.db, records)
    print(f"Imported {len(records)} static holidays into {args.db}")


if __name__ == "__main__":
    main()
