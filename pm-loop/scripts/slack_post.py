#!/usr/bin/env python3
"""Post a message to Slack using locally-stored credentials.

Reads a webhook URL or bot token from ~/.claude/.secrets.env (never committed,
owner-only perms) and posts to the configured channel. Prefers an incoming
webhook if present, else falls back to a bot token via chat.postMessage.

The secret is never printed. Only a status line is emitted.

Usage:
    python3 slack_post.py --text 'hello'
    python3 slack_post.py --text-file /tmp/msg.txt
    python3 slack_post.py --channel C0123 --text 'hi'
"""

import argparse
import json
import os
import sys
import urllib.request

SECRETS_PATH = os.path.expanduser("~/.claude/.secrets.env")
DEFAULT_CHANNEL_KEY = "SLACK_CHANNEL_WORKSTREAM_MGMT"
WEBHOOK_KEY = "SLACK_WEBHOOK_WORKSTREAM_MGMT"
BOT_TOKEN_KEY = "SLACK_BOT_TOKEN"


def load_secrets(path: str) -> dict:
    """Parse KEY=VALUE lines from the secrets file, ignoring comments/blanks."""
    values: dict = {}
    if not os.path.exists(path):
        return values
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            values[key.strip()] = val.strip()
    return values


def post_via_webhook(url: str, text: str) -> None:
    """POST a message payload to a Slack incoming webhook."""
    req = urllib.request.Request(
        url, data=json.dumps({"text": text}).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def post_via_bot(token: str, channel: str, text: str) -> None:
    """POST a message via chat.postMessage using a bot token."""
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=json.dumps({"channel": channel, "text": text}).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }, method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = json.loads(resp.read())
    if not body.get("ok"):
        raise RuntimeError(f"slack error: {body.get('error', 'unknown')}")


def main(argv=None) -> int:
    """Resolve credentials and send the message."""
    parser = argparse.ArgumentParser(prog="slack_post")
    parser.add_argument("--channel", default=None)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--text", default=None)
    group.add_argument("--text-file", default=None)
    args = parser.parse_args(argv)

    text = args.text
    if args.text_file:
        with open(args.text_file, encoding="utf-8") as handle:
            text = handle.read()

    secrets = load_secrets(SECRETS_PATH)
    channel = args.channel or secrets.get(DEFAULT_CHANNEL_KEY, "")
    webhook = secrets.get(WEBHOOK_KEY, "")
    token = secrets.get(BOT_TOKEN_KEY, "")

    try:
        if webhook:
            post_via_webhook(webhook, text)
            print("posted via webhook")
        elif token:
            if not channel:
                print("no channel configured for bot-token post", file=sys.stderr)
                return 2
            post_via_bot(token, channel, text)
            print(f"posted via bot token to {channel}")
        else:
            print(
                f"no credential set in {SECRETS_PATH} "
                f"(fill {WEBHOOK_KEY} or {BOT_TOKEN_KEY})", file=sys.stderr,
            )
            return 3
    except (urllib.error.URLError, RuntimeError) as exc:
        print(f"post failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
