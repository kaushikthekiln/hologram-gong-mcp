"""
Backfill Hologram Gong calls into Supabase.

Pulls calls from Gong API in a date window, formats them to match the
existing schema in public.gong_calls + public.gong_call_list, and upserts
on call_id. Safe to re-run (won't duplicate).

Usage:
    python3 backfill_gong.py --dry-run             # fetch from Gong only, no DB writes
    python3 backfill_gong.py                       # fetch + upsert
    python3 backfill_gong.py --since 2025-12-10T11:30:33Z --until 2026-05-08T00:00:00Z

Defaults:
    since = max(call_date) in gong_calls + 1 second
    until = now (UTC)
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import requests

# ---------- credentials (required, from env or .env) ----------

GONG_BASIC_AUTH = os.environ.get("GONG_BASIC_AUTH")
SUPABASE_PROJECT_REF = os.environ.get("SUPABASE_PROJECT_REF")
SUPABASE_MGMT_TOKEN = os.environ.get("SUPABASE_MGMT_TOKEN")

_missing = [name for name, val in (
    ("GONG_BASIC_AUTH", GONG_BASIC_AUTH),
    ("SUPABASE_PROJECT_REF", SUPABASE_PROJECT_REF),
    ("SUPABASE_MGMT_TOKEN", SUPABASE_MGMT_TOKEN),
) if not val]
if _missing:
    sys.stderr.write(
        f"Missing required env vars: {', '.join(_missing)}\n"
        "Set them in your shell or in a .env file (see .env.example).\n"
    )
    sys.exit(1)

GONG_BASE = "https://api.gong.io"
SUPABASE_SQL = f"https://api.supabase.com/v1/projects/{SUPABASE_PROJECT_REF}/database/query"

GONG_HEADERS = {"Authorization": f"Basic {GONG_BASIC_AUTH}"}
SUPA_HEADERS = {
    "Authorization": f"Bearer {SUPABASE_MGMT_TOKEN}",
    "Content-Type": "application/json",
}

# ---------- helpers ----------

def supa_sql(query: str) -> Any:
    r = requests.post(SUPABASE_SQL, headers=SUPA_HEADERS, json={"query": query}, timeout=120)
    if r.status_code >= 300:
        raise RuntimeError(f"Supabase SQL error {r.status_code}: {r.text[:500]}")
    return r.json()

def pg_text(s: Optional[str]) -> str:
    """Postgres single-quoted text literal with proper escaping."""
    if s is None:
        return "NULL"
    escaped = s.replace("\\", "\\\\").replace("'", "''")
    return f"'{escaped}'"

def pg_int(n: Optional[int]) -> str:
    if n is None:
        return "NULL"
    return str(int(n))

def pg_bool(b: Optional[bool]) -> str:
    if b is None:
        return "NULL"
    return "TRUE" if b else "FALSE"

def pg_jsonb(obj: Any) -> str:
    if obj is None:
        return "NULL"
    return f"{pg_text(json.dumps(obj))}::jsonb"

def pg_timestamp(s: Optional[str]) -> str:
    if not s:
        return "NULL"
    return f"{pg_text(s)}::timestamptz"

def gong_request(method: str, path: str, **kwargs) -> Dict[str, Any]:
    """Hit Gong API with retry on 429 / 5xx."""
    url = f"{GONG_BASE}{path}"
    for attempt in range(5):
        r = requests.request(method, url, headers=GONG_HEADERS, timeout=60, **kwargs)
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 5))
            print(f"  rate-limited, sleeping {wait}s")
            time.sleep(wait)
            continue
        if 500 <= r.status_code < 600:
            print(f"  Gong {r.status_code}, sleeping 5s and retrying")
            time.sleep(5)
            continue
        if r.status_code >= 400:
            raise RuntimeError(f"Gong {method} {path} -> {r.status_code}: {r.text[:500]}")
        return r.json()
    raise RuntimeError(f"Gong {method} {path} failed after retries")

# ---------- Gong API pulls ----------

def fetch_call_list(since_iso: str, until_iso: str) -> List[Dict[str, Any]]:
    """List all calls in window. Pages via Gong's cursor."""
    all_calls = []
    cursor = None
    page = 0
    while True:
        params = {"fromDateTime": since_iso, "toDateTime": until_iso}
        if cursor:
            params["cursor"] = cursor
        data = gong_request("GET", "/v2/calls", params=params)
        calls = data.get("calls", [])
        all_calls.extend(calls)
        records = data.get("records") or {}
        cursor = records.get("cursor")
        page += 1
        print(f"  page {page}: {len(calls)} calls (cumulative {len(all_calls)})")
        if not cursor:
            break
        time.sleep(0.4)
    return all_calls

def fetch_transcripts(call_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """Returns {call_id: {sentences: [...]}} for the requested call_ids."""
    out: Dict[str, Dict[str, Any]] = {}
    BATCH = 50
    for i in range(0, len(call_ids), BATCH):
        batch = call_ids[i : i + BATCH]
        body = {"filter": {"callIds": batch}}
        try:
            data = gong_request("POST", "/v2/calls/transcript", json=body)
        except RuntimeError as e:
            print(f"  transcript batch {i}-{i+BATCH} failed: {e}")
            time.sleep(2)
            continue
        for entry in data.get("callTranscripts", []) or []:
            out[entry["callId"]] = entry
        print(f"  fetched transcripts {i + len(batch)}/{len(call_ids)}")
        time.sleep(0.4)
    return out

# ---------- transcript formatting ----------

def format_transcript(transcript_entry: Optional[Dict[str, Any]]) -> Tuple[str, List[str]]:
    """
    Convert Gong's structured transcript JSON to the existing flat format:
        Speaker {id}: {sentence}\n\n
    Returns (formatted_text, ordered_unique_speaker_ids).
    """
    if not transcript_entry:
        return "", []
    pieces = []
    speakers_in_order: List[str] = []
    seen_speakers: Set[str] = set()
    for utterance in transcript_entry.get("transcript", []) or []:
        speaker_id = utterance.get("speakerId") or ""
        if speaker_id and speaker_id not in seen_speakers:
            speakers_in_order.append(speaker_id)
            seen_speakers.add(speaker_id)
        for sent in utterance.get("sentences", []) or []:
            text = (sent.get("text") or "").strip()
            if text:
                pieces.append(f"Speaker {speaker_id}: {text}")
    return "\n\n".join(pieces), speakers_in_order

# ---------- row builders ----------

def build_row(call: Dict[str, Any], transcript_entry: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    transcript_text, speakers = format_transcript(transcript_entry)

    speaker_slots = {f"speaker_{i+1}_id": (speakers[i] if i < len(speakers) else None) for i in range(10)}
    speaker_count = len(speakers)

    # Gong gives `started` for actual start; existing schema's call_date uses that.
    started = call.get("started") or call.get("scheduled")

    return {
        "call_id": str(call.get("id") or ""),
        "title": call.get("title"),
        "transcript": transcript_text,
        "url": call.get("url"),
        "call_date": started,
        "duration": call.get("duration"),
        "direction": call.get("direction"),
        "primary_user_id": call.get("primaryUserId"),
        "system": call.get("system"),
        "scope": call.get("scope"),
        "media": call.get("media"),
        "language": call.get("language"),
        "workspace_id": call.get("workspaceId"),
        "sdr_disposition": call.get("sdrDisposition"),
        "client_unique_id": call.get("clientUniqueId"),
        "purpose": call.get("purpose"),
        "is_private": call.get("isPrivate"),
        "calendar_event_id": call.get("calendarEventId"),
        "custom_data": call.get("customData"),
        "speaker_ids": speakers if speakers else None,
        "speaker_count": speaker_count,
        "scheduled": call.get("scheduled"),
        "meeting_url": call.get("meetingUrl"),
        **speaker_slots,
    }

# ---------- upserts ----------

def upsert_gong_calls(rows: List[Dict[str, Any]], batch_size: int = 10):
    """Upsert into public.gong_calls. Uses ON CONFLICT (call_id) DO UPDATE."""
    cols = [
        "call_id", "title", "transcript", "url", "call_date", "duration", "direction",
        "primary_user_id", "system", "scope", "media", "language", "workspace_id",
        "sdr_disposition", "client_unique_id", "purpose", "is_private", "calendar_event_id",
        "custom_data", "speaker_ids", "speaker_count", "scheduled", "meeting_url",
        "speaker_1_id", "speaker_2_id", "speaker_3_id", "speaker_4_id", "speaker_5_id",
        "speaker_6_id", "speaker_7_id", "speaker_8_id", "speaker_9_id", "speaker_10_id",
    ]
    update_cols = [c for c in cols if c != "call_id"]
    set_clause = ", ".join(f"{c} = excluded.{c}" for c in update_cols)

    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        values_sql_parts = []
        for r in batch:
            values_sql_parts.append("(" + ", ".join([
                pg_text(r["call_id"]),
                pg_text(r["title"]),
                pg_text(r["transcript"]),
                pg_text(r["url"]),
                pg_timestamp(r["call_date"]),
                pg_int(r["duration"]),
                pg_text(r["direction"]),
                pg_text(r["primary_user_id"]),
                pg_text(r["system"]),
                pg_text(r["scope"]),
                pg_text(r["media"]),
                pg_text(r["language"]),
                pg_text(r["workspace_id"]),
                pg_text(r["sdr_disposition"]),
                pg_text(r["client_unique_id"]),
                pg_text(r["purpose"]),
                pg_bool(r["is_private"]),
                pg_text(r["calendar_event_id"]),
                pg_jsonb(r["custom_data"]),
                pg_jsonb(r["speaker_ids"]),
                pg_int(r["speaker_count"]),
                pg_timestamp(r["scheduled"]),
                pg_text(r["meeting_url"]),
                pg_text(r["speaker_1_id"]),
                pg_text(r["speaker_2_id"]),
                pg_text(r["speaker_3_id"]),
                pg_text(r["speaker_4_id"]),
                pg_text(r["speaker_5_id"]),
                pg_text(r["speaker_6_id"]),
                pg_text(r["speaker_7_id"]),
                pg_text(r["speaker_8_id"]),
                pg_text(r["speaker_9_id"]),
                pg_text(r["speaker_10_id"]),
            ]) + ")")

        sql = (
            f"INSERT INTO public.gong_calls ({', '.join(cols)}) VALUES "
            + ", ".join(values_sql_parts)
            + f" ON CONFLICT (call_id) DO UPDATE SET {set_clause};"
        )
        try:
            supa_sql(sql)
            print(f"  upserted gong_calls batch {i + len(batch)}/{len(rows)}")
        except Exception as e:
            print(f"  !! gong_calls batch {i}-{i+len(batch)} failed: {str(e)[:200]}")

def upsert_gong_call_list(rows: List[Dict[str, Any]], batch_size: int = 10):
    """Upsert into public.gong_call_list (subset of columns)."""
    cols = [
        "call_id", "title", "transcript", "url", "call_date", "duration", "direction",
        "primary_user_id", "system", "scope", "media", "language", "workspace_id",
        "sdr_disposition", "client_unique_id", "purpose", "is_private", "calendar_event_id",
        "custom_data", "speaker_count", "scheduled", "meeting_url",
        "speaker_1_id", "speaker_2_id", "speaker_3_id", "speaker_4_id", "speaker_5_id",
        "speaker_6_id", "speaker_7_id", "speaker_8_id", "speaker_9_id", "speaker_10_id",
    ]
    update_cols = [c for c in cols if c != "call_id"]
    set_clause = ", ".join(f"{c} = excluded.{c}" for c in update_cols)

    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        values_sql_parts = []
        for r in batch:
            values_sql_parts.append("(" + ", ".join([
                pg_text(r["call_id"]),
                pg_text(r["title"]),
                pg_text(r["transcript"]),
                pg_text(r["url"]),
                pg_timestamp(r["call_date"]),
                pg_int(r["duration"]),
                pg_text(r["direction"]),
                pg_text(r["primary_user_id"]),
                pg_text(r["system"]),
                pg_text(r["scope"]),
                pg_text(r["media"]),
                pg_text(r["language"]),
                pg_text(r["workspace_id"]),
                pg_text(r["sdr_disposition"]),
                pg_text(r["client_unique_id"]),
                pg_text(r["purpose"]),
                pg_bool(r["is_private"]),
                pg_text(r["calendar_event_id"]),
                pg_jsonb(r["custom_data"]),
                pg_int(r["speaker_count"]),
                pg_timestamp(r["scheduled"]),
                pg_text(r["meeting_url"]),
                pg_text(r["speaker_1_id"]),
                pg_text(r["speaker_2_id"]),
                pg_text(r["speaker_3_id"]),
                pg_text(r["speaker_4_id"]),
                pg_text(r["speaker_5_id"]),
                pg_text(r["speaker_6_id"]),
                pg_text(r["speaker_7_id"]),
                pg_text(r["speaker_8_id"]),
                pg_text(r["speaker_9_id"]),
                pg_text(r["speaker_10_id"]),
            ]) + ")")

        sql = (
            f"INSERT INTO public.gong_call_list ({', '.join(cols)}) VALUES "
            + ", ".join(values_sql_parts)
            + f" ON CONFLICT (call_id) DO UPDATE SET {set_clause};"
        )
        try:
            supa_sql(sql)
            print(f"  upserted gong_call_list batch {i + len(batch)}/{len(rows)}")
        except Exception as e:
            print(f"  !! gong_call_list batch {i}-{i+len(batch)} failed: {str(e)[:200]}")

# ---------- main ----------

def get_high_water_mark() -> str:
    rs = supa_sql("select to_char(max(call_date), 'YYYY-MM-DD\"T\"HH24:MI:SS') || 'Z' as hwm from public.gong_calls;")
    if isinstance(rs, list) and rs:
        return rs[0]["hwm"]
    raise RuntimeError("Could not read high-water mark")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=None, help="ISO 8601 datetime, default = max(call_date) + 1s")
    parser.add_argument("--until", default=None, help="ISO 8601 datetime, default = now UTC")
    parser.add_argument("--dry-run", action="store_true", help="Fetch from Gong only, no DB writes")
    parser.add_argument("--limit-calls", type=int, default=None, help="Limit to first N calls (for testing)")
    args = parser.parse_args()

    if args.since:
        since = args.since
    else:
        hwm = get_high_water_mark()
        # add 1 second to avoid re-pulling the boundary call
        since = hwm
        print(f"High-water mark from DB: {hwm}")

    until = args.until or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    print(f"Pulling calls in window: {since}  →  {until}")
    print(f"Mode: {'DRY-RUN' if args.dry_run else 'WRITE'}")
    print()

    print("== Step 1: Fetch call list from Gong ==")
    calls = fetch_call_list(since, until)
    print(f"Total calls fetched: {len(calls)}")

    if args.limit_calls and len(calls) > args.limit_calls:
        calls = calls[: args.limit_calls]
        print(f"Limiting to first {args.limit_calls} for this run")

    if not calls:
        print("Nothing to do.")
        return

    call_ids = [str(c["id"]) for c in calls]

    print()
    print("== Step 2: Fetch transcripts ==")
    transcripts = fetch_transcripts(call_ids)
    print(f"Got transcripts for {len(transcripts)}/{len(call_ids)} calls")

    print()
    print("== Step 3: Build rows ==")
    rows = [build_row(c, transcripts.get(str(c["id"]))) for c in calls]
    with_transcript = sum(1 for r in rows if r["transcript"])
    avg_chars = (sum(len(r["transcript"] or "") for r in rows) // max(1, len(rows)))
    print(f"Rows built: {len(rows)} (with transcript: {with_transcript}, avg {avg_chars} chars)")

    if args.dry_run:
        print("\nDRY-RUN, skipping DB writes.")
        sample = rows[0]
        preview = {k: (v[:120] + "..." if isinstance(v, str) and len(v) > 120 else v) for k, v in sample.items()}
        print("Sample row:")
        print(json.dumps(preview, indent=2, default=str))
        return

    print()
    print("== Step 4: Upsert into gong_calls ==")
    upsert_gong_calls(rows)

    print()
    print("== Step 5: Upsert into gong_call_list ==")
    upsert_gong_call_list(rows)

    print()
    print("== Step 6: Verify final counts ==")
    rs = supa_sql(
        "select 'gong_calls' as t, count(*) as rows, max(call_date)::text as newest "
        "from public.gong_calls union all select 'gong_call_list', count(*), max(call_date)::text "
        "from public.gong_call_list;"
    )
    print(json.dumps(rs, indent=2))

    print("\nDONE.")

if __name__ == "__main__":
    main()
