#!/usr/bin/env python3
"""Append groomed tickets to the Workstream Sprint Plan sheet — one atomic append per batch.

    sprint_plan_append.py --milestone "Sprint 65" --url URL --title TITLE
    sprint_plan_append.py --milestone "Sprint 65" --rows '[{"url": "...", "title": "..."}]'

Library: append_rows(milestone, rows). Uses the Sheets values:append call, so
two runs at once cannot overwrite each other's row. The sprint tab is created
from the newest tab when missing. Timeouts and retries live in pm_http.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pm_http  # noqa: E402

SHEET_ID = "1AlB2dhNMLnzM_67x4pDiVEQBmPwTw66QngpY0JcA2go"
KEY_PATH = Path.home() / ".claude/service-accounts/workstream-sprint-plan.json"
API = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}"
ROW_FORMAT = {"horizontalAlignment": "LEFT", "wrapStrategy": "CLIP", "verticalAlignment": "MIDDLE",
              "textFormat": {"bold": False}}
_token: str | None = None


def _b64url(data) -> str:
    return base64.urlsafe_b64encode(data if isinstance(data, bytes) else data.encode()).rstrip(b"=").decode()


def token() -> str:
    """Service-account access token, minted once per process."""
    global _token
    if _token:
        return _token
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    sa = json.loads(KEY_PATH.read_text())
    now = int(time.time())
    head = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}))
    claims = _b64url(json.dumps({"iss": sa["client_email"], "scope": "https://www.googleapis.com/auth/spreadsheets",
                                 "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now + 3600}))
    key = serialization.load_pem_private_key(sa["private_key"].encode(), password=None)
    sig = _b64url(key.sign(f"{head}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256()))
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                   "assertion": f"{head}.{claims}.{sig}"}).encode()
    raw, _ = pm_http.request("POST", "https://oauth2.googleapis.com/token", data=body,
                             headers={"Content-Type": "application/x-www-form-urlencoded"})
    _token = json.loads(raw)["access_token"]
    return _token


def _api(method: str, path: str, payload=None):
    return pm_http.json_request(method, f"{API}{path}", headers={"Authorization": f"Bearer {token()}"},
                                payload=payload)


def _tabs() -> dict:
    """Tab title → sheet id, in sheet order (newest sprint first)."""
    sheets = _api("GET", "?fields=sheets.properties")["sheets"]
    return {s["properties"]["title"]: s["properties"]["sheetId"] for s in sheets}


def _create_tab(name: str, source_id: int) -> None:
    """Duplicate the newest sprint tab, clear its rows below the header, retitle it."""
    new_id = _api("POST", ":batchUpdate", {"requests": [{"duplicateSheet": {
        "sourceSheetId": source_id, "insertSheetIndex": 0, "newSheetName": name}}]}
    )["replies"][0]["duplicateSheet"]["properties"]["sheetId"]
    _api("POST", ":batchUpdate", {"requests": [
        {"updateCells": {"range": {"sheetId": new_id, "startRowIndex": 2, "endRowIndex": 200,
                                   "startColumnIndex": 0, "endColumnIndex": 10},
                         "fields": "userEnteredValue,userEnteredFormat"}},
        {"updateCells": {"range": {"sheetId": new_id, "startRowIndex": 0, "endRowIndex": 1,
                                   "startColumnIndex": 1, "endColumnIndex": 2},
                         "rows": [{"values": [{"userEnteredValue": {"stringValue": f"{name} Plan"}}]}],
                         "fields": "userEnteredValue"}}]})


def append_rows(milestone: str, rows: list[dict]) -> dict:
    """Append [{url, title}] to the milestone's tab in one call; return the rows written."""
    if not rows:
        return {"appended": 0}
    tabs = _tabs()
    if milestone not in tabs:
        _create_tab(milestone, next(iter(tabs.values())))
        tabs = _tabs()
    values = [[f'=HYPERLINK("{r["url"]}","{r["url"]}") & " - {r["title"].replace(chr(34), chr(39))}"']
              for r in rows]
    rng = urllib.parse.quote(f"'{milestone}'!B:B")
    updated = _api("POST", f"/values/{rng}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE",
                   {"values": values})["updates"]["updatedRange"]
    numbers = [int(n) for n in re.findall(r"\d+", updated.split("!")[-1])]
    first, last = numbers[0], numbers[-1]
    _api("POST", ":batchUpdate", {"requests": [{"repeatCell": {
        "range": {"sheetId": tabs[milestone], "startRowIndex": first - 1, "endRowIndex": last,
                  "startColumnIndex": 1, "endColumnIndex": 2},
        "cell": {"userEnteredFormat": ROW_FORMAT},
        "fields": "userEnteredFormat(horizontalAlignment,wrapStrategy,verticalAlignment,textFormat.bold)"}}]})
    return {"appended": len(rows), "range": updated}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--milestone", required=True)
    parser.add_argument("--url")
    parser.add_argument("--title")
    parser.add_argument("--rows", help='JSON list of {"url", "title"}')
    args = parser.parse_args()
    rows = json.loads(args.rows) if args.rows else [{"url": args.url, "title": args.title}]
    if not all(r.get("url") and r.get("title") for r in rows):
        parser.error("give --url and --title, or --rows")
    print(json.dumps(append_rows(args.milestone, rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
