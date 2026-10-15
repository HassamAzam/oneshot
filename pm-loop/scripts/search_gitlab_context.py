#!/usr/bin/env python3
"""Search arbisoft/erp for previous context on a topic: compact markdown lines, not issue JSON.

    search_gitlab_context.py "logs reminder" "project logs email"

Open issues are listed first and marked (open) — one asking for the same thing may
be a duplicate of the ticket being groomed. A keyword that fails is reported
and the others still return.
"""

from __future__ import annotations

import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pm_http  # noqa: E402
import pm_secrets  # noqa: E402

API = "https://gitlab.arbisoft.com/api/v4/projects/arbisoft%2Ferp"
PER_STATE = 3


def _search(keyword: str, state: str) -> list[dict]:
    query = urllib.parse.urlencode({"search": keyword, "state": state, "per_page": PER_STATE,
                                    "order_by": "updated_at", "sort": "desc"})
    return pm_http.json_request("GET", f"{API}/issues?{query}",
                                headers={"PRIVATE-TOKEN": pm_secrets.get("GITLAB_TOKEN")}, timeout=20)


def search(keywords: list[str]) -> list[str]:
    """Markdown lines: open issues first (possible duplicates), then closed; failures noted."""
    jobs = [(k, s) for k in keywords for s in ("opened", "closed")]
    found, failed = {}, []

    def run(job):
        try:
            return job, _search(*job)
        except (pm_http.NetworkError, pm_http.HTTPStatusError) as exc:
            return job, exc

    with ThreadPoolExecutor(max_workers=min(8, len(jobs) or 1)) as pool:
        for (keyword, _), result in pool.map(run, jobs):
            if isinstance(result, Exception):
                failed.append(keyword)
                continue
            for issue in result:
                found[issue["iid"]] = issue
    lines = []
    for issue in sorted(found.values(), key=lambda i: (i["state"] != "opened", -i["iid"])):
        if issue["state"] == "opened":
            lines.append(f"- [#{issue['iid']} — {issue['title']}]({issue['web_url']}) (open)")
        else:
            lines.append(f"- [#{issue['iid']} — {issue['title']}]({issue['web_url']}) "
                         f"(closed {(issue.get('closed_at') or '?')[:10]})")
    if failed:
        lines.append(f"(search failed for: {', '.join(sorted(set(failed)))})")
    return lines or ["(no previous context found)"]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: search_gitlab_context.py kw1 kw2 [kw3 ...]")
    print("\n".join(search(sys.argv[1:])))
