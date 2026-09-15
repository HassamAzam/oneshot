#!/usr/bin/env python3
"""Mirror a Plane ticket into a GitLab issue and link it from an MR.

Deterministic executor for the `/link-plane-ticket` command. The command reads
the Plane ticket through the Plane MCP and hands the resolved fields to this
script as a single JSON object on stdin; this script does *only* the GitLab
work, idempotently:

    1. Read the target MR (for its current description and assignee).
    2. Reuse an existing `plane-import` issue for the same Plane key if one is
       already open; otherwise create a new one (title + body mirrored from the
       Plane ticket, with a backlink, priority/state, and a hidden key marker).
    3. Ensure the tracking label exists.
    4. Prepend `[closes #<iid>]` to the MR description unless already present.

Before creating a new issue this also runs a fuzzy similarity check against open
issues (title token overlap). If candidates are found it makes no changes and
returns `needs_decision` so the caller can surface them and let a human pick.

Input (stdin JSON):
    {
      "mr_iid": 10569,                       # required
      "plane_key": "WORKSTREAMFE-24",        # required
      "plane_url": "https://projects.arbisoft.com/arbisoft/browse/WORKSTREAMFE-24/",
      "title": "<Plane ticket name>",        # required
      "description_html": "<Plane description_html>",
      "priority": "none",
      "state_name": "Done",
      "project": "arbisoft%2Ferp",           # optional, url-encoded path or numeric id
      "label": "plane-import",               # optional, defaults to plane-import
      "force_create": false,                 # optional, skip the similarity check
      "link_issue_iid": 412                  # optional, link this issue instead of creating
    }

Output (stdout JSON), one of:
    {"ok": true, "issue_iid": 412, "issue_url": "...",
     "issue_action": "created|reused|linked", "mr_updated": true}
    {"ok": true, "needs_decision": true, "similar": [
        {"iid": 410, "title": "...", "web_url": "...", "score": 0.62}]}

Auth: reads the GitLab token from $GITLAB_ERP_ACCESS_TOKEN.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

API_BASE = "https://gitlab.arbisoft.com/api/v4"
DEFAULT_PROJECT = "arbisoft%2Ferp"
DEFAULT_LABEL = "plane-import"
LABEL_COLOR = "#6699cc"
KEY_MARKER = "<!-- plane-key: {key} -->"
SIMILARITY_THRESHOLD = 0.35
SIMILARITY_LIMIT = 5
STOPWORDS = {
    "the", "and", "for", "with", "from", "this", "that", "are", "not", "all",
    "page", "web", "ui", "story", "bug", "task", "issue", "fix", "when", "have",
    "has", "such", "must", "should", "their", "they", "its", "use", "using",
}


def _die(message: str) -> None:
    sys.stdout.write(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def _token() -> str:
    token = os.environ.get("GITLAB_ERP_ACCESS_TOKEN")
    if not token:
        _die("GITLAB_ERP_ACCESS_TOKEN is not set in the environment.")
    return token


def _api(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, object]:
    """Call the GitLab REST API; return (status_code, parsed_json_or_text)."""
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url=url, data=data, method=method)
    request.add_header("PRIVATE-TOKEN", token)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, raw


class _HtmlToMarkdown(HTMLParser):
    """Minimal, deterministic HTML -> Markdown reducer for Plane descriptions."""

    _BLOCK_TAGS = {"p", "div", "h1", "h2", "h3", "h4", "tr", "li"}

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._href: str | None = None
        self._link_text: list[str] = []
        self._in_link = False

    def handle_starttag(self, tag, attrs):
        if tag in ("strong", "b"):
            self._parts.append("**")
        elif tag in ("em", "i"):
            self._parts.append("_")
        elif tag in ("h1", "h2", "h3", "h4"):
            self._parts.append("\n\n### ")
        elif tag == "li":
            self._parts.append("\n- ")
        elif tag == "br":
            self._parts.append("\n")
        elif tag in ("td", "th"):
            self._parts.append(" | ")
        elif tag == "a":
            self._in_link = True
            self._link_text = []
            self._href = dict(attrs).get("href")

    def handle_endtag(self, tag):
        if tag in ("strong", "b"):
            self._parts.append("**")
        elif tag in ("em", "i"):
            self._parts.append("_")
        elif tag == "a" and self._in_link:
            text = "".join(self._link_text).strip() or (self._href or "")
            self._parts.append(f"[{text}]({self._href})" if self._href else text)
            self._in_link = False
            self._href = None
        elif tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data):
        if self._in_link:
            self._link_text.append(data)
        else:
            self._parts.append(data)

    def text(self) -> str:
        collapsed = re.sub(r"\n{3,}", "\n\n", "".join(self._parts))
        return "\n".join(line.rstrip() for line in collapsed.splitlines()).strip()


def html_to_markdown(html: str) -> str:
    if not html:
        return ""
    parser = _HtmlToMarkdown()
    parser.feed(html)
    return parser.text()


def build_issue_body(payload: dict) -> str:
    key = payload["plane_key"]
    plane_url = payload.get("plane_url", "")
    rows = [
        f"| Plane key | `{key}` |",
        f"| Priority | {payload.get('priority') or 'none'} |",
        f"| State | {payload.get('state_name') or 'unknown'} |",
    ]
    body = payload.get("description_markdown")
    if body is None:
        body = html_to_markdown(payload.get("description_html", ""))
    backlink = f"[Plane ticket {key}]({plane_url})" if plane_url else f"Plane ticket {key}"
    return (
        f"{backlink}\n\n"
        "| Field | Value |\n|---|---|\n" + "\n".join(rows) + "\n\n"
        "---\n\n"
        f"{body}\n\n"
        f"{KEY_MARKER.format(key=key)}\n"
    )


def find_existing_issue(project: str, key: str, token: str) -> dict | None:
    query = urllib.parse.quote(key, safe="")
    status, issues = _api(
        "GET",
        f"/projects/{project}/issues?search={query}&state=opened&per_page=50",
        token,
    )
    if status != 200 or not isinstance(issues, list):
        return None
    marker = KEY_MARKER.format(key=key)
    for issue in issues:
        if marker in (issue.get("description") or "") or key in (issue.get("title") or ""):
            return issue
    return None


def title_tokens(text: str) -> set[str]:
    """Distinctive lowercase word tokens from a ticket title.

    Strips leading `[Story]`-style tags and `WEB:`-style prefixes, drops
    stopwords and short tokens so the overlap score reflects meaningful terms.
    """
    text = re.sub(r"^\s*(\[[^\]]*\]\s*)+", " ", text)
    text = re.sub(r"\b[A-Za-z]{2,5}:\s*", " ", text)
    tokens = re.findall(r"[a-zA-Z][a-zA-Z0-9]+", text.lower())
    return {t for t in tokens if len(t) > 2 and t not in STOPWORDS}


def find_similar_issues(project: str, title: str, token: str) -> list[dict]:
    """Open issues whose title token-overlaps the Plane title above threshold.

    Searches GitLab one distinctive keyword at a time (ILIKE-safe regardless of
    whether advanced search is enabled), then re-scores candidates by Jaccard
    overlap of title tokens.
    """
    plane_tokens = title_tokens(title)
    if not plane_tokens:
        return []
    candidates: dict[int, dict] = {}
    for keyword in sorted(plane_tokens, key=len, reverse=True)[:3]:
        query = urllib.parse.quote(keyword, safe="")
        status, issues = _api(
            "GET",
            f"/projects/{project}/issues?search={query}&in=title&state=opened&per_page=50",
            token,
        )
        if status == 200 and isinstance(issues, list):
            for issue in issues:
                candidates[issue["iid"]] = issue
    scored = []
    for issue in candidates.values():
        other = title_tokens(issue.get("title") or "")
        if not other:
            continue
        overlap = len(plane_tokens & other) / len(plane_tokens | other)
        if overlap >= SIMILARITY_THRESHOLD:
            scored.append(
                {
                    "iid": issue["iid"],
                    "title": issue["title"],
                    "web_url": issue["web_url"],
                    "score": round(overlap, 2),
                }
            )
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:SIMILARITY_LIMIT]


def ensure_label(project: str, label: str, token: str) -> None:
    status, _ = _api(
        "POST",
        f"/projects/{project}/labels",
        token,
        {"name": label, "color": LABEL_COLOR},
    )
    if status not in (201, 400, 409):
        sys.stderr.write(f"[warn] could not create label {label!r} (status {status})\n")


def mr_assignee_ids(mr: dict) -> list[int]:
    assignee = mr.get("assignee")
    if assignee and assignee.get("id"):
        return [assignee["id"]]
    return [a["id"] for a in (mr.get("assignees") or []) if a.get("id")]


def add_closes_line(description: str | None, issue_iid: int) -> tuple[str, bool]:
    """Return (new_description, changed). Prepend `[closes #<iid>]` if absent."""
    description = description or ""
    if re.search(rf"\[closes\s+#{issue_iid}\b", description, re.IGNORECASE):
        return description, False
    closes = f"[closes #{issue_iid}]"
    return (f"{closes}\n\n{description}".rstrip() + "\n", True)


def link_and_emit(project: str, mr: dict, issue: dict, action: str, token: str) -> None:
    """Add the `[closes #<iid>]` line to the MR and print the result JSON."""
    issue_iid = issue["iid"]
    mr_iid = mr["iid"]
    new_description, changed = add_closes_line(mr.get("description"), issue_iid)
    if changed:
        status, _ = _api(
            "PUT",
            f"/projects/{project}/merge_requests/{mr_iid}",
            token,
            {"description": new_description},
        )
        if status != 200:
            _die(f"resolved issue #{issue_iid} but failed to update MR (status {status})")
    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "issue_iid": issue_iid,
                "issue_url": issue["web_url"],
                "issue_action": action,
                "mr_iid": mr_iid,
                "mr_url": mr.get("web_url"),
                "mr_updated": changed,
            }
        )
    )


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        _die(f"invalid stdin JSON: {error}")

    for field in ("mr_iid", "plane_key", "title"):
        if not payload.get(field):
            _die(f"missing required field: {field}")

    token = _token()
    project = payload.get("project") or DEFAULT_PROJECT
    label = payload.get("label") or DEFAULT_LABEL
    mr_iid = payload["mr_iid"]
    key = payload["plane_key"]

    status, mr = _api("GET", f"/projects/{project}/merge_requests/{mr_iid}", token)
    if status != 200 or not isinstance(mr, dict):
        _die(f"could not fetch MR !{mr_iid} (status {status}): {mr}")

    if payload.get("link_issue_iid"):
        link_iid = payload["link_issue_iid"]
        status, issue = _api("GET", f"/projects/{project}/issues/{link_iid}", token)
        if status != 200 or not isinstance(issue, dict):
            _die(f"could not fetch issue #{link_iid} to link (status {status}): {issue}")
        link_and_emit(project, mr, issue, "linked", token)
        return

    existing = find_existing_issue(project, key, token)
    if existing:
        link_and_emit(project, mr, existing, "reused", token)
        return

    if not payload.get("force_create"):
        similar = find_similar_issues(project, payload["title"], token)
        if similar:
            sys.stdout.write(
                json.dumps(
                    {
                        "ok": True,
                        "needs_decision": True,
                        "similar": similar,
                        "mr_iid": mr_iid,
                        "plane_key": key,
                    }
                )
            )
            return

    ensure_label(project, label, token)
    status, issue = _api(
        "POST",
        f"/projects/{project}/issues",
        token,
        {
            "title": payload["title"],
            "description": build_issue_body(payload),
            "labels": label,
            "assignee_ids": mr_assignee_ids(mr),
        },
    )
    if status != 201 or not isinstance(issue, dict):
        _die(f"could not create issue (status {status}): {issue}")
    link_and_emit(project, mr, issue, "created", token)


if __name__ == "__main__":
    main()
