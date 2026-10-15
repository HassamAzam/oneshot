#!/usr/bin/env python3
"""Plane side of grooming: resolve tickets, decide eligibility, write the back-link.

Library for groom.py; also runnable: `resolve_plane_ticket.py WORKSTREAMRE-230 231`.

Eligibility fails CLOSED: a ticket whose comments cannot be read is not
eligible, because an unread back-link is how duplicates (WS-232) happen.
"""

from __future__ import annotations

import html
import json
import re
import sys
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pm_http  # noqa: E402
import pm_secrets  # noqa: E402

BASE = "https://projects.arbisoft.com/api/v1/workspaces/arbisoft"
PROJECT = "6b2ba1a2-8234-498f-81f2-e4ab3b3cb923"
PREFIX = "WORKSTREAMRE"
INCOMING = "8ddee932-cc47-4acf-98a3-2a56812f3cb4"
REQ_SCOPING = "e28f87f0-3c4c-4b1d-9475-560dbbc47526"
CACHE_DIR = Path.home() / ".cache" / "pm-loop"
CACHE_TTL = 86400
DESCRIPTION_CHARS = 4000
BACKLINK_TEXT = "GitLab issue created:"
BACKLINK_RE = re.compile(re.escape(BACKLINK_TEXT) + r'\s*<a href="(?P<url>[^"]+)">#(?P<iid>\d+)</a>')
MARKER_RE = re.compile(r"<!--\s*workstream-triage\s+v\d+\s+outcome=([a-z-]+)([^>]*?)\s*-->")
ATTR_RE = re.compile(r'(\w+)=(?:"([^"]*)"|(\S+))')
AI_ROUTES = ("ai", "ai-tests")


def _headers() -> dict:
    return {"x-api-key": pm_secrets.get("PLANE_API_KEY")}


def _get(path: str):
    return pm_http.json_request("GET", f"{BASE}/{path}", headers=_headers())


def _results(data) -> list:
    return data.get("results", []) if isinstance(data, dict) else (data or [])


def _cached(name: str, path: str) -> list:
    """A 24h file cache for slow-changing lists (members, labels)."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = CACHE_DIR / f"{name}.json"
    if cache.exists() and time.time() - cache.stat().st_mtime < CACHE_TTL:
        return json.loads(cache.read_text())
    data = _results(_get(path))
    cache.write_text(json.dumps(data))
    return data


def full_name(member_id: str) -> str:
    """Member id → 'First Last' (the Requested By line), falling back to display name."""
    for m in _cached("members", "members/"):
        mem = m.get("member", m)
        if mem.get("id") == member_id:
            name = f"{mem.get('first_name') or ''} {mem.get('last_name') or ''}".strip()
            return name or (mem.get("display_name") or "Unknown").replace(".", " ").title()
    return "Unknown"


def label_names(ids: list) -> list[str]:
    """Plane label ids → names (the swimlanes)."""
    names = {l["id"]: l["name"] for l in _cached("labels", f"projects/{PROJECT}/labels/")}
    return [names.get(i, i) for i in ids or []]


def plain_text(description_html: str) -> str:
    """Readable text from Plane's HTML, links kept as 'text (url)'."""
    text = re.sub(r'<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', r"\2 (\1)", description_html or "", flags=re.S)
    text = re.sub(r"<(br|/p|/li|/h\d)[^>]*>", "\n", text)
    text = re.sub(r"<li[^>]*>", "- ", text)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:DESCRIPTION_CHARS]


def parse_routing(attrs: str) -> dict | None:
    """The routing a v2 triage marker recorded, or None."""
    found = {k: q if q else b for k, q, b in ATTR_RE.findall(attrs or "")}
    if "route" not in found:
        return None
    dash = lambda k: None if found.get(k) in (None, "-") else found[k]  # noqa: E731
    return {"route": found["route"], "size": dash("size"), "kind": dash("kind"), "zone": dash("zone"),
            "areas": [] if dash("areas") is None else found["areas"].split(","),
            "design": found.get("design") == "1",
            "reasons": [r for r in (found.get("why") or "").split("; ") if r]}


def effective_route(routing: dict | None) -> tuple[str, str | None]:
    """The route grooming applies: an AI route needs a zone, else people."""
    if not routing:
        return "human", "no triage route"
    if routing["route"] in AI_ROUTES and not routing.get("zone"):
        return "human", "triage marker predates zones"
    if routing["route"] in (*AI_ROUTES, "human"):
        return routing["route"], None
    return "human", f"triage route {routing['route']!r} is not a board route"


def _stamp(value) -> datetime:
    """Plane timestamps carry offsets; compare them as instants, never as strings."""
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)


def normalise_id(raw: str) -> str:
    """'230', 'WORKSTREAMRE-230' or 'ws-230' → 'WORKSTREAMRE-230'; other projects are refused."""
    raw = raw.strip().upper()
    if raw.isdigit():
        return f"{PREFIX}-{raw}"
    match = re.fullmatch(r"([A-Z]+)-(\d+)", raw)
    if not match or match.group(1) not in (PREFIX, "WS"):
        raise ValueError(f"{raw}: only {PREFIX}-N tickets are groomed by this skill")
    return f"{PREFIX}-{match.group(2)}"


def resolve(raw_id: str) -> dict:
    """Everything grooming needs about one ticket, with eligibility decided in code."""
    ticket_id = normalise_id(raw_id)
    item = _get(f"work-items/{ticket_id}/")
    out = {"id": ticket_id, "uuid": item["id"], "name": item.get("name", ""),
           "description": plain_text(item.get("description_html") or ""),
           "priority": item.get("priority") or "none",
           "swimlanes": label_names(item.get("labels") or []), "eligible": False, "skip_reason": None}
    base = f"projects/{PROJECT}/issues/{item['id']}"
    with ThreadPoolExecutor(max_workers=4) as pool:
        creator = pool.submit(full_name, item.get("created_by", ""))
        comments_f = pool.submit(lambda: _results(_get(f"{base}/comments/")))
        attachments_f = pool.submit(lambda: _results(_get(f"{base}/issue-attachments/")))
        links_f = pool.submit(lambda: _results(_get(f"{base}/links/")))
    out["requested_by"] = creator.result()
    try:
        comments = comments_f.result()
    except (pm_http.NetworkError, pm_http.HTTPStatusError) as exc:
        out["skip_reason"] = f"comments unreadable, so the duplicate check cannot run — retry ({exc})"
        return out

    backlink = next((m for c in comments for m in [BACKLINK_RE.search(c.get("comment_html") or "")] if m), None)
    markers = [(_stamp(c.get("created_at")), m) for c in comments
               for m in [MARKER_RE.search(c.get("comment_html") or "")] if m]
    marker = max(markers, key=lambda pair: pair[0])[1] if markers else None
    routing = parse_routing(marker.group(2)) if marker else None
    route, route_note = effective_route(routing)
    out.update(triage_outcome=marker.group(1) if marker else None, triage=routing,
               route=route, route_note=route_note)

    routed = item.get("state") == REQ_SCOPING and routing and routing["route"] in (*AI_ROUTES, "human")
    try:
        has_material = bool(out["description"].strip() or attachments_f.result() or links_f.result())
    except (pm_http.NetworkError, pm_http.HTTPStatusError) as exc:
        out["skip_reason"] = f"attachments/links unreadable — retry ({exc})"
        return out
    if backlink:
        out["skip_reason"] = f"already groomed: GitLab #{backlink.group('iid')}"
    elif not has_material:
        out["skip_reason"] = ("nothing to groom: no description, attachments or links — "
                              "triage should send it back to the client as needs-info")
    elif item.get("state") != INCOMING and not routed:
        out["skip_reason"] = "not in Incoming and not routed to a board by triage"
    out["eligible"] = out["skip_reason"] is None
    return out


def post_groom(uuid: str, gitlab_url: str, gitlab_iid: int, note: str = "") -> dict:
    """Back-link comment (the exact text the duplicate check and sync read) + Requirement Scoping."""
    comment = f'<p>{BACKLINK_TEXT} <a href="{gitlab_url}">#{gitlab_iid}</a>{note}</p>'
    base = f"{BASE}/projects/{PROJECT}/issues/{uuid}"
    with ThreadPoolExecutor(max_workers=2) as pool:
        c = pool.submit(pm_http.json_request, "POST", f"{base}/comments/", headers=_headers(),
                        payload={"comment_html": comment})
        s = pool.submit(pm_http.json_request, "PATCH", f"{base}/", headers=_headers(), payload={"state": REQ_SCOPING})
    out = {}
    for name, fut in (("backlink", c), ("state", s)):
        try:
            fut.result()
            out[name] = "ok"
        except (pm_http.NetworkError, pm_http.HTTPStatusError) as exc:
            out[name] = f"FAILED: {exc}"
    return out


def resolve_many(ids: list[str]) -> list[dict]:
    """Resolve several tickets in parallel; one failure does not sink the rest."""
    def one(raw):
        try:
            return resolve(raw)
        except (ValueError, pm_http.NetworkError, pm_http.HTTPStatusError) as exc:
            return {"id": raw, "eligible": False, "skip_reason": str(exc)}
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(one, ids))


if __name__ == "__main__":
    print(json.dumps(resolve_many(sys.argv[1:]), indent=2))
