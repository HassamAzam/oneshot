"""GitLab side of grooming (library for groom.py): labels, issues, the yellow tests-first flow, MRs.

Labels are composed here from the triage routing and checked against the erp
repo's .claude/labels.json (origin/dev) before any write: the GitLab API
silently creates any unknown label name.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.parse
from functools import lru_cache
from pathlib import Path

import pm_http
import pm_secrets

API = "https://gitlab.arbisoft.com/api/v4/projects/arbisoft%2Ferp"
ERP_PROJECT_ID = 304
GITLAB_ASSIGNEE = 1167
ERP_REPO = os.environ.get("ERP_REPO", str(Path.home() / "Documents/ai/claude/Workstream/erp"))
MAP_REF = "origin/dev"
TESTS_FIRST_RE = re.compile(r"<!--\s*tests-first:\s*#(\d+)\s*-->")
CLOSES_RE = re.compile(r"^Closes #\d+\s*\n*")


class GroomError(RuntimeError):
    """A grooming step that must stop the ticket, with a reason a PM can act on."""


def call(method: str, path: str, payload=None):
    """The erp project API; every failure becomes a GroomError."""
    try:
        return pm_http.json_request(method, f"{API}/{path}" if path else API,
                                    headers={"PRIVATE-TOKEN": pm_secrets.get("GITLAB_TOKEN")}, payload=payload)
    except (pm_http.NetworkError, pm_http.HTTPStatusError) as exc:
        raise GroomError(str(exc)) from exc


# ── Label allow-list ─────────────────────────────────────────────

@lru_cache(maxsize=4)
def map_file(name: str) -> dict:
    """.claude/<name> from PM_LOOP_MAP_DIR, else the erp repo's origin/dev (reviewed and merged only)."""
    override = os.environ.get("PM_LOOP_MAP_DIR")
    try:
        if override:
            return json.loads(Path(override, name).read_text())
        subprocess.run(["git", "-C", ERP_REPO, "fetch", "--quiet", "origin", "dev"],
                       capture_output=True, timeout=30, check=False)
        shown = subprocess.run(["git", "-C", ERP_REPO, "show", f"{MAP_REF}:.claude/{name}"],
                               capture_output=True, text=True, timeout=30, check=True)
        return json.loads(shown.stdout)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise GroomError(f".claude/{name} not readable from {MAP_REF} — merge it, "
                         f"or set PM_LOOP_MAP_DIR to trial a draft") from exc


def label_map() -> dict:
    """The label allow-list."""
    return map_file("labels.json")


def allowed_names() -> set[str]:
    """Every label name grooming may put on an issue."""
    labels = label_map()
    names = set(labels["creatable"])
    for key, group in labels.items():
        if isinstance(group, dict) and key not in ("creatable", "retired"):
            names |= {v for v in group.values() if isinstance(v, str)}
    return names - set(labels.get("retired", {}).get("names", []))


def compose_labels(spec: dict, *, for_tests_issue: bool = False) -> list[str]:
    """The label list for one issue, from the routing spec — never from free text."""
    labels, picked = label_map(), []
    change_only = not for_tests_issue
    if change_only and spec.get("kind"):
        picked.append(labels["kind"][spec["kind"]])
    if change_only and spec.get("size"):
        picked.append(labels["size"][spec["size"]])
    if spec.get("zone"):
        picked.append(labels["zone"][spec["zone"]])
    if change_only and spec.get("urgent"):
        picked.append(labels["priority"]["urgent"])
    picked += [labels["area"][a] for a in spec.get("areas") or [] if a in labels["area"]]
    picked += [labels["swimlane"][s] for s in spec.get("swimlanes") or [] if s in labels["swimlane"]]
    if "Accessibility" in (spec.get("swimlanes") or []):
        picked.append(labels["flow"]["accessibility"])
    if change_only and spec.get("design"):
        picked.append(labels["flow"]["design"])
    picked += [e for e in spec.get("extra") or [] if e]
    if for_tests_issue:
        picked.append(labels["flow"]["characterization_tests"])
    elif spec["route"] == "ai":
        picked += [labels["flow"]["ai"], labels["flow"]["loop"]]
    elif spec["route"] == "ai-tests":
        picked += [labels["flow"]["ai"], labels["flow"]["review"]]
    return list(dict.fromkeys(picked))


def unlabelled(spec: dict) -> list[str]:
    """Areas and swimlanes that have no GitLab label, so the output says so instead of dropping them."""
    labels = label_map()
    silent = {"Delivered", "Needs Discussion/Pending", "Accessibility"}
    return ([f"area {a}" for a in spec.get("areas") or [] if a not in labels["area"]]
            + [f"swimlane {s}" for s in spec.get("swimlanes") or [] if s not in labels["swimlane"] and s not in silent])


def _live_labels() -> set[str]:
    names, page = set(), 1
    while True:
        batch = call("GET", f"labels?per_page=100&page={page}")
        names |= {label["name"] for label in batch}
        if len(batch) < 100:
            return names
        page += 1


def needs_yes(names: list[str], approved: frozenset = frozenset()) -> list[str]:
    """Labels the user must confirm: any not yet on GitLab (would be created), and the ask_first list."""
    ask_first, live = set(label_map().get("ask_first", [])), _live_labels()
    return [n for n in dict.fromkeys(names) if (n not in live or n in ask_first) and n not in approved]


def check_labels(names: list[str], approved: frozenset = frozenset()) -> None:
    """Raise unless every name is allow-listed and any new or ask_first label was confirmed; create confirmed new ones."""
    outside = [n for n in names if n not in allowed_names()]
    if outside:
        raise GroomError(f"labels not in .claude/labels.json: {outside}")
    pending = needs_yes(names, approved)
    if pending:
        raise GroomError(f"check with the user first: {pending} (new, or flagged in ask_first) — "
                         f"rerun with --confirm-labels once they agree")
    live, creatable = _live_labels(), label_map()["creatable"]
    blocked = [n for n in names if n not in live and n not in creatable]
    if blocked:
        raise GroomError(f"labels missing on arbisoft/erp and not creatable: {blocked}")
    for name in (n for n in names if n not in live):
        call("POST", "labels", {"name": name, **creatable[name]})


def ensure_labels(approved: frozenset = frozenset()) -> dict:
    """Create the creatable labels the user confirmed; list the rest that are still missing."""
    live = _live_labels()
    missing = [n for n in label_map()["creatable"] if n not in live]
    created = [n for n in missing if n in approved]
    for name in created:
        call("POST", "labels", {"name": name, **label_map()["creatable"][name]})
    return {"created": created, "awaiting_confirmation": [n for n in missing if n not in approved],
            "missing": sorted(n for n in allowed_names() - set(label_map()["creatable"]) if n not in live)}


# ── Lookups ──────────────────────────────────────────────────────

def active_milestone() -> dict:
    """The current erp sprint."""
    milestones = call("GET", "milestones?state=active&per_page=1&order_by=due_date&sort=desc")
    if not milestones:
        raise GroomError("no active milestone on arbisoft/erp")
    return {"id": milestones[0]["id"], "title": milestones[0]["title"]}


def user_id(username: str) -> int:
    """GitLab username → id, so the skill can assign by name."""
    users = pm_http.json_request("GET", f"https://gitlab.arbisoft.com/api/v4/users?username="
                                 f"{urllib.parse.quote(username.lstrip('@'))}",
                                 headers={"PRIVATE-TOKEN": pm_secrets.get("GITLAB_TOKEN")})
    if not users:
        raise GroomError(f"no GitLab user {username!r}")
    return users[0]["id"]


# ── Issues ───────────────────────────────────────────────────────

def existing_issue(ticket_id: str) -> int | None:
    """An erp issue that already names this Plane ticket — the second duplicate guard.

    The Plane back-link is the first; this one still holds when the back-link
    write failed, or a tests-first run died between its two issues.
    """
    number = ticket_id.rsplit("-", 1)[-1]
    exact = re.compile(rf"(?m)^(WORKSTREAMRE|WS)-{number}\s*$")
    for term in (f"WORKSTREAMRE-{number}", f"WS-{number}"):
        query = urllib.parse.urlencode({"search": term, "in": "description", "scope": "all", "per_page": 20})
        for issue in call("GET", f"issues?{query}"):
            if exact.search(issue.get("description") or ""):
                return issue["iid"]
    return None


def _new_issue(title: str, body: str, labels: list[str], milestone: dict, assignee: int | None) -> dict:
    payload = {"title": title, "description": body, "labels": ",".join(labels), "milestone_id": milestone["id"]}
    if assignee:
        payload["assignee_ids"] = [assignee]
    issue = call("POST", "issues", payload)
    return {"iid": issue["iid"], "url": issue["web_url"], "labels": labels}


def _tests_body(change_title: str, areas: list[str], scope: str, ticket_id: str | None) -> str:
    return f"""## Why this issue exists
"{change_title}" touches a **yellow** delivery zone ({', '.join(areas) or 'no area named'} in
`.claude/zones.json`). Before Oneshot changes it, characterization tests pin what the code does
**today**, odd parts included.

## Pin this behaviour
{scope.strip() or '- The flows named in the change issue, as they behave on dev today.'}

## Rules
- Written, or reviewed line by line, by a person — never by the session that will make the change.
- Tests only: no behaviour change in this MR.
- Oneshot refuses this ticket: never add `Loop` to it.
- The change is released to Oneshot (the sweep adds `Loop`) only when this issue is closed by a merged MR
  from a person's branch that changes test files only. Anything else is held and posted to Slack.

## Change it unblocks
CHANGE_ISSUE_PLACEHOLDER
""" + (f"\n## Plane Ticket\n{ticket_id}\n" if ticket_id else "")


def create_issues(spec: dict, title: str, body: str, tests_scope: str, assignee: int | None,
                  ticket_id: str | None = None, approved: frozenset = frozenset()) -> dict:
    """Create the issue(s) for one route. Labels are checked before anything is written."""
    change_labels = compose_labels(spec)
    tests_labels = compose_labels(spec, for_tests_issue=True) if spec["route"] == "ai-tests" else []
    check_labels(change_labels + tests_labels, approved)
    milestone = active_milestone()
    out = {"milestone": milestone, "tests_issue": None}
    if tests_labels:
        tests = _new_issue(f"Characterization tests: {title}", _tests_body(title, spec.get("areas") or [], tests_scope, ticket_id),
                           tests_labels, milestone, assignee or GITLAB_ASSIGNEE)
        body = (f"## Tests first\nOneshot starts after #{tests['iid']} closes with a merged MR "
                f"(the sweep then adds `Loop`).\n<!-- tests-first: #{tests['iid']} -->\n\n{body}")
        out["tests_issue"] = tests
    human_assignee = (assignee or GITLAB_ASSIGNEE) if spec["route"] == "human" else None
    out["issue"] = _new_issue(title, body, change_labels, milestone, human_assignee)
    if out["tests_issue"]:
        tests = out["tests_issue"]
        desc = call("GET", f"issues/{tests['iid']}")["description"]
        call("PUT", f"issues/{tests['iid']}",
             {"description": desc.replace("CHANGE_ISSUE_PLACEHOLDER", f"#{out['issue']['iid']}")})
        call("POST", f"issues/{out['issue']['iid']}/links",
             {"target_project_id": ERP_PROJECT_ID, "target_issue_iid": tests["iid"]})
    return out


def add_section(body: str, heading: str, lines: list[str]) -> str:
    """Append lines under `## heading`, creating the section at the end if it is absent."""
    if not lines:
        return body
    marker = f"## {heading}\n"
    block = "\n".join(lines)
    if marker not in body:
        return body.rstrip() + f"\n\n{marker}{block}\n"
    head, tail = body.split(marker, 1)
    rest = re.split(r"(?m)^## ", tail, maxsplit=1)
    section = rest[0].rstrip() + "\n" + block + "\n\n"
    return head + marker + section + (("## " + rest[1]) if len(rest) > 1 else "")


def append_to_section(iid: int, heading: str, lines: list[str]) -> None:
    """Add lines under `## heading` in an existing issue's body."""
    desc = call("GET", f"issues/{iid}")["description"] or ""
    call("PUT", f"issues/{iid}", {"description": add_section(desc, heading, lines)})


# ── MRs ──────────────────────────────────────────────────────────

def get_mr(iid: int) -> dict:
    mr = call("GET", f"merge_requests/{iid}")
    return {"iid": iid, "title": mr["title"], "description": mr.get("description") or "",
            "author_id": mr["author"]["id"], "author_name": mr["author"]["name"],
            "source_branch": mr["source_branch"], "target_branch": mr["target_branch"], "url": mr["web_url"]}


def link_mr(mr_iid: int, issue_iid: int) -> None:
    """Prepend `Closes #issue` to the MR description, replacing an existing leading Closes."""
    desc = call("GET", f"merge_requests/{mr_iid}").get("description") or ""
    call("PUT", f"merge_requests/{mr_iid}", {"description": f"Closes #{issue_iid}\n\n{CLOSES_RE.sub('', desc)}"})


# ── Sweep: release yellow changes whose tests merged ─────────────

AGENT_BRANCH_PREFIXES = ("oneshot/", "oneloop/")
TEST_PATH_RE = re.compile(r"(^|/)(tests?|__tests__|testdata|fixtures)/|(^|/)(test_[^/]*|[^/]*_tests?\.py|tests\.py|"
                          r"conftest\.py|factories\.py|[^/]*\.test\.[jt]sx?|[^/]*\.spec\.[jt]sx?)$")


def _mr_files(mr_iid: int) -> list[str]:
    files, page = [], 1
    while True:
        batch = call("GET", f"merge_requests/{mr_iid}/diffs?per_page=100&page={page}")
        files += [d["new_path"] for d in batch]
        if len(batch) < 100:
            return files
        page += 1


def tests_mr_problem(mr: dict) -> str | None:
    """Why this merged MR does not count as person-written characterization tests, or None."""
    if mr["source_branch"].startswith(AGENT_BRANCH_PREFIXES):
        return f"!{mr['iid']} came from an agent branch ({mr['source_branch']}) — tests must be written by a person"
    files = _mr_files(mr["iid"])
    if not files:
        return f"!{mr['iid']} changed no files"
    code = [f for f in files if not TEST_PATH_RE.search(f)]
    if code:
        return f"!{mr['iid']} also changes non-test files: {', '.join(code[:5])}"
    return None


# 'Not a Bug' stops a ticket only on a project whose Oneshot config sets labels.notABug. erp leaves it
# empty, so that stop leaves no label at all and loop_was_removed is what actually catches it.
STOP_LABELS = ("Needs Human", "Merged", "merged", "Not a Bug", "Characterization Tests")
LOOP_REMOVED = ("Loop was removed from this ticket (Oneshot stopped it, or a person dropped it) — "
                "add Loop by hand to overrule")


def loop_was_removed(iid: int, loop: str) -> bool:
    """Whether Loop was ever taken off this issue: Oneshot stopped it, or a person dropped it.

    Both leave AI without Loop, which is exactly what a person's fresh AI label looks like. Oneshot's
    Not a Bug stop removes Loop and adds labels.notABug only when one is configured, and erp has none;
    removing Loop is also how runner.ts tells a person to drop a ticket. Reading the current labels,
    the sweep put Loop back every hour, and a re-added Loop resumes a QA-confirmed Not a Bug run
    straight into plan. Only the label history tells the two apart. A failed read raises, so the
    sweep stops rather than guessing.
    """
    page = 1
    while True:
        batch = call("GET", f"issues/{iid}/resource_label_events?per_page=100&page={page}")
        if any((event.get("label") or {}).get("name") == loop and event.get("action") == "remove" for event in batch):
            return True
        if len(batch) < 100:
            return False
        page += 1


def promote_person_ai(dry_run: bool) -> list[dict]:
    """A person decided a ticket is Oneshot's by adding AI: add Loop so Oneshot picks it up.

    Skipped: yellow changes still waiting for their tests (the tests-first flow releases those), tickets
    carrying a stop label, and the tests issues themselves. Held and reported: red, because Oneshot's
    zone guard would stop it at the plan anyway, and any ticket whose Loop was ever removed, because
    that removal was a stop (loop_was_removed).
    """
    flow, zone = label_map()["flow"], label_map()["zone"]
    query = urllib.parse.urlencode({"state": "opened", "labels": flow["ai"], "not[labels]": flow["loop"], "per_page": 100})
    actions = []
    for issue in call("GET", f"issues?{query}"):
        labels = set(issue.get("labels") or [])
        if labels & set(STOP_LABELS) or TESTS_FIRST_RE.search(issue.get("description") or ""):
            continue
        entry = {"issue": issue["iid"], "why": "AI added by a person"}
        if zone["red"] in labels:
            actions.append({**entry, "action": "none",
                            "why": "AI added by a person, but the zone is red — Oneshot's zone guard would stop it; "
                                   "keep it with people or change .claude/zones.json by MR"})
            continue
        if loop_was_removed(issue["iid"], flow["loop"]):
            actions.append({**entry, "action": "none", "why": LOOP_REMOVED})
            continue
        if not dry_run:
            call("PUT", f"issues/{issue['iid']}", {"add_labels": flow["loop"]})
        actions.append({**entry, "action": "would add Loop" if dry_run else "added Loop"})
    return actions


def sweep(dry_run: bool) -> list[dict]:
    """Add Loop to each waiting yellow change whose tests issue was closed by a person's tests-only MR.

    A change Oneshot already stopped or finished carries a stop label and is not waiting, so it is left
    alone. Every waiting change is reported, released or not — nothing is skipped silently, including
    one whose Loop was removed after release: its marker and merged tests MR are permanent, so without
    the label history it would be released again every hour.
    """
    flow, zone = label_map()["flow"], label_map()["zone"]
    query = urllib.parse.urlencode({"state": "opened", "labels": f"{flow['ai']},{zone['yellow']}",
                                    "not[labels]": flow["loop"], "per_page": 100})
    actions = []
    for issue in call("GET", f"issues?{query}"):
        if set(issue.get("labels") or []) & set(STOP_LABELS):
            continue
        entry = {"issue": issue["iid"]}
        match = TESTS_FIRST_RE.search(issue.get("description") or "")
        if not match:
            continue
        tests_iid = entry["tests_issue"] = int(match.group(1))
        if call("GET", f"issues/{tests_iid}")["state"] != "closed":
            actions.append({**entry, "action": "waiting", "why": "tests issue still open"})
            continue
        merged = [mr for mr in call("GET", f"issues/{tests_iid}/closed_by") if mr.get("state") == "merged"]
        if not merged:
            actions.append({**entry, "action": "none", "why": "tests issue closed without a merged MR — a person decides"})
            continue
        verdicts = [(mr, tests_mr_problem(mr)) for mr in merged]
        good = [mr for mr, problem in verdicts if not problem]
        if not good:
            actions.append({**entry, "action": "none",
                            "why": "; ".join(p for _, p in verdicts) + " — a person decides"})
            continue
        if loop_was_removed(issue["iid"], flow["loop"]):
            actions.append({**entry, "action": "none", "why": LOOP_REMOVED})
            continue
        if not dry_run:
            call("PUT", f"issues/{issue['iid']}", {"add_labels": flow["loop"]})
        actions.append({**entry, "action": "would add Loop" if dry_run else "added Loop", "tests_mr": good[0]["iid"]})
    return actions + promote_person_ai(dry_run)
