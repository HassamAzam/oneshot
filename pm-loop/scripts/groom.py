#!/usr/bin/env python3
"""Grooming CLI: Plane ticket → arbisoft/erp issue. The rules live here; the model writes title and body.

  groom.py resolve WORKSTREAMRE-230 [231 …]      ticket JSON, eligibility decided in code
  groom.py context "kw1" "kw2" "kw3"             previous-context markdown (open issues first)
  groom.py create --id WORKSTREAMRE-230 --title T [--from-issues 8602,8577] <<'GROOM_BODY'
  <body markdown>
  GROOM_BODY
  groom.py create --title T --kind bug --size S [--assignee user]            (one-shot, no Plane ticket)
  groom.py create --mr 10400 --title T --kind change --size S                (MR-to-ticket)
  groom.py attach --issue 8812 FILE [FILE …]     add files to an existing issue's ## Attachments
  groom.py mr 10400                              MR summary JSON
  groom.py sweep [--dry-run] [--notify]          release yellow changes whose tests a person merged
  groom.py ensure-labels [--confirm-labels "New Label"]

`create` re-checks eligibility right before writing, takes route/zone/kind/size
from the triage marker, asks Jev which layers the ticket needs (jev_layers.py), attaches the original documents, adds the Plane
Ticket / Requested By / Routing sections and the mandatory acceptance criteria,
creates the issue(s), back-links Plane and appends the sprint sheet. Add
`--dry-run` to see the labels and body without writing anything.
In the body, text after a `<!-- tests-scope -->` line becomes the
characterization-test issue's "Pin this behaviour" section (ai-tests route).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_documents  # noqa: E402
import groom_gitlab as gl  # noqa: E402
import jev_layers  # noqa: E402
import pm_http  # noqa: E402
import resolve_plane_ticket as plane  # noqa: E402
import search_gitlab_context  # noqa: E402
import sprint_plan_append  # noqa: E402

KINDS = ("bug", "feature", "change", "chore", "tech_debt")
SIZES = ("XS", "S", "M", "L", "XL")
LAYER_LABELS = {"backend": "Backend", "frontend": "Frontend"}
URGENT_PRIORITIES = ("high", "urgent")
TESTS_SCOPE_MARK = "<!-- tests-scope -->"
SELF_NAME = "Muhammad Nouman"
SHEET_ERRORS = (pm_http.NetworkError, pm_http.HTTPStatusError, KeyError, OSError, ImportError)
AC_BACKEND = "- [ ] Document API response times before and after MR"
AC_FRONTEND = "- [ ] On <screen> with dark theme on, all text and controls are readable and nothing overlaps"
DARK_THEME_RE = re.compile(r"dark theme", re.I)
FILLER_AC = re.compile(r"no regressions?|works? as expected|edge cases (are )?handled|best practices|"
                       r"code is clean|is fixed\b|should be resolved", re.I)


def _acceptance(body: str) -> list[str]:
    match = re.search(r"(?ms)^## Acceptance Criteria\n(.*?)(?=^## |\Z)", body)
    return [l for l in (match.group(1).splitlines() if match else []) if l.strip().startswith("- [")]


def light_triage(title: str, text: str, proposed: list[str]) -> dict:
    """Areas and zone for a ticket triage never saw (one-shot, MR): proposed areas plus keyword hits,
    most severe zone wins, no area = the map's default. The same rules triage applies; the route stays human."""
    zones = gl.map_file("zones.json")
    by_name = {a["name"]: a for a in zones["areas"]}
    haystack = f"{title} {text}".lower()
    areas = [a for a in dict.fromkeys(proposed) if a in by_name]
    for area in zones["areas"]:
        if area["name"] not in areas and any(re.search(r"\b" + re.escape(k.lower()), haystack) for k in area["keywords"]):
            areas.append(area["name"])
    order = zones["severity"]
    zone = max((by_name[a]["zone"] for a in areas), key=order.index) if areas else zones["default_zone"]
    return {"areas": areas, "zone": zone, "unknown_areas": [a for a in proposed if a not in by_name]}


def _spec(args: argparse.Namespace, ticket: dict | None, layers: list[str], light: dict | None = None) -> dict:
    """Route, zone and labels inputs: from the triage marker when there is one, else from flags."""
    triage = (ticket or {}).get("triage") or {}
    route = ticket["route"] if ticket else "human"
    ai_route = route in ("ai", "ai-tests")

    def pick(key: str, flag: str | None) -> str | None:
        """An AI route must keep what triage decided; a human route may be corrected by a flag."""
        return (triage.get(key) or flag) if ai_route else (flag or triage.get(key))

    spec = {"route": route, "kind": pick("kind", args.kind), "size": pick("size", args.size),
            "zone": triage.get("zone") or (light or {}).get("zone"),
            "areas": triage.get("areas") or (light or {}).get("areas") or [], "design": bool(triage.get("design")),
            "urgent": (ticket or {}).get("priority") in URGENT_PRIORITIES,
            "swimlanes": (ticket or {}).get("swimlanes") or [],
            "extra": [LAYER_LABELS[l] for l in layers if l in LAYER_LABELS],
            "reasons": triage.get("reasons") or []}
    if spec["kind"] not in KINDS or spec["size"] not in SIZES:
        raise gl.GroomError("kind and size are not in the triage marker: pass --kind and --size")
    return spec


def _finish_body(body: str, spec: dict, ticket: dict | None, docs: dict, jev: dict,
                 requested_by: str) -> str:
    """Add everything the model should not have to remember."""
    acs = _acceptance(body)
    if spec["route"] != "human":
        filler = [a for a in acs if FILLER_AC.search(a)]
        if filler:
            raise gl.GroomError(f"acceptance criteria Oneshot cannot pass or fail: {filler} — make them observable")
    layers = jev["layers"]
    extra_ac = []
    if "backend" in layers and spec["route"] == "human" and AC_BACKEND not in body:
        extra_ac.append(AC_BACKEND)
    if "frontend" in layers and not any(DARK_THEME_RE.search(a) for a in acs):
        raise gl.GroomError(f"frontend work needs a dark-theme criterion naming the screen: {AC_FRONTEND}")
    body = gl.add_section(body, "Acceptance Criteria", extra_ac)
    body = gl.add_section(body, "Attachments", [d["markdown"] for d in docs["attached"]])
    body = gl.add_section(body, "References", [f"- [{r['title']}]({r['url']})" for r in docs["references"]]
                       + [f"- ⚠️ [{p['save_as']}]({p['url']}) — private: share it or attach manually"
                          for p in docs["needs_connector"]])
    if "## Requested By" not in body:
        body = gl.add_section(body, "Requested By", [requested_by])
    if ticket:
        body = gl.add_section(body, "Plane Ticket", [ticket["id"]])
    zone = f" · zone {spec['zone']} ({', '.join(spec['areas']) or 'no area'})" if spec.get("zone") else ""
    why = f" — {'; '.join(spec['reasons'])}" if spec["reasons"] else ""
    note = (f" [{ticket['route_note']}]" if ticket and ticket.get("route_note")
            else "" if ticket else " [no triage: a person decides — add AI on GitLab to hand it to Oneshot]")
    probs = ", ".join(f"{k} {v:.2f}" for k, v in jev["probabilities"].items()) or "none"
    layer_line = f"Layers: {', '.join(layers)} — {jev['source']} ({probs})" + (f" — {jev['note']}" if jev["note"] else "")
    return gl.add_section(body, "Routing", [f"{spec['route']}{zone}{why} (size {spec['size']}, {spec['kind']}){note}",
                                            layer_line])


def create(args: argparse.Namespace) -> dict:
    ticket, resume = None, None
    if args.id:
        ticket = plane.resolve(args.id)
        if not ticket["eligible"]:
            return {"id": ticket["id"], "skipped": ticket["skip_reason"]}
        already = gl.existing_issues(ticket["id"])
        resume = gl.orphan_tests_issue(already)
        if already and not resume:
            named = ", ".join(f"#{issue['iid']}" for issue in already)
            return {"id": ticket["id"], "skipped": f"already on GitLab: {named} names this ticket (Plane back-link missing?)"}
    mr = gl.get_mr(args.mr) if args.mr else None
    refs = gl.closing_refs(f"{mr['title']}\n{mr['description']}") if mr else []
    if refs:
        return {"mr": args.mr, "skipped": f"MR already closes {', '.join(refs)}: mr-to-ticket is only for an MR without a ticket"}
    body = sys.stdin.read()
    source_text = ticket["description"] if ticket else (mr["description"] if mr else body)
    jev = jev_layers.decide(args.title if not ticket else ticket["name"], source_text)
    light = None if ticket else light_triage(args.title, body, [a.strip() for a in args.areas.split(",") if a.strip()])
    spec = _spec(args, ticket, jev["layers"], light)
    if resume and spec["route"] != "ai-tests":
        raise gl.GroomError(f"#{resume['iid']} is a tests issue left without its change issue, but this ticket now routes "
                            f"{spec['route']} — delete #{resume['iid']} on GitLab and rerun")
    body, _, scope = body.partition(TESTS_SCOPE_MARK)
    docs = collect_documents.collect(ticket["uuid"] if ticket else None, args.from_issues, dry_run=args.dry_run)
    requested_by = ticket["requested_by"] if ticket else mr["author_name"] if mr else SELF_NAME
    body = _finish_body(body, spec, ticket, docs, jev, requested_by)
    labels = gl.compose_labels(spec)
    tests_labels = gl.compose_labels(spec, for_tests_issue=True) if spec["route"] == "ai-tests" else []
    every_label = list(dict.fromkeys(labels + tests_labels))
    unlabelled = gl.unlabelled(spec) + [f"unknown area {a}" for a in (light or {}).get("unknown_areas", [])]
    if args.dry_run:
        return {"dry_run": True, "route": spec["route"], "labels": labels, "layers": jev,
                "resumes_tests_issue": resume["iid"] if resume else None,
                "label_reasons": label_reasons(spec, every_label, jev),
                "needs_user_yes": gl.needs_yes(every_label),
                "tests_labels": tests_labels,
                "documents": docs, "unlabelled": unlabelled, "body": body}
    approved = frozenset(l.strip() for l in (args.confirm_labels or "").split(",") if l.strip())
    assignee = mr["author_id"] if mr else (gl.user_id(args.assignee) if args.assignee else None)
    made = gl.create_issues(spec, args.title, body, scope, assignee, ticket["id"] if ticket else None, approved,
                            resume_tests=resume)
    log_jev_decision(made["issue"]["iid"], ticket["id"] if ticket else None,
                     ticket["name"] if ticket else args.title, source_text, jev, spec["route"], body)
    out = {"id": ticket["id"] if ticket else None, "route": spec["route"], "zone": spec.get("zone"),
           "issue": made["issue"], "tests_issue": made["tests_issue"], "milestone": made["milestone"]["title"],
           "unlabelled": unlabelled, "layers": jev,
           "documents": {"attached": len(docs["attached"]), "private": [p["url"] for p in docs["needs_connector"]],
                         "failed": docs["failed"]}}
    if ticket:
        tests = made["tests_issue"]
        note = f' (characterization tests first: <a href="{tests["url"]}">#{tests["iid"]}</a>)' if tests else ""
        out["plane"] = plane.post_groom(ticket["uuid"], made["issue"]["url"], made["issue"]["iid"], note)
    if mr:
        gl.link_mr(args.mr, made["issue"]["url"])
        out["mr"] = f"!{args.mr} now closes #{made['issue']['iid']} ([closes {made['issue']['url']}] ends its description)"
    rows = [{"url": made["issue"]["url"], "title": args.title}]
    if made["tests_issue"]:
        rows.append({"url": made["tests_issue"]["url"], "title": f"Characterization tests: {args.title}"})
    try:
        out["sheet"] = sprint_plan_append.append_rows(made["milestone"]["title"], rows)
    except SHEET_ERRORS as exc:
        out["sheet"] = f"FAILED: {exc} — rerun: sprint_plan_append.py --milestone '{made['milestone']['title']}' --rows '{json.dumps(rows)}'"
    return out


SWEEP_SEEN = Path.home() / ".cache" / "pm-loop" / "sweep_seen.json"
JEV_DECISIONS = Path.home() / "Documents" / "ai" / "jev-findings" / "heartbeat" / "decisions.jsonl"
SKILL_FILE = Path.home() / ".claude" / "skills" / "ticket-grooming" / "SKILL.md"
UNKNOWN_RE = re.compile(r"\bunknown\b", re.I)


def skill_version() -> str:
    """Short hash of the grooming skill text, so outcomes can be compared per skill version."""
    try:
        return hashlib.sha256(SKILL_FILE.read_bytes()).hexdigest()[:10]
    except OSError:
        return "unknown"


def log_jev_decision(issue_iid: int, ticket_id: str | None, title: str, text: str, jev: dict,
                     route: str = "human", body: str = "") -> None:
    """What Jev decided at grooming time, so the heartbeat scores the decision that actually drove Oneshot."""
    JEV_DECISIONS.parent.mkdir(parents=True, exist_ok=True)
    record = {"iid": issue_iid, "ticket": ticket_id, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "model": jev_layers.MODEL, "title": title, "description": text[:jev_layers.DESCRIPTION_CHARS],
              "source": jev["source"], "layers": jev["layers"], "probabilities": jev["probabilities"],
              "facts": jev.get("facts"), "route": route, "skill": skill_version(),
              "unknown_lines": sum(1 for line in body.splitlines() if UNKNOWN_RE.search(line))}
    with JEV_DECISIONS.open("a") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
SLACK_POST = Path(__file__).resolve().parent / "slack_post.py"


def notify_sweep(actions: list[dict], dry_run: bool) -> list[str]:
    """Post each NEW release or hold to Slack once; quiet otherwise. Returns what was posted."""
    seen = json.loads(SWEEP_SEEN.read_text()) if SWEEP_SEEN.exists() else {}
    lines, now = [], {}
    for a in actions:
        if a["action"] == "waiting":
            continue
        key, state = str(a["issue"]), f"{a['action']}|{a.get('why', '')}"
        now[key] = state
        if seen.get(key) == state:
            continue
        if a["action"] in ("added Loop", "would add Loop"):
            cause = f"tests !{a['tests_mr']} merged" if a.get("tests_mr") else a.get("why", "")
            lines.append(f"#{a['issue']}: {cause} — {a['action']} (Oneshot starts)")
        elif a["action"] == "failed":
            lines.append(f"sweep FAILED (posted once until the error changes): {a['why']}")
        else:
            lines.append(f"#{a['issue']}: held — {a['why']}")
    if lines:
        prefix = "[shadow] " if dry_run else ""
        text = prefix + "Yellow-zone sweep:\n" + "\n".join(lines)
        subprocess.run([sys.executable, str(SLACK_POST), "--text", text], check=False, timeout=60)
    SWEEP_SEEN.parent.mkdir(parents=True, exist_ok=True)
    SWEEP_SEEN.write_text(json.dumps(now))
    return lines


def label_reasons(spec: dict, labels: list[str], layers: dict) -> dict:
    """Why each label is on the issue, so the user can approve them knowingly."""
    m, why = gl.label_map(), {}
    sources = [(m["kind"].get(spec.get("kind")), f"kind {spec.get('kind')} (triage marker or --kind)"),
               (m["size"].get(spec.get("size")), f"size {spec.get('size')} (triage marker or --size)"),
               (m["zone"].get(spec.get("zone")), f"zone {spec.get('zone')} from the zone map"),
               (m["priority"]["urgent"] if spec.get("urgent") else None, "Plane priority high/urgent"),
               (m["flow"]["design"] if spec.get("design") else None, "triage design flag"),
               (m["flow"]["accessibility"] if "Accessibility" in spec.get("swimlanes", []) else None,
                "Plane swimlane Accessibility")]
    sources += [(m["area"].get(a), f"area {a} (triage)") for a in spec.get("areas", [])]
    sources += [(m["swimlane"].get(s), f"Plane swimlane {s}") for s in spec.get("swimlanes", [])]
    probs = layers.get("probabilities", {})
    sources += [(m["layer"][l], f"Jev layer {l}" + (f" (p={probs[l]:.2f})" if l in probs else " (Jev fallback)"))
                for l in ("backend", "frontend") if l in layers.get("layers", [])]
    sources += [(m["flow"]["ai"], f"route {spec['route']}"), (m["flow"]["loop"], "route ai: Oneshot starts"),
                (m["flow"]["review"], "route ai-tests: human gates"),
                (m["flow"]["characterization_tests"], "tests issue for a yellow route")]
    for label, reason in sources:
        if label and label in labels and label not in why:
            why[label] = reason
    return {label: why.get(label, "requested") for label in labels}


def _csv_ints(value: str) -> list[int]:
    return [int(v) for v in value.split(",") if v.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("resolve").add_argument("ids", nargs="+")
    sub.add_parser("context").add_argument("keywords", nargs="+")
    c = sub.add_parser("create")
    source = c.add_mutually_exclusive_group()
    source.add_argument("--id", help="Plane ticket, e.g. WORKSTREAMRE-230")
    source.add_argument("--mr", type=int, help="MR iid, for MR-to-ticket")
    c.add_argument("--title", required=True)
    c.add_argument("--from-issues", type=_csv_ints, default=[], help="erp iids used as Previous Context")
    c.add_argument("--areas", default="", help="one-shot / MR only: zones.json area names, as triage would propose them")
    c.add_argument("--kind", choices=KINDS, help="only when the triage marker has none")
    c.add_argument("--size", choices=SIZES, help="only when the triage marker has none")
    c.add_argument("--assignee", help="GitLab username (human route / one-shot)")
    c.add_argument("--dry-run", action="store_true")
    c.add_argument("--confirm-labels", help="labels the user said yes to: new ones, or ask_first (Opensource, Plane team)")
    a = sub.add_parser("attach")
    a.add_argument("--issue", type=int, required=True)
    a.add_argument("files", nargs="+")
    sub.add_parser("mr").add_argument("iid", type=int)
    sweeper = sub.add_parser("sweep")
    sweeper.add_argument("--dry-run", action="store_true")
    sweeper.add_argument("--notify", action="store_true", help="post new releases/holds to Slack (cron)")
    sub.add_parser("ensure-labels").add_argument("--confirm-labels", default="",
                                                 help="new labels the user agreed to create")
    args = parser.parse_args()
    try:
        if args.command == "resolve":
            out = plane.resolve_many(args.ids)
            for t in out:
                if t.get("eligible"):
                    t["layers"] = jev_layers.decide(t["name"], t["description"])
        elif args.command == "context":
            print("\n".join(search_gitlab_context.search(args.keywords)))
            return 0
        elif args.command == "create":
            out = create(args)
        elif args.command == "attach":
            docs = collect_documents.collect(files=args.files)
            gl.append_to_section(args.issue, "Attachments", [d["markdown"] for d in docs["attached"]])
            out = {"attached": [d["name"] for d in docs["attached"]], "failed": docs["failed"]}
        elif args.command == "mr":
            out = gl.get_mr(args.iid)
        elif args.command == "sweep":
            try:
                out = gl.sweep(args.dry_run)
            except (gl.GroomError, pm_http.NetworkError, pm_http.HTTPStatusError) as exc:
                if args.notify:
                    notify_sweep([{"issue": "sweep", "action": "failed", "why": str(exc)[:300]}], args.dry_run)
                raise
            if args.notify:
                notify_sweep(out, args.dry_run)
        else:
            out = gl.ensure_labels(frozenset(l.strip() for l in args.confirm_labels.split(",") if l.strip()))
    except (gl.GroomError, ValueError, pm_http.NetworkError, pm_http.HTTPStatusError) as exc:
        print(json.dumps({"error": str(exc)}))
        return 1
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
