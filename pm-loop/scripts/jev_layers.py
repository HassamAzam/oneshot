"""Which layers a ticket needs (backend / frontend / migration), decided by Jev (TypeSafe System One).

Only the ticket's title and plain-text description are sent, with the reviewed
facts in the erp repo's .claude/erp-facts.json. A layer is dropped only when
Jev is confident it is not needed (probability below `layer_skip_below`);
anything less certain keeps it. If Jev cannot be reached, every layer is kept
and the result says so — never a silent guess.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import groom_gitlab as gl
import pm_http
import pm_secrets

API = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-1.13.0"
LAYERS = ("backend", "frontend", "migration")
CACHE = Path.home() / ".cache" / "pm-loop" / "jev"
DESCRIPTION_CHARS = 3500

QUESTIONS = {
    "backend": {"type": "noul", "instructions":
        "Will implementing `ticket` in this Django + React ERP require changing server-side Python code: "
        "models, API views, serializers, business calculations, server-generated reports or exports, emails, "
        "signals, permissions, background tasks or the Django admin? Use `system_facts` for how this ERP is built.",
        "criteria": {"true": "Some server-side Python must change",
                     "false": "Only the web UI changes (layout, styling, text, accessibility attributes, "
                              "client-side behaviour), or nothing in this web app"}},
    "frontend": {"type": "noul", "instructions":
        "Will implementing `ticket` require changing the React web frontend: pages, components, forms, tables, "
        "filters, modals, styles, visible text or accessibility attributes in the browser? "
        "Use `system_facts` for how this ERP is built.",
        "criteria": {"true": "Some React web code must change",
                     "false": "Only server-side logic, data, emails, reports or admin change, or the ticket is about "
                              "a mobile app"}},
    "migration": {"type": "noul", "instructions":
        "Will implementing `ticket` require a Django database migration: a new or changed model field, table, "
        "stored choice or relation, or a backfill that rewrites existing records? "
        "Use `system_facts` for how this ERP is built.",
        "criteria": {"true": "The database schema or stored data must change",
                     "false": "Existing data and schema are enough; only logic, display or configuration change"}},
}


def facts_hash(facts: list[str]) -> str:
    """Short, stable id of the facts Jev was given — so a change in scores can be traced to a facts change."""
    return hashlib.sha256(json.dumps(facts).encode()).hexdigest()[:10]


def ask(title: str, description: str, facts: list[str], model: str = MODEL) -> tuple[dict, str]:
    """(probabilities, model that answered). Cached by content and model; an alias is never cached."""
    state = {"system_facts": facts, "ticket": {"title": title, "description": description[:DESCRIPTION_CHARS]}}
    key = hashlib.sha256(json.dumps([model, QUESTIONS, state], sort_keys=True).encode()).hexdigest()
    cached = CACHE / f"{key}.json"
    if model == MODEL and cached.exists():
        return json.loads(cached.read_text()), MODEL
    reply = pm_http.json_request("POST", API, timeout=60, payload={"model": model, "state": state, "questions": QUESTIONS},
                                 headers={"Authorization": f"Bearer {pm_secrets.get('TYPESAFE_API_KEY')}"})
    probs = {k: round(reply["answers"][k]["noul"], 3) for k in LAYERS}
    if model == MODEL:
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(probs))
    return probs, reply.get("model", model)


def _ask(title: str, description: str, facts: list[str]) -> dict:
    """Pinned-model probabilities (grooming's path)."""
    return ask(title, description, facts)[0]


def decide(title: str, description: str) -> dict:
    """{layers: [...], probabilities: {...}, source: 'jev'|'fallback', note: str|None}."""
    facts_file = gl.map_file("erp-facts.json")
    skip_below = facts_file.get("layer_skip_below", {})
    try:
        probs = _ask(title, description, facts_file.get("facts", []))
    except (pm_http.NetworkError, pm_http.HTTPStatusError, KeyError, SystemExit) as exc:
        return {"layers": list(LAYERS), "probabilities": {}, "source": "fallback",
                "note": f"Jev unavailable, every layer kept: {str(exc)[:200]}",
                "facts": facts_hash(facts_file.get("facts", []))}
    layers = [k for k in LAYERS if probs[k] >= skip_below.get(k, 0.5)]
    if "backend" not in layers and "frontend" not in layers:
        return {"layers": list(LAYERS), "probabilities": probs, "source": "jev",
                "note": "Jev ruled out both backend and frontend, which cannot be right — every layer kept",
                "facts": facts_hash(facts_file.get("facts", []))}
    return {"layers": layers, "probabilities": probs, "source": "jev", "note": None,
            "facts": facts_hash(facts_file.get("facts", []))}
