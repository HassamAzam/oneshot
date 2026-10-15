"""Attach the ORIGINAL documents behind a ticket to arbisoft/erp, instead of links to them (library for groom.py).

Direct file links are downloaded only over https from FILE_HOSTS: ticket text is
client-written, and this runs on a VPN-connected machine that then publishes
what it fetched. Any other link stays a reference.

Oneshot and people should open the file itself, not traverse Plane or old
GitLab tickets to find it. Sources, followed one level deep: the Plane ticket's
attachments, links and description links; documents inside Plane tickets it
links to; documents inside past erp issues chosen for Previous Context; local
files (e.g. private Google files fetched through the Drive connector).

collect() returns: attached (markdown for ## Attachments), needs_connector
(private Google files), references (web pages — keep as links), failed.
"""

from __future__ import annotations

import hashlib
import html
import json
import mimetypes
import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pm_http
import pm_secrets

GITLAB_API = "https://gitlab.arbisoft.com/api/v4"
ERP_PROJECT = "arbisoft/erp"
PLANE_API = "https://projects.arbisoft.com/api/v1/workspaces/arbisoft"
PLANE_PROJECT = "6b2ba1a2-8234-498f-81f2-e4ab3b3cb923"
MAX_BYTES = 25 * 1024 * 1024
FETCH_ERRORS = (pm_http.NetworkError, pm_http.HTTPStatusError, ValueError, OSError, KeyError)

URL_RE = re.compile(r"""https?://[^\s"'<>)\]]+""")
HREF_RE = re.compile(r"""(?:href|src)=["']([^"']+)["']""")
UPLOAD_RE = re.compile(r"(?:https://gitlab\.arbisoft\.com/(?P<proj>[\w.-]+/[\w.-]+))?/uploads/"
                       r"(?P<secret>[0-9a-f]{32})/(?P<name>[^\s)\"'<>]+)")
GOOGLE_RE = re.compile(r"https://docs\.google\.com/(?P<kind>document|spreadsheets|presentation)/d/(?P<id>[\w-]+)")
DRIVE_RE = re.compile(r"https://drive\.google\.com/(?:file/d/(?P<a>[\w-]+)|open\?id=(?P<b>[\w-]+))")
GITLAB_ISSUE_RE = re.compile(r"https://gitlab\.arbisoft\.com/(?P<proj>[\w.-]+/[\w.-]+)/-/(?:issues|work_items)/(?P<iid>\d+)")
PLANE_ITEM_RE = re.compile(r"https://projects\.arbisoft\.com/\S*?(?P<key>WORKSTREAMRE-\d+)")
DOC_EXT = (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx", ".txt", ".md",
           ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".json", ".zip")
FILE_HOSTS = ("gitlab.arbisoft.com", "projects.arbisoft.com", "docs.google.com", "drive.google.com",
              "drive.usercontent.google.com")
GOOGLE_EXPORT = {"document": ("export?format=pdf", ".pdf"), "spreadsheets": ("export?format=xlsx", ".xlsx"),
                 "presentation": ("export/pdf", ".pdf")}


def _gitlab_headers() -> dict:
    return {"PRIVATE-TOKEN": pm_secrets.get("GITLAB_TOKEN")}


def _plane_headers() -> dict:
    return {"x-api-key": pm_secrets.get("PLANE_API_KEY")}


def _fetch(url: str, headers: dict | None = None) -> tuple[bytes, str]:
    return pm_http.request("GET", url, headers=headers, timeout=60, max_bytes=MAX_BYTES)


class Collector:
    """Gathers documents, de-duplicated by content, and uploads each once."""

    def __init__(self, dry_run: bool):
        self.dry_run = dry_run
        self.out = {"attached": [], "needs_connector": [], "references": [], "failed": []}
        self.seen_urls: set[str] = set()
        self.seen_hashes: set[str] = set()

    def attach(self, name: str, blob: bytes, source: str) -> None:
        digest = hashlib.sha256(blob).hexdigest()
        if digest in self.seen_hashes:
            return
        self.seen_hashes.add(digest)
        if self.dry_run:
            self.out["attached"].append({"name": name, "source": source, "bytes": len(blob), "markdown": "(dry-run)"})
            return
        boundary = "----pmloop" + digest[:16]
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
                f"Content-Type: {ctype}\r\n\r\n").encode() + blob + f"\r\n--{boundary}--\r\n".encode()
        raw, _ = pm_http.request("POST", f"{GITLAB_API}/projects/{urllib.parse.quote(ERP_PROJECT, safe='')}/uploads",
                                 data=body, timeout=120,
                                 headers={**_gitlab_headers(), "Content-Type": f"multipart/form-data; boundary={boundary}"})
        self.out["attached"].append({"name": name, "source": source, "markdown": json.loads(raw)["markdown"]})

    def fail(self, source: str, why: object) -> None:
        self.out["failed"].append({"source": source, "why": str(why)[:200]})

    def plane_ticket(self, uuid: str, depth: int = 0) -> None:
        """Attachments (downloaded in parallel), links and description links of one Plane item."""
        base = f"{PLANE_API}/projects/{PLANE_PROJECT}/issues/{uuid}"
        try:
            items = pm_http.json_request("GET", f"{base}/issue-attachments/", headers=_plane_headers())
            links = pm_http.json_request("GET", f"{base}/links/", headers=_plane_headers())
            issue = pm_http.json_request("GET", f"{base}/", headers=_plane_headers())
        except FETCH_ERRORS as exc:
            return self.fail(f"plane ticket {uuid}", exc)
        items = items if isinstance(items, list) else items.get("results", [])

        def download(item):
            name = item.get("attributes", {}).get("name") or "attachment"
            try:
                return name, _fetch(f"{base}/issue-attachments/{item['id']}/", _plane_headers())[0], None
            except FETCH_ERRORS as exc:
                return name, None, exc

        with ThreadPoolExecutor(max_workers=4) as pool:
            for name, blob, exc in pool.map(download, items):
                self.fail(f"plane attachment {name}", exc) if exc else self.attach(name, blob, f"plane {uuid}")
        for link in links if isinstance(links, list) else links.get("results", []):
            self.url(link.get("url", ""), link.get("title") or "", depth)
        for found in self._urls_in(issue.get("description_html") or ""):
            self.url(found, "", depth)

    def gitlab_issue(self, project: str, iid: int) -> None:
        """Documents inside one past GitLab issue's description (not the issue itself)."""
        try:
            issue = pm_http.json_request("GET", f"{GITLAB_API}/projects/{urllib.parse.quote(project, safe='')}"
                                         f"/issues/{iid}", headers=_gitlab_headers())
        except FETCH_ERRORS as exc:
            return self.fail(f"{project}#{iid}", exc)
        description = issue.get("description") or ""
        for match in UPLOAD_RE.finditer(description):
            self.gitlab_upload(match.group("proj") or project, match.group("secret"), match.group("name"),
                               f"{project}#{iid}")
        for found in self._urls_in(description):
            if not UPLOAD_RE.search(found) and not GITLAB_ISSUE_RE.match(found):
                self.url(found, "", depth=1)

    def gitlab_upload(self, project: str, secret: str, name: str, source: str) -> None:
        """Copy an existing GitLab upload by its secret."""
        if f"upload:{secret}" in self.seen_urls:
            return
        self.seen_urls.add(f"upload:{secret}")
        name = urllib.parse.unquote(name)
        try:
            blob, _ = _fetch(f"{GITLAB_API}/projects/{urllib.parse.quote(project, safe='')}/uploads/"
                             f"{secret}/{urllib.parse.quote(name)}", _gitlab_headers())
            self.attach(name, blob, source)
        except FETCH_ERRORS as exc:
            self.fail(f"{source} upload {name}", exc)

    def url(self, url: str, title: str, depth: int) -> None:
        """Classify one link and attach the document behind it when there is one."""
        url = html.unescape(url.strip()).rstrip(".,;")
        if not url.startswith("http") or url in self.seen_urls:
            return
        self.seen_urls.add(url)
        if (upload := UPLOAD_RE.search(url)) and upload.group("proj"):
            return self.gitlab_upload(upload.group("proj"), upload.group("secret"), upload.group("name"), url)
        if match := GOOGLE_RE.match(url):
            suffix, ext = GOOGLE_EXPORT[match.group("kind")]
            name = (title or f"google-{match.group('kind')}-{match.group('id')[:8]}") + ext
            return self._public_or_connector(f"https://docs.google.com/{match.group('kind')}/d/{match.group('id')}/"
                                             f"{suffix}", url, match.group("id"), name)
        if match := DRIVE_RE.match(url):
            file_id = match.group("a") or match.group("b")
            return self._public_or_connector(f"https://drive.google.com/uc?export=download&id={file_id}",
                                             url, file_id, title or f"google-drive-{file_id[:8]}")
        if (match := GITLAB_ISSUE_RE.match(url)) and depth == 0:
            return self.gitlab_issue(match.group("proj"), int(match.group("iid")))
        if (match := PLANE_ITEM_RE.search(url)) and depth == 0:
            try:
                item = pm_http.json_request("GET", f"{PLANE_API}/work-items/{match.group('key')}/",
                                            headers=_plane_headers())
                return self.plane_ticket(item["id"], depth=1)
            except FETCH_ERRORS as exc:
                return self.fail(url, exc)
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme == "https" and parsed.hostname in FILE_HOSTS and parsed.path.lower().endswith(DOC_EXT):
            try:
                blob, ctype = _fetch(url)
                if "text/html" in ctype:
                    raise ValueError("link returned a web page, not the file")
                return self.attach(Path(urllib.parse.urlparse(url).path).name, blob, url)
            except FETCH_ERRORS as exc:
                return self.fail(url, exc)
        self.out["references"].append({"title": title or url, "url": url})

    def _public_or_connector(self, export_url: str, url: str, file_id: str, name: str) -> None:
        """Download a Google file if it is public; otherwise hand it to the Drive connector."""
        try:
            blob, ctype = _fetch(export_url)
            if "text/html" not in ctype:
                return self.attach(name, blob, url)
        except FETCH_ERRORS:
            pass
        self.out["needs_connector"].append({"url": url, "file_id": file_id, "save_as": name})

    @staticmethod
    def _urls_in(text: str) -> list[str]:
        return list(dict.fromkeys(HREF_RE.findall(text) + URL_RE.findall(text)))


def collect(plane_uuid: str | None = None, from_issues: list[int] = (), files: list[str] = (),
            dry_run: bool = False) -> dict:
    """Gather, upload and classify every document behind a ticket."""
    collector = Collector(dry_run)
    if plane_uuid:
        collector.plane_ticket(plane_uuid)
    for iid in from_issues:
        collector.gitlab_issue(ERP_PROJECT, int(iid))
    for path in files:
        try:
            collector.attach(Path(path).name, Path(path).read_bytes(), f"local file {path}")
        except (OSError, *FETCH_ERRORS) as exc:
            collector.fail(path, exc)
    return collector.out
