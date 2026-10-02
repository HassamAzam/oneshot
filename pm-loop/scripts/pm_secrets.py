#!/usr/bin/env python3
"""Credentials for the PM loop scripts, kept out of scripts and skills.

Lookup order: the environment, then ~/.config/pm-loop/secrets.env (KEY=value
lines, chmod 600). `python3 pm_secrets.py --check` reports which are set
without printing any value; `pm_secrets.py get NAME` prints one for shell scripts.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

SECRETS_FILE = Path.home() / ".config" / "pm-loop" / "secrets.env"
KNOWN = ("GITLAB_TOKEN", "PLANE_API_KEY", "TYPESAFE_API_KEY")


def _file_values() -> dict:
    """Parse the secrets file; refuse one other users can read."""
    if not SECRETS_FILE.exists():
        return {}
    if SECRETS_FILE.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SystemExit(f"{SECRETS_FILE} is readable by others; run: chmod 600 {SECRETS_FILE}")
    values = {}
    for line in SECRETS_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def get(name: str) -> str:
    """Return a credential, or exit naming where to put it."""
    value = os.environ.get(name) or _file_values().get(name)
    if not value:
        raise SystemExit(f"missing {name}: export it or add {name}=... to {SECRETS_FILE}")
    return value


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "get":
        print(get(sys.argv[2]))
    elif sys.argv[1:] == ["--check"]:
        file_values = _file_values()
        for key in KNOWN:
            source = "env" if os.environ.get(key) else "file" if file_values.get(key) else "MISSING"
            print(f"{key}: {source}")
    else:
        print(__doc__)
