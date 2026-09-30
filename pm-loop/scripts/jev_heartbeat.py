#!/usr/bin/env python3
"""Jev eval heartbeat: score Jev's layer decisions in batches of 50 finished tickets.

    jev_heartbeat.py            check for a new batch (daily cron); posts a table to Slack when one completes
    jev_heartbeat.py --table    print the history table
    jev_heartbeat.py --reseed   rebuild batch 0 (the baseline) from scratch

Truth = the files the ticket's own merged MRs changed. Bundled MRs (Adhoc-* hotfix
bundles, dev/stage/master promotions and back-merges) carry other tickets' changes,
so they never count; a ticket with no clean merged MR is excluded and counted.
backend = Python or Django templates under apps/ common/ hrdb/ templates/;
frontend = frontend/; migration = a migrations/ file.

Each batch scores Jev pinned (jev_layers.MODEL, re-asked now with the current facts),
the jev-latest alias as an upgrade candidate, Jev as logged at grooming (fallbacks
count as "load everything", which is what production did), and the old keyword
table as a fixed baseline. Every ticket is scored once; its MRs and files are kept.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import groom_gitlab as gl  # noqa: E402
import jev_layers  # noqa: E402
import pm_http  # noqa: E402
import pm_secrets  # noqa: E402
import resolve_plane_ticket as plane  # noqa: E402

HOME = Path.home() / "Documents" / "ai" / "jev-findings"
DIR = HOME / "heartbeat"
HISTORY = DIR / "history.json"
TABLE = DIR / "HEARTBEAT.md"
DECISIONS = DIR / "decisions.jsonl"
BASELINE_DATA = HOME / "experiments" / "agent_alloc" / "dataset.json"
SLACK_POST = Path(__file__).resolve().parent / "slack_post.py"
BATCH = 50
LAYERS = jev_layers.LAYERS
CANDIDATE_MODEL = "jev-latest"
WORKSTREAMAI = 1491
BUNDLE_SOURCES = ("dev", "stage", "master", "main")
BUNDLE_PREFIXES = ("adhoc", "release", "backmerge", "back-merge")
KEYWORDS = {
    "backend": ["api", "endpoint", "model", "migration", "serializer", "view", "celery", "admin", "signal", "query", "n+1"],
    "frontend": ["ui", "component", "page", "modal", "form field", "dark mode", "responsive", "style", "dropdown", "filter"],
    "migration": ["migration", "new field", "add field", "add column", "new model", "backfill", "new type"],
}


# ── truth ────────────────────────────────────────────────────────

def _api(project: int, path: str):
    return pm_http.json_request("GET", f"https://gitlab.arbisoft.com/api/v4/projects/{project}/{path}",
                                headers={"PRIVATE-TOKEN": pm_secrets.get("GITLAB_TOKEN")})


def _files(project: int, mr_iid: int) -> list[str]:
    files, page = [], 1
    while True:
        batch = _api(project, f"merge_requests/{mr_iid}/diffs?per_page=100&page={page}")
        files += [d["new_path"] for d in batch]
        if len(batch) < 100:
            return files
        page += 1


def is_bundle(mr: dict) -> bool:
    """A promotion, back-merge or hotfix bundle: its diff holds other tickets' work."""
    source = mr["source_branch"].lower()
    return source in BUNDLE_SOURCES or source.startswith(BUNDLE_PREFIXES)


def layers_of(files: list[str]) -> dict:
    return {"backend": any((re.match(r"(apps|common|hrdb)/", f) and f.endswith(".py")) or f.startswith("templates/")
                           for f in files),
            "frontend": any(f.startswith("frontend/") for f in files),
            "migration": any("/migrations/" in f for f in files)}


def truth(iid: int, project: int = gl.ERP_PROJECT_ID, mrs: list[dict] | None = None) -> dict | None:
    """{layers, mrs, files} from the ticket's own merged MRs; {excluded: why} for bundles only; None if unfinished."""
    if mrs is None:
        mrs = [m for m in _api(project, f"issues/{iid}/closed_by") if m.get("state") == "merged"]
        if not mrs:
            mrs = [m for m in _api(project, f"issues/{iid}/related_merge_requests")
                   if m.get("state") == "merged" and m.get("project_id") == project
                   and m.get("target_branch") in ("dev", "stage", "master")]
    if not mrs:
        return None
    clean = [m for m in mrs if not is_bundle(m)]
    if not clean:
        return {"excluded": "only bundled MRs (" + ", ".join(m["source_branch"] for m in mrs)[:120] + ")"}
    files = [f for m in clean for f in _files(project, m["iid"])]
    if not files:
        return {"excluded": "merged MRs changed no files"}
    return {"layers": layers_of(files), "mrs": [m["iid"] for m in clean], "files": files}


# ── candidates ───────────────────────────────────────────────────

def logged_decisions() -> dict[int, dict]:
    if not DECISIONS.exists():
        return {}
    rows = [json.loads(line) for line in DECISIONS.read_text().splitlines() if line.strip()]
    return {r["iid"]: {**r, "origin": "plane"} for r in rows}


def backlinked_tickets(errors: list) -> dict[int, dict]:
    """Every erp issue a Plane back-link names, with the Plane text grooming saw. Scan errors are collected."""
    items, cursor = [], None
    while True:
        page = plane._get(f"projects/{plane.PROJECT}/issues/?per_page=100" + (f"&cursor={cursor}" if cursor else ""))
        items += page["results"]
        cursor = page.get("next_cursor")
        if not page.get("next_page_results"):
            break

    def link(item):
        try:
            for c in plane._results(plane._get(f"projects/{plane.PROJECT}/issues/{item['id']}/comments/")):
                m = plane.BACKLINK_RE.search(c.get("comment_html") or "")
                if m and "/arbisoft/erp/" in m.group("url"):
                    return int(m.group("iid")), {"iid": int(m.group("iid")), "origin": "plane",
                                                 "ticket": f"{plane.PREFIX}-{item['sequence_id']}",
                                                 "title": item.get("name", ""),
                                                 "description": plane.plain_text(item.get("description_html") or "")}
        except (pm_http.NetworkError, pm_http.HTTPStatusError) as exc:
            errors.append(f"{plane.PREFIX}-{item.get('sequence_id')}: {exc}"[:120])
        return None

    with ThreadPoolExecutor(8) as pool:
        return dict(p for p in pool.map(link, items) if p)


# ── scoring ──────────────────────────────────────────────────────

def keyword(text: str, layer: str) -> bool:
    return any(re.search(rf"(?<![a-z]){re.escape(w)}(s|es)?(?![a-z])", text) for w in KEYWORDS[layer])


def _acc(pairs: list[tuple[bool, bool]]) -> float | None:
    return round(sum(p == t for p, t in pairs) / len(pairs), 3) if pairs else None


def score(rows: list[dict], skip_below: dict) -> dict:
    """Per layer: pinned / candidate / at-grooming / keyword accuracy, positives, skip safety."""
    out = {}
    for layer in LAYERS:
        truth_l = [r["truth"][layer] for r in rows]
        pinned = [r["jev_now"][layer] for r in rows]
        groomed = [(r["jev_groom"][layer], r["truth"][layer]) for r in rows if r.get("jev_groom") is not None]
        th = skip_below.get(layer, 0.5)
        out[layer] = {
            "positives": sum(truth_l),
            "jev_now_acc": _acc([(p > 0.5, t) for p, t in zip(pinned, truth_l)]),
            "candidate_acc": _acc([(r["jev_candidate"][layer] > 0.5, r["truth"][layer]) for r in rows
                                   if r.get("jev_candidate")]),
            "jev_groom_acc": _acc([(p > 0.5, t) for p, t in groomed]),
            "jev_groom_n": len(groomed),
            "keyword_acc": _acc([(keyword(f"{r['title']} {r['description']}".lower(), layer), r["truth"][layer])
                                 for r in rows]),
            "skip_below": th,
            "correct_skips": sum(1 for p, t in zip(pinned, truth_l) if p < th and not t),
            "unneeded": sum(1 for t in truth_l if not t),
            "wrong_skips": [r["iid"] for r, p, t in zip(rows, pinned, truth_l) if p < th and t],
        }
    return out


def significant(p1: float | None, n1: int, p2: float | None, n2: int) -> bool:
    """Is the change bigger than the 95% noise band of two proportions?"""
    if p1 is None or p2 is None or not n1 or not n2:
        return False
    se = math.sqrt(max(p1 * (1 - p1), 1e-9) / n1 + max(p2 * (1 - p2), 1e-9) / n2)
    return abs(p1 - p2) > 1.96 * se


def build_row(row: dict, truth_: dict, facts: list[str]) -> dict:
    """Score inputs for one ticket: pinned now, candidate alias, and the grooming-time decision if logged."""
    pinned, _ = jev_layers.ask(row["title"], row["description"], facts)
    candidate, answered = jev_layers.ask(row["title"], row["description"], facts, model=CANDIDATE_MODEL)
    groom = None
    if row.get("source") == "jev":
        groom = row["probabilities"]
    elif row.get("source") == "fallback":
        groom = {k: 1.0 for k in LAYERS}
    return {"iid": row["iid"], "origin": row.get("origin", "plane"), "title": row["title"],
            "description": row["description"], "truth": truth_["layers"], "mrs": truth_["mrs"],
            "files": truth_["files"], "jev_now": pinned, "jev_candidate": candidate, "candidate_model": answered,
            "jev_groom": groom, "groom_fallback": row.get("source") == "fallback",
            "groom_facts": row.get("facts")}


def batch_record(number: int, rows: list[dict], facts: list[str], skip: dict, note: str | None) -> dict:
    return {"batch": number, "date": date.today().isoformat(), "n": len(rows), "model": jev_layers.MODEL,
            "candidate_model": sorted({r["candidate_model"] for r in rows}), "facts": jev_layers.facts_hash(facts),
            "skip_below": skip, "note": note, "fallbacks_at_grooming": sum(r["groom_fallback"] for r in rows),
            "iids": [str(r["iid"]) for r in rows], "scores": score(rows, skip),
            "by_origin": {o: score([r for r in rows if r["origin"] == o], skip)
                          for o in sorted({r["origin"] for r in rows})},
            "rows": [{k: r[k] for k in ("iid", "origin", "truth", "mrs", "files", "jev_now", "jev_candidate",
                                        "jev_groom")} for r in rows],
            "ablation": ablation(rows, facts, skip) if facts else []}


def ablation(rows: list[dict], facts: list[str], skip: dict) -> list[dict]:
    """Re-score with each fact removed (mutation testing for facts): a fact that changes nothing can go."""
    full = score(rows, skip)
    out = []
    for i, fact in enumerate(facts):
        without = facts[:i] + facts[i + 1:]
        probs = [jev_layers.ask(r["title"], r["description"], without)[0] for r in rows]
        s = score([{**r, "jev_now": p} for r, p in zip(rows, probs)], skip)
        delta = {l: round((s[l]["jev_now_acc"] - full[l]["jev_now_acc"]) * 100) for l in LAYERS}
        wrong = {l: len(s[l]["wrong_skips"]) - len(full[l]["wrong_skips"]) for l in LAYERS}
        verdict = "keep" if any(delta.values()) or any(wrong.values()) else "no effect — candidate to drop"
        out.append({"fact": fact[:80], "accuracy_delta_without": delta, "extra_wrong_skips_without": wrong,
                    "verdict": verdict})
    return out


# ── history ──────────────────────────────────────────────────────

def _workstreamai_mrs(dataset: list[dict]) -> dict[str, list[dict]]:
    """Oneshot MRs on workstreamai, keyed by the dataset's 'ws<iid>'."""
    mrs, page = [], 1
    while True:
        batch = _api(WORKSTREAMAI, f"merge_requests?state=merged&per_page=100&page={page}")
        mrs += batch
        if len(batch) < 100:
            break
        page += 1
    out = {}
    for m in mrs:
        found = re.match(r"oneshot/ticket-(\d+)-", m["source_branch"])
        if found:
            out.setdefault(f"ws{found.group(1)}", []).append(m)
    return out


def seed_history(facts: list[str], skip: dict) -> tuple[dict, list[str]]:
    """Batch 0 rebuilt from the 44-ticket evaluation set under today's truth rules."""
    dataset = json.loads(BASELINE_DATA.read_text())
    ws_mrs = _workstreamai_mrs(dataset)
    excluded, rows = [], []
    for r in dataset:
        is_ws = str(r["iid"]).startswith("ws")
        t = truth(0, WORKSTREAMAI, ws_mrs.get(str(r["iid"]), [])) if is_ws else truth(int(r["iid"]))
        if not t or "excluded" in t:
            excluded.append(f"{r['iid']}: {(t or {}).get('excluded', 'no merged MR')}")
            continue
        rows.append(build_row({**r, "origin": "workstreamai" if is_ws else "plane"}, t, facts))
    note = (f"baseline, rebuilt {date.today().isoformat()} under the bundle-free truth rule "
            f"({len(rows)} of {len(dataset)} tickets; {len(excluded)} excluded). Inputs: Plane text for 'plane' "
            f"tickets, GitLab Current State for Oneshot/workstreamai ones — later batches are Plane-only, so compare "
            f"them with the plane subset below.")
    return {"batches": [batch_record(0, rows, facts, skip, note)]}, excluded


def _facts() -> tuple[list[str], dict]:
    facts_file = gl.map_file("erp-facts.json")
    return facts_file.get("facts", []), facts_file.get("layer_skip_below", {})


def load_history() -> dict:
    if HISTORY.exists():
        return json.loads(HISTORY.read_text())
    history, _ = seed_history(*_facts())
    HISTORY.write_text(json.dumps(history, indent=1))
    return history


def _pct(v):
    return "—" if v is None else f"{v:.0%}"


def _cell(cur: dict, prev: dict | None, n: int, prev_n: int, key: str = "jev_now_acc") -> str:
    value = cur[key]
    if not prev or value is None or prev.get(key) is None:
        return _pct(value)
    d = round((value - prev[key]) * 100)
    mark = "*" if significant(value, n, prev[key], prev_n) else ""
    return f"{_pct(value)} ({'+' if d >= 0 else ''}{d}{mark})"


def render(history: dict, status: str) -> str:
    lines = ["# Jev heartbeat — layer decisions per 50 finished tickets", "",
             f"_Status: {status}_", "",
             "Truth = files changed by the ticket's own merged MRs (bundles excluded). Δ in points vs the previous "
             "batch; `*` = bigger than the 95% noise band, anything else is noise at n≈50. "
             "Wrong skips must stay 0: they are layers Jev would have dropped that the MR needed.", "",
             "| Batch | Date | n | Pinned | Backend | Frontend | Migration | jev-latest B/F/M | Keyword B/F/M "
             "| At grooming B/F/M (n, fallbacks) | Wrong skips B/F/M | Loads avoided B · F · M | Positives B/F/M | Facts |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    prev = None
    for b in history["batches"]:
        s, n = b["scores"], b["n"]
        cells = [_cell(s[l], prev and prev["scores"][l], n, prev["n"] if prev else 0) for l in LAYERS]
        cand = "/".join(_pct(s[l]["candidate_acc"]) for l in LAYERS)
        cand_model = ",".join(b.get("candidate_model") or [])
        if cand_model:
            cand += f" ({cand_model})"
        kw = "/".join(_pct(s[l]["keyword_acc"]) for l in LAYERS)
        g_n = s["backend"]["jev_groom_n"]
        groom = ("/".join(_pct(s[l]["jev_groom_acc"]) for l in LAYERS) + f" ({g_n}, {b.get('fallbacks_at_grooming', 0)})"
                 if g_n else "—")
        wrong = "/".join(str(len(s[l]["wrong_skips"])) for l in LAYERS)
        avoided = " · ".join(f"{s[l]['correct_skips']} of {s[l]['unneeded']}" for l in LAYERS)
        positives = "/".join(str(s[l]["positives"]) for l in LAYERS)
        lines.append(f"| {b['batch']} | {b['date']} | {n} | {b['model']} | {' | '.join(cells)} | {cand} | {kw} | "
                     f"{groom} | {wrong} | {avoided} | {positives} | {b.get('facts', '—')} |")
        prev = b
    notes = []
    for b in history["batches"]:
        if b.get("note"):
            notes.append(f"- Batch {b['batch']}: {b['note']}")
        for origin, s in (b.get("by_origin") or {}).items():
            if len(b.get("by_origin") or {}) > 1:
                count = sum(1 for r in b.get("rows", []) if r["origin"] == origin)
                notes.append(f"  - {origin} subset (n={count}): pinned "
                             + "/".join(_pct(s[l]["jev_now_acc"]) for l in LAYERS)
                             + ", keyword " + "/".join(_pct(s[l]["keyword_acc"]) for l in LAYERS))
    last = history["batches"][-1]
    if last.get("ablation"):
        notes.append(f"- Fact ablation, batch {last['batch']} (accuracy points and extra wrong skips B/F/M without each fact):")
        for a in last["ablation"]:
            d, w = a["accuracy_delta_without"], a["extra_wrong_skips_without"]
            notes.append(f"  - {a['verdict']}: \"{a['fact']}…\" — "
                         f"{'/'.join(f'{d[l]:+d}' for l in LAYERS)} pts, {'/'.join(f'{w[l]:+d}' for l in LAYERS)} wrong skips")
    notes.append("- Batches take the oldest finished tickets first; quick-to-merge tickets finish first, so early "
                 "batches lean towards smaller work.")
    return "\n".join(lines + ["", *notes, ""])


OUTCOME_LABELS = (("Merged", "merged"), ("Not a Bug", "not a bug"), ("Needs Human", "needs human"))


def grooming_outcomes() -> list[dict]:
    """Per skill version: what Oneshot did with the AI tickets grooming produced (P11: does the skill help?)."""
    by_version: dict[str, dict] = {}
    for record in logged_decisions().values():
        if record.get("route") not in ("ai", "ai-tests"):
            continue
        try:
            issue = gl.call("GET", f"issues/{record['iid']}")
        except gl.GroomError:
            continue
        labels = set(issue.get("labels") or [])
        outcome = next((name for label, name in OUTCOME_LABELS if label in labels),
                       "closed other" if issue["state"] == "closed" else "in flight")
        v = by_version.setdefault(record.get("skill") or "unknown", {"n": 0, "unknowns": 0, "since": record["at"][:10]})
        v["n"] += 1
        v[outcome] = v.get(outcome, 0) + 1
        v["unknowns"] += record.get("unknown_lines", 0)
        v["since"] = min(v["since"], record["at"][:10])
    return [{"skill": k, **v} for k, v in sorted(by_version.items(), key=lambda kv: kv[1]["since"])]


def render_outcomes(rows: list[dict]) -> str:
    if not rows:
        return "## Grooming outcomes by skill version\n\n_No AI-routed tickets groomed with logging yet._\n"
    lines = ["## Grooming outcomes by skill version", "",
             "What Oneshot did with AI-routed tickets, per version of the grooming skill (hash of SKILL.md). "
             "Compare versions once each has ~20 finished tickets.", "",
             "| Skill | Since | n | Merged | Needs Human | Not a Bug | Closed other | In flight | Avg `unknown` lines |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        done = r["n"] - r.get("in flight", 0)
        pct = lambda k: f"{r.get(k, 0)} ({r.get(k, 0) / done:.0%})" if done else str(r.get(k, 0))  # noqa: E731
        lines.append(f"| {r['skill']} | {r['since']} | {r['n']} | {pct('merged')} | {pct('needs human')} | "
                     f"{pct('not a bug')} | {pct('closed other')} | {r.get('in flight', 0)} | {r['unknowns'] / r['n']:.1f} |")
    return "\n".join(lines) + "\n"


def post(text: str) -> None:
    subprocess.run([sys.executable, str(SLACK_POST), "--text", text], check=False, timeout=60)


# ── run ──────────────────────────────────────────────────────────

def run() -> str:
    history = load_history()
    done = {i for b in history["batches"] for i in b["iids"]} | set(history.get("excluded_iids", []))
    facts, skip = _facts()
    errors: list[str] = []
    pool = {**backlinked_tickets(errors), **logged_decisions()}
    pool = {iid: r for iid, r in pool.items() if str(iid) not in done}
    with ThreadPoolExecutor(6) as ex:
        truths = dict(zip(pool, ex.map(truth, pool)))
    newly_excluded = sorted(str(i) for i, t in truths.items() if t and "excluded" in t)
    history.setdefault("excluded_iids", []).extend(newly_excluded)
    finished = sorted((iid for iid, t in truths.items() if t and "layers" in t), key=int)

    made = []
    while len(finished) >= BATCH:
        chunk, finished = finished[:BATCH], finished[BATCH:]
        rows = [build_row(pool[i], truths[i], facts) for i in chunk]
        number = history["batches"][-1]["batch"] + 1
        history["batches"].append(batch_record(number, rows, facts, skip, None))
        made.append(number)
    HISTORY.write_text(json.dumps(history, indent=1))

    unfinished = sum(1 for t in truths.values() if t is None)
    status = (f"{len(finished)}/{BATCH} finished toward batch {history['batches'][-1]['batch'] + 1}; "
              f"{unfinished} groomed tickets not merged yet; {len(history['excluded_iids'])} excluded "
              f"(bundled MRs only); {len(errors)} Plane scan errors — checked {date.today().isoformat()}")
    table = render(history, status)
    TABLE.write_text(table + "\n" + render_outcomes(grooming_outcomes()))
    if made or errors:
        head = f"Jev heartbeat: batch {', '.join(map(str, made))} scored." if made else "Jev heartbeat:"
        post(head + "\n" + "\n".join(l for l in table.splitlines() if l.startswith("|"))
             + f"\n{status}" + (f"\nScan errors (first 3): {errors[:3]}" if errors else "") + f"\nFull table: {TABLE}")
    return status


if __name__ == "__main__":
    if sys.argv[1:] == ["--table"]:
        print(TABLE.read_text() if TABLE.exists() else render(load_history(), "not run yet"))
    elif sys.argv[1:] == ["--reseed"]:
        seeded, excluded = seed_history(*_facts())
        HISTORY.write_text(json.dumps(seeded, indent=1))
        print("reseeded batch 0:", seeded["batches"][0]["n"], "tickets; excluded:", excluded)
    else:
        print(run())
