"""One HTTP call for the PM loop scripts: a timeout on every request, a short retry on flaky hosts.

Plane drops roughly one request in four and GitLab vanishes with the VPN, so
transient failures (429, 5xx, connection errors) are retried here with a small
backoff. Anything still failing raises NetworkError — callers stop and report;
they never sleep-and-poll.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

RETRY_STATUS = {429, 500, 502, 503, 504}
BACKOFF_SECONDS = (1, 3, 6)
DEFAULT_TIMEOUT = 30


class NetworkError(RuntimeError):
    """A request that still failed after the retries."""


class HTTPStatusError(RuntimeError):
    """A non-retryable HTTP error, with the status and a short body."""

    def __init__(self, status: int, body: str, url: str):
        super().__init__(f"HTTP {status} on {url.split('?')[0]}: {body[:300]}")
        self.status = status


def request(method: str, url: str, *, headers: dict | None = None, data: bytes | None = None,
            timeout: int = DEFAULT_TIMEOUT, max_bytes: int | None = None) -> tuple[bytes, str]:
    """Return (body, content type), retrying transient failures."""
    last = None
    for attempt, pause in enumerate((0, *BACKOFF_SECONDS)):
        if pause:
            time.sleep(pause)
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"User-Agent": "pm-loop/1.0", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                body = response.read(max_bytes + 1) if max_bytes else response.read()
                if max_bytes and len(body) > max_bytes:
                    raise ValueError(f"larger than {max_bytes // 1024 // 1024} MB")
                return body, response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            if exc.code not in RETRY_STATUS:
                raise HTTPStatusError(exc.code, exc.read().decode(errors="replace"), url) from exc
            last = f"HTTP {exc.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last = str(getattr(exc, "reason", exc))
    raise NetworkError(f"{method} {url.split('?')[0]} failed after {len(BACKOFF_SECONDS) + 1} tries: {last}")


def json_request(method: str, url: str, *, headers: dict | None = None, payload=None,
                 timeout: int = DEFAULT_TIMEOUT):
    """JSON in, JSON out."""
    data = json.dumps(payload).encode() if payload is not None else None
    hdrs = {**(headers or {}), **({"Content-Type": "application/json"} if data is not None else {})}
    body, _ = request(method, url, headers=hdrs, data=data, timeout=timeout)
    return json.loads(body or b"null")
