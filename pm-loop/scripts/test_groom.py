"""Tests for the grooming rules that live in code (run: python3 -m pytest ~/.claude/scripts -q)."""
import argparse
import io
import json
from pathlib import Path

import pytest

import collect_documents
import groom
import groom_gitlab as gl
import jev_layers
import resolve_plane_ticket as plane

LABELS = {
    "size": {"XS": "XS (0-4 hrs)", "S": "Small (0-8 hrs)", "M": "Medium ( 0 - 21 hrs)",
             "L": "Large ( 0 - 40 hrs)", "XL": "XLarge (40+ hrs)"},
    "kind": {"bug": "Bug", "feature": "Feature Request", "change": "Change Request", "chore": "Chore",
             "tech_debt": "Tech Debt"},
    "priority": {"urgent": "Urgent Requirement"},
    "zone": {"green": "Zone: Green", "yellow": "Zone: Yellow", "red": "Zone: Red"},
    "layer": {"backend": "Backend", "frontend": "Frontend"},
    "flow": {"ai": "AI", "loop": "Loop", "review": "Review", "design": "Design", "accessibility": "Accessibility",
             "characterization_tests": "Characterization Tests", "needs_human": "Needs Human"},
    "area": {"training": "Training", "teams": "Team Management", "payroll": "Payroll"},
    "swimlane": {"Finance": "Finance", "Pod": "POD"},
    "retired": {"names": ["Minor"]},
    "creatable": {"Zone: Green": {}, "Zone: Yellow": {}, "Zone: Red": {}, "Characterization Tests": {},
                  "XLarge (40+ hrs)": {}},
}


@pytest.fixture(autouse=True)
def _labels(monkeypatch, tmp_path):
    Path(tmp_path, "labels.json").write_text(json.dumps(LABELS))
    monkeypatch.setenv("PM_LOOP_MAP_DIR", str(tmp_path))
    gl.map_file.cache_clear()
    yield
    gl.map_file.cache_clear()


def _ticket(route="ai", zone="green", areas=("training",), kind="bug", size="S", swimlanes=(), priority="medium"):
    return {"id": "WORKSTREAMRE-9", "name": "T", "description": "d", "uuid": "u", "eligible": True, "skip_reason": None, "route": route,
            "route_note": None, "priority": priority, "swimlanes": list(swimlanes), "requested_by": "A Person",
            "triage": {"route": route, "zone": zone, "areas": list(areas), "kind": kind, "size": size,
                       "design": False, "reasons": ["why"]}}


def _args(**kw):
    base = dict(id="9", mr=None, title="T", from_issues=[], kind=None, size=None, assignee=None, dry_run=True)
    return argparse.Namespace(**{**base, **kw})


def _dry_create(monkeypatch, ticket, body, layers=(), **kw):
    monkeypatch.setattr(jev_layers, "decide", lambda title, text: {
        "layers": list(layers), "probabilities": {}, "source": "jev", "note": None})
    monkeypatch.setattr(plane, "resolve", lambda _id: ticket)
    monkeypatch.setattr(gl, "existing_issue", lambda _id: None)
    monkeypatch.setattr(collect_documents, "collect", lambda *a, **k: {
        "attached": [], "needs_connector": [], "references": [], "failed": []})
    monkeypatch.setattr("sys.stdin", io.StringIO(body))
    return groom.create(_args(**kw))


GOOD = "## Current State\nx\n\n## Acceptance Criteria\n- [ ] Team page lists 5 rows\n"


# ── labels ──

def test_green_route_gets_ai_and_loop(monkeypatch):
    out = _dry_create(monkeypatch, _ticket(), GOOD)
    assert out["labels"] == ["Bug", "Small (0-8 hrs)", "Zone: Green", "Training", "AI", "Loop"]


def test_yellow_route_gets_review_not_loop_and_a_tests_issue(monkeypatch):
    out = _dry_create(monkeypatch, _ticket(route="ai-tests", zone="yellow", areas=("teams",)), GOOD)
    assert "Review" in out["labels"] and "Loop" not in out["labels"]
    assert out["tests_labels"] == ["Zone: Yellow", "Team Management", "Characterization Tests"]


def test_human_route_never_gets_ai(monkeypatch):
    out = _dry_create(monkeypatch, _ticket(route="human", zone="red", areas=("payroll",)), GOOD)
    assert not {"AI", "Loop", "Review"} & set(out["labels"])


def test_ai_route_keeps_triage_size_over_a_flag(monkeypatch):
    out = _dry_create(monkeypatch, _ticket(size="S"), GOOD, size="XL", kind="feature")
    assert "Small (0-8 hrs)" in out["labels"] and "Bug" in out["labels"]


def test_human_route_accepts_a_corrected_size(monkeypatch):
    out = _dry_create(monkeypatch, _ticket(route="human", zone="red", size="S"), GOOD, size="L")
    assert "Large ( 0 - 40 hrs)" in out["labels"]


def test_missing_kind_or_size_is_refused(monkeypatch):
    with pytest.raises(gl.GroomError, match="pass --kind and --size"):
        _dry_create(monkeypatch, _ticket(route="human", zone=None, kind=None, size=None), GOOD)


def test_swimlane_and_urgent_labels(monkeypatch):
    out = _dry_create(monkeypatch, _ticket(route="human", zone="red", swimlanes=("Finance",), priority="urgent"), GOOD)
    assert {"Finance", "Urgent Requirement"} <= set(out["labels"])


def test_labels_outside_the_allow_list_are_refused(monkeypatch):
    monkeypatch.setattr(gl, "_live_labels", lambda: set())
    with pytest.raises(gl.GroomError, match="not in .claude/labels.json"):
        gl.check_labels(["Bug", "Typo Label"])


def test_retired_labels_are_refused(monkeypatch):
    monkeypatch.setattr(gl, "_live_labels", lambda: {"Minor"})
    with pytest.raises(gl.GroomError, match="not in .claude/labels.json"):
        gl.check_labels(["Minor"])


# ── body ──

def test_filler_acceptance_criteria_are_refused_on_ai_routes(monkeypatch):
    with pytest.raises(gl.GroomError, match="cannot pass or fail"):
        _dry_create(monkeypatch, _ticket(), "## Acceptance Criteria\n- [ ] No regressions introduced\n")


def test_filler_is_allowed_on_the_human_route(monkeypatch):
    out = _dry_create(monkeypatch, _ticket(route="human", zone="red"), "## Acceptance Criteria\n- [ ] Works as expected\n")
    assert out["dry_run"]


DARK = "- [ ] On the Team page with dark theme on, all text and controls are readable and nothing overlaps\n"


def test_backend_criterion_only_on_the_human_route(monkeypatch):
    ai = _dry_create(monkeypatch, _ticket(), GOOD, layers=["backend"])["body"]
    human = _dry_create(monkeypatch, _ticket(route="human", zone="red"), GOOD, layers=["backend"])["body"]
    assert groom.AC_BACKEND not in ai and groom.AC_BACKEND in human


def test_frontend_work_must_name_a_dark_theme_screen(monkeypatch):
    with pytest.raises(gl.GroomError, match="dark-theme criterion"):
        _dry_create(monkeypatch, _ticket(), GOOD, layers=["frontend"])
    assert _dry_create(monkeypatch, _ticket(), GOOD + DARK, layers=["frontend"])["dry_run"]


def test_unlabelled_areas_and_swimlanes_are_reported(monkeypatch):
    out = _dry_create(monkeypatch, _ticket(route="human", zone="red", areas=("payroll", "core"),
                                           swimlanes=("Opensource", "Accessibility")), GOOD)
    assert out["unlabelled"] == ["area core", "swimlane Opensource"]


def test_code_adds_plane_ticket_requested_by_and_routing(monkeypatch):
    body = _dry_create(monkeypatch, _ticket(), GOOD)["body"]
    assert "## Plane Ticket\nWORKSTREAMRE-9" in body and "## Requested By\nA Person" in body
    assert "## Routing\nai · zone green (training) — why (size S, bug)" in body


def test_tests_scope_is_cut_out_of_the_change_body(monkeypatch):
    out = _dry_create(monkeypatch, _ticket(route="ai-tests", zone="yellow"), GOOD + "<!-- tests-scope -->\n- pin X\n")
    assert "pin X" not in out["body"]


def test_add_section_appends_into_an_existing_section():
    body = "## A\n- one\n\n## B\nx\n"
    assert gl.add_section(body, "A", ["- two"]) == "## A\n- one\n- two\n\n## B\nx\n"
    assert gl.add_section(body, "C", ["y"]).endswith("## C\ny\n")
    assert gl.add_section(body, "A", []) == body


# ── Plane ──

@pytest.mark.parametrize("raw, expected", [("230", "WORKSTREAMRE-230"), ("ws-230", "WORKSTREAMRE-230"),
                                           ("WORKSTREAMRE-230", "WORKSTREAMRE-230")])
def test_ids_normalise(raw, expected):
    assert plane.normalise_id(raw) == expected


def test_other_projects_are_refused():
    with pytest.raises(ValueError, match="only WORKSTREAMRE"):
        plane.normalise_id("WORKSTREAMFE-4")


@pytest.mark.parametrize("routing, expected", [
    (None, "human"),
    ({"route": "ai", "zone": None}, "human"),
    ({"route": "ai", "zone": "green"}, "ai"),
    ({"route": "ai-tests", "zone": "yellow"}, "ai-tests"),
    ({"route": "pm", "zone": None}, "human"),
])
def test_effective_route(routing, expected):
    assert plane.effective_route(routing)[0] == expected


def test_marker_round_trip():
    attrs = ' route=ai-tests size=M kind=tech_debt design=0 zone=yellow areas=teams,forms why="a; b"'
    parsed = plane.parse_routing(attrs)
    assert parsed["zone"] == "yellow" and parsed["areas"] == ["teams", "forms"] and parsed["reasons"] == ["a", "b"]


def test_plain_text_keeps_links_and_drops_tags():
    text = plane.plain_text('<p>See <a href="https://x.test/doc">the spec</a></p><ul><li>one</li></ul>')
    assert "the spec (https://x.test/doc)" in text and "- one" in text and "<" not in text


def test_backlink_regex_matches_only_the_backlink():
    assert plane.BACKLINK_RE.search('<p>GitLab issue created: <a href="https://g/x">#12</a></p>')
    assert not plane.BACKLINK_RE.search('<p>see https://gitlab.arbisoft.com/arbisoft/erp/-/issues/12</p>')


# ── documents ──

@pytest.mark.parametrize("url", ["http://10.0.0.5/secret.pdf", "https://intranet.local/x.pdf",
                                 "https://example.com/spec.pdf"])
def test_direct_files_are_fetched_only_from_known_hosts(url):
    col = collect_documents.Collector(dry_run=True)
    col.url(url, "", 0)
    assert col.out["references"] == [{"title": url, "url": url}] and not col.out["attached"]


def test_accessibility_on_the_human_route_is_no_longer_skipped():
    assert "Accessibility" not in open(plane.__file__).read().split("def resolve(")[1].split("def post_groom")[0]


# ── sweep ──

@pytest.mark.parametrize("path, is_test", [
    ("apps/teams/tests/test_views.py", True), ("apps/teams/tests.py", True), ("apps/teams/conftest.py", True),
    ("frontend/src/components/organogram/__tests__/Tree.test.js", True), ("apps/teams/factories.py", True),
    ("apps/teams/views.py", False), ("frontend/src/components/organogram/Tree.js", False),
])
def test_test_paths(path, is_test):
    assert bool(gl.TEST_PATH_RE.search(path)) is is_test


def _fake_gitlab(monkeypatch, *, tests_state="closed", mr_branch="nouman/pin-org", mr_files=("apps/teams/tests/test_a.py",),
                 marker=True):
    writes = []
    change = {"iid": 20, "description": "<!-- tests-first: #19 -->\nbody" if marker else "body"}

    def call(method, path, payload=None):
        if method == "PUT":
            writes.append((path, payload))
            return {}
        if path.startswith("issues?"):
            return [change]
        if path == "issues/19":
            return {"state": tests_state}
        if path == "issues/19/closed_by":
            return [{"iid": 77, "state": "merged", "source_branch": mr_branch}]
        if path.startswith("merge_requests/77/diffs"):
            return [{"new_path": f} for f in mr_files]
        raise AssertionError(path)

    monkeypatch.setattr(gl, "call", call)
    return writes


def test_sweep_releases_a_person_written_tests_only_mr(monkeypatch):
    writes = _fake_gitlab(monkeypatch)
    assert gl.sweep(dry_run=False)[0]["action"] == "added Loop"
    assert writes == [("issues/20", {"add_labels": "Loop"})]


@pytest.mark.parametrize("kw, why", [
    ({"mr_branch": "oneshot/ticket-19-pin"}, "agent branch"),
    ({"mr_files": ("apps/teams/tests/test_a.py", "apps/teams/views.py")}, "non-test files: apps/teams/views.py"),
    ({"tests_state": "opened"}, "still open"),
    ({"marker": False}, "no tests-first marker"),
])
def test_sweep_holds_and_reports(monkeypatch, kw, why):
    writes = _fake_gitlab(monkeypatch, **kw)
    result = gl.sweep(dry_run=False)[0]
    assert why in result["why"] and not writes


def test_sweep_notifications_post_only_what_changed(monkeypatch, tmp_path):
    posted = []
    monkeypatch.setattr(groom, "SWEEP_SEEN", tmp_path / "seen.json")
    monkeypatch.setattr(groom.subprocess, "run", lambda cmd, **kw: posted.append(cmd[-1]))
    held = [{"issue": 20, "tests_issue": 19, "action": "none", "why": "!77 came from an agent branch"},
            {"issue": 21, "tests_issue": 18, "action": "waiting", "why": "tests issue still open"}]
    assert groom.notify_sweep(held, dry_run=False) == ["#20: held — !77 came from an agent branch"]
    assert groom.notify_sweep(held, dry_run=False) == []
    released = [{"issue": 20, "tests_issue": 19, "action": "added Loop", "tests_mr": 80}]
    assert groom.notify_sweep(released, dry_run=False)[0].startswith("#20: tests !80 merged")
    assert len(posted) == 2


def test_a_sweep_failure_is_posted_once(monkeypatch, tmp_path):
    posted = []
    monkeypatch.setattr(groom, "SWEEP_SEEN", tmp_path / "seen.json")
    monkeypatch.setattr(groom.subprocess, "run", lambda cmd, **kw: posted.append(cmd[-1]))
    failure = [{"issue": "sweep", "action": "failed", "why": "label allow-list not readable"}]
    groom.notify_sweep(failure, dry_run=False)
    groom.notify_sweep(failure, dry_run=False)
    assert len(posted) == 1 and "FAILED" in posted[0]


# ── Jev layers ──

FACTS = {"facts": ["f"], "layer_skip_below": {"backend": 0.2, "frontend": 0.1, "migration": 0.1}}


@pytest.fixture
def _facts(tmp_path, monkeypatch):
    Path(tmp_path, "erp-facts.json").write_text(json.dumps(FACTS))
    monkeypatch.setattr(jev_layers, "CACHE", tmp_path / "cache")


def test_layers_below_threshold_are_dropped(_facts, monkeypatch):
    monkeypatch.setattr(jev_layers, "_ask", lambda *a: {"backend": 0.95, "frontend": 0.09, "migration": 0.4})
    assert jev_layers.decide("t", "d")["layers"] == ["backend", "migration"]


def test_uncertain_layers_are_kept(_facts, monkeypatch):
    monkeypatch.setattr(jev_layers, "_ask", lambda *a: {"backend": 0.19, "frontend": 0.15, "migration": 0.05})
    assert jev_layers.decide("t", "d")["layers"] == ["frontend"]


def test_jev_unreachable_keeps_every_layer_and_says_so(_facts, monkeypatch):
    def down(*a):
        raise jev_layers.pm_http.NetworkError("offline")
    monkeypatch.setattr(jev_layers, "_ask", down)
    out = jev_layers.decide("t", "d")
    assert out["layers"] == list(jev_layers.LAYERS) and out["source"] == "fallback" and "offline" in out["note"]


def test_ruling_out_both_ui_and_server_keeps_everything(_facts, monkeypatch):
    monkeypatch.setattr(jev_layers, "_ask", lambda *a: {"backend": 0.01, "frontend": 0.01, "migration": 0.01})
    out = jev_layers.decide("t", "d")
    assert out["layers"] == list(jev_layers.LAYERS) and "cannot be right" in out["note"]


def test_answers_are_cached_by_content(_facts, monkeypatch):
    calls = []
    monkeypatch.setattr(jev_layers.pm_http, "json_request", lambda *a, **k: calls.append(1) or {
        "answers": {k2: {"noul": 0.9} for k2 in jev_layers.LAYERS}})
    monkeypatch.setattr(jev_layers.pm_secrets, "get", lambda name: "key")
    jev_layers.decide("t", "same")
    jev_layers.decide("t", "same")
    assert len(calls) == 1


def test_frontend_layer_from_jev_drives_label_and_dark_theme_rule(monkeypatch):
    with pytest.raises(gl.GroomError, match="dark-theme criterion"):
        _dry_create(monkeypatch, _ticket(), GOOD, layers=("frontend",))
    out = _dry_create(monkeypatch, _ticket(), GOOD + DARK, layers=("frontend",))
    assert "Frontend" in out["labels"] and "Backend" not in out["labels"]
    assert "Layers: frontend — jev" in out["body"]


# ── Jev heartbeat ──

import jev_heartbeat as hb


def _row(iid, truth, now, groom=None, title="t", desc="d"):
    return {"iid": iid, "title": title, "description": desc, "truth": truth, "jev_now": now, "jev_groom": groom}


def test_heartbeat_scores_accuracy_skips_and_deltas():
    t = {"backend": True, "frontend": False, "migration": False}
    rows = [_row(1, t, {"backend": 0.9, "frontend": 0.05, "migration": 0.05}, groom={"backend": 0.8, "frontend": 0.6, "migration": 0.1}),
            _row(2, t, {"backend": 0.1, "frontend": 0.05, "migration": 0.05})]
    s = hb.score(rows, {"backend": 0.2, "frontend": 0.1, "migration": 0.1})
    assert s["backend"]["jev_now_acc"] == 0.5 and s["backend"]["wrong_skips"] == [2]
    assert s["frontend"]["correct_skips"] == 2 and s["frontend"]["jev_groom_acc"] == 0.0 and s["frontend"]["jev_groom_n"] == 1
    history = {"batches": [{"batch": 0, "date": "d0", "n": 2, "model": "m", "iids": [], "scores": s},
                           {"batch": 1, "date": "d1", "n": 2, "model": "m", "iids": [], "scores": {
                               **s, "backend": {**s["backend"], "jev_now_acc": 1.0, "wrong_skips": []}}}]}
    table = hb.render(history, "ok")
    assert "| 1 | d1 | 2 | m | 100% (+50) |" in table and "| 0 | d0 | 2 | m | 50% |" in table


@pytest.mark.parametrize("source, bundle", [("Adhoc-2026-09-07", True), ("stage", True), ("dev", True),
                                            ("release/2.71", True), ("haider/8575", False),
                                            ("ibrahim/cherry-pick-8219", False), ("oneshot/ticket-9-x", False)])
def test_bundled_mrs_are_recognised(source, bundle):
    assert hb.is_bundle({"source_branch": source}) is bundle


def test_templates_count_as_backend_and_tests_alone_do_not_hide_it():
    assert hb.layers_of(["templates/registration/base.html"]) == {"backend": True, "frontend": False, "migration": False}
    assert hb.layers_of(["frontend/src/a.js", "apps/x/migrations/0002.py"])["migration"] is True


def test_only_bundles_means_excluded_not_scored(monkeypatch):
    out = hb.truth(1, mrs=[{"iid": 5, "source_branch": "Adhoc-2026-09-07"}])
    assert "excluded" in out and "Adhoc-2026-09-07" in out["excluded"]


def test_noise_band():
    assert not hb.significant(0.92, 50, 0.90, 50)
    assert hb.significant(0.95, 50, 0.70, 50)


def test_fallback_at_grooming_scores_as_load_everything(monkeypatch):
    monkeypatch.setattr(hb.jev_layers, "ask", lambda *a, **k: ({"backend": 0.9, "frontend": 0.1, "migration": 0.1}, "m"))
    row = hb.build_row({"iid": 1, "title": "t", "description": "d", "source": "fallback"},
                       {"layers": {"backend": True, "frontend": False, "migration": False}, "mrs": [2], "files": []}, [])
    assert row["jev_groom"] == {"backend": 1.0, "frontend": 1.0, "migration": 1.0} and row["groom_fallback"]
