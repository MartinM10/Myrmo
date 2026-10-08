"""HTTP client for a Myrmo colony.

Lookup order, cheapest first:
  1. in-process cache (an agent stuck in a loop asks the same thing many times)
  2. GET /v1/trails/by-fingerprint/{fp} (cacheable by any CDN; most traffic ends here)
  3. POST /v1/search (embedding + vector search; only for errors without a fingerprint match)
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Union

import httpx

from .config import agent_identity, publish_choice
from .environment import detect_environment, parse_package
from .fingerprint import fingerprint2, guess_error_type
from .redact import Report, possible_names, redact_text, redact_value

#: The public colony. Override with MYRMO_URL or the `url` argument.
DEFAULT_URL = "https://myrmo.dev"
SDK_VERSION = "0.9.0"  # x-release-please-version
#: What a colony that is restarting or overloaded answers with.
UNAVAILABLE = (502, 503, 504)
DEFAULT_RETRY_DELAYS = (0.5, 1.5, 3.0)
OUTCOMES = ("worked", "partially_worked", "failed", "not_applicable")


class MyrmoError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message, self.details = status, code, message, details


@dataclass
class Hit:
    trail_id: str
    match: Dict[str, Any]
    strength: float
    outcomes: Dict[str, int]
    risk: Dict[str, Any]
    trail: Dict[str, Any]

    def safe_commands(self) -> List[Dict[str, Any]]:
        """Commands without a high-risk flag."""
        high = {f["command_index"] for f in self.risk.get("flags", []) if f.get("level") == "high"}
        commands = self.trail.get("solution", {}).get("shell_commands_executed", [])
        return [c for i, c in enumerate(commands) if i not in high]


@dataclass
class SearchResult:
    fingerprint: str
    hits: List[Hit]
    notice: str
    #: "cache", "fingerprint" or "search"
    source: str
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    def __iter__(self):
        return iter(self.hits)

    def __len__(self) -> int:
        return len(self.hits)

    def __getitem__(self, i: int) -> Hit:
        return self.hits[i]


def _hits(results: Sequence[Dict[str, Any]]) -> List[Hit]:
    return [Hit(r["trail_id"], r["match"], r["strength"], r["outcomes"], r["risk"], r["trail"]) for r in results]


def _env(key: str) -> Optional[str]:
    value = os.environ.get(key, "").strip()
    return value or None


def _draft_result(data: Dict[str, Any], redactions: Dict[str, int]) -> Dict[str, Any]:
    """`draft_id`, `approve_url` (give it to the user), `expires_in`, `fingerprint`, `redactions`, `risk`."""
    merged = dict(redactions)
    for kind, n in (data.get("redactions") or {}).items():
        merged[kind] = merged.get(kind, 0) + n
    return {**data, "redactions": merged}


def _model_header(model: Optional[str]) -> Optional[Dict[str, str]]:
    return {"x-myrmo-model": model} if model else None


class _Base:
    def __init__(
        self,
        url: Optional[str] = None,
        api_key: Optional[str] = None,
        agent_id: Union[str, bool, None] = None,
        publish: Optional[str] = None,
        timeout: float = 10.0,
        headers: Optional[Dict[str, str]] = None,
        cache_ttl: float = 60.0,
        model: Optional[str] = None,
        retries: int = 3,
        retry_delays: Sequence[float] = DEFAULT_RETRY_DELAYS,
    ):
        """`agent_id` is created by itself on first use and kept in ~/.myrmo/config.json; pass False to send
        none (a server forwarding its callers' own header). `model` (default MYRMO_AGENT_MODEL) is the model
        this client runs for, sent as X-Myrmo-Model for aggregate counters. `retries` is how many times a read (a
        lookup or a search) is tried again when the colony answers 502, 503 or 504 or refuses the connection, which
        is what a restart looks like from outside (default 3, 0 disables); publishing and reporting are never
        repeated. `retry_delays` are the pauses in seconds, with a little jitter."""
        self.retries = max(0, retries)
        self.retry_delays = tuple(retry_delays) or DEFAULT_RETRY_DELAYS
        self.url = (url or _env("MYRMO_URL") or DEFAULT_URL).rstrip("/")
        #: "off", "ask" or "auto"; `publish_source` says where it came from. "default" means nobody
        #: has chosen yet, so nothing is published (see `python -m myrmo config`).
        self.publish_mode, self.publish_source = publish_choice(publish)
        self.timeout = timeout
        self.cache_ttl = cache_ttl
        self._cache: Dict[str, tuple] = {}
        self.headers = {"accept": "application/json", "user-agent": f"myrmo-python/{SDK_VERSION}", **(headers or {})}
        key = api_key or _env("MYRMO_API_KEY")
        agent, _ = agent_identity(agent_id)
        model = (model or _env("MYRMO_AGENT_MODEL") or "").strip()
        if key:
            self.headers["authorization"] = f"Bearer {key}"
        # A header the caller passed (a hosted server forwarding its users' ids) wins over this client's own.
        names = {k.lower() for k in self.headers}
        if agent and "x-myrmo-agent" not in names:
            self.headers["x-myrmo-agent"] = agent
        if model and model.lower() != "unknown" and "x-myrmo-model" not in names:
            self.headers["x-myrmo-model"] = model

    # -- cache -------------------------------------------------------------------------
    def _cached(self, key: str):
        entry = self._cache.get(key)
        if not entry:
            return ...
        at, value = entry
        if time.monotonic() - at > self.cache_ttl:
            self._cache.pop(key, None)
            return ...
        if value is None:
            return None
        return SearchResult(value.fingerprint, value.hits, value.notice, "cache", value.raw)

    def _remember(self, key: str, value: Optional[SearchResult]) -> None:
        if self.cache_ttl <= 0:
            return
        if len(self._cache) > 1000:
            self._cache.pop(next(iter(self._cache)))
        self._cache[key] = (time.monotonic(), value)

    # -- request building ----------------------------------------------------------------
    def _pause(self, attempt: int) -> float:
        return self.retry_delays[min(attempt, len(self.retry_delays) - 1)] * (1 + random.random() * 0.25)

    @staticmethod
    def _found(data: Dict[str, Any]) -> SearchResult:
        return SearchResult(data["fingerprint"], _hits(data["results"]), data["notice"], "fingerprint", data)

    @staticmethod
    def _check(res: httpx.Response) -> Dict[str, Any]:
        try:
            data = res.json()
        except json.JSONDecodeError:
            data = {}
        if res.status_code in UNAVAILABLE:
            raise MyrmoError(res.status_code, "unavailable", "The Myrmo colony is temporarily unavailable (HTTP %d). It is probably restarting: try again in a few seconds." % res.status_code)
        if res.status_code >= 400 and res.status_code != 404:
            err = (data or {}).get("error", {})
            raise MyrmoError(res.status_code, err.get("code", "http_error"), err.get("message", res.reason_phrase), err.get("details"))
        return data

    def _search_body(self, error: str, error_type: str, runtime, runtime_version, packages, limit, min_strength) -> Dict[str, Any]:
        environment = detect_environment()
        environment.pop("packages")
        if runtime:
            environment["runtime"] = {"name": runtime, **({"version": runtime_version} if runtime_version else {})}
        else:
            environment.pop("runtime")
        if packages:
            environment["packages"] = [parse_package(p) for p in packages]
        body: Dict[str, Any] = {"query": error, "environment": environment, "limit": limit, "min_strength": min_strength}
        if error_type:
            body["error_type"] = error_type
        return body

    @staticmethod
    def _outcome_body(outcome: str, notes, agent_info, environment) -> Dict[str, Any]:
        if outcome not in OUTCOMES:
            raise ValueError(f"outcome must be one of {OUTCOMES}")
        body: Dict[str, Any] = {
            "protocol_version": "1.0",
            "outcome": outcome,
            "agent_info": agent_info or {"model": "unknown", "framework": "myrmo-python", "sdk_version": SDK_VERSION},
        }
        env = environment if environment is not None else detect_environment()
        if env.get("os") and env.get("runtime", {}).get("version"):
            body["environment"] = env
        if notes:
            body["notes"] = notes[:1000]
        return redact_value(body)

    def preview(self, trail: Dict[str, Any]) -> tuple:
        """`(redacted_trail, report)`: the trail exactly as it would be sent. Sends nothing.

        Names of organisations, customers, people or projects are not detected by `preview`: ask `possible_names`
        for runs of capitalised words that a person should check before approving."""
        report: Report = {}
        return redact_value(trail, report), report

    def possible_names(self, trail: Dict[str, Any]) -> List[str]:
        """Runs of capitalised words in what `preview` would send that could be a name, not redacted. Show them to
        whoever approves the publication."""
        return possible_names(self.preview(trail)[0])


class Colony(_Base):
    """Synchronous client.

    >>> colony = Colony()
    >>> hits = colony.search("ModuleNotFoundError: No module named 'distutils'", runtime="python")
    >>> colony.report(hits[0].trail_id, "worked")
    """

    def __init__(self, *args, transport: Optional[httpx.BaseTransport] = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._http = httpx.Client(base_url=self.url, headers=self.headers, timeout=self.timeout, transport=transport)

    def close(self) -> None:
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _read(self, method: str, url: str, **kwargs) -> httpx.Response:
        """A call that may be repeated without harm (a lookup, a search, a check): tried again while the colony is briefly unavailable."""
        for attempt in range(self.retries + 1):
            last = attempt >= self.retries
            try:
                res = self._http.request(method, url, **kwargs)
            except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadError):
                # A refused or reset connection is what a restart looks like. A timeout is not retried.
                if last:
                    raise
                time.sleep(self._pause(attempt))
                continue
            if res.status_code in UNAVAILABLE and not last:
                time.sleep(self._pause(attempt))
                continue
            return res
        raise AssertionError("unreachable")

    def lookup(self, fp: str, model: Optional[str] = None) -> Optional[SearchResult]:
        """Trails for a fingerprint, or None when the colony has none."""
        cached = self._cached(fp)
        if cached is not ...:
            return cached
        res = self._read("GET", f"/v1/trails/by-fingerprint/{fp}", headers=_model_header(model))
        # 400: a colony that predates fp2 does not know the key. Nothing exact to offer; the search that follows still finds the trail.
        value = None if res.status_code in (400, 404) else self._found(self._check(res))
        self._remember(fp, value)
        return value

    def search(
        self,
        error: str,
        error_type: Optional[str] = None,
        runtime: Optional[str] = None,
        runtime_version: Optional[str] = None,
        packages: Sequence[Union[str, Dict[str, str]]] = (),
        limit: int = 3,
        min_strength: float = 0.0,
        model: Optional[str] = None,
    ) -> SearchResult:
        """Find trails for an error: fingerprint first, semantic search when there is no exact match.
        `model` says which model asks, for aggregate counters (it overrides the client's own)."""
        error = redact_text(error)
        error_type = error_type or guess_error_type(error)
        fp = fingerprint2(error)
        exact = self.lookup(fp, model)
        if exact and exact.hits:
            return exact
        body = self._search_body(error, error_type, runtime, runtime_version, packages, limit, min_strength)
        key = f"search:{fp}:{json.dumps(body, sort_keys=True)}"
        cached = self._cached(key)
        if cached is not ... and cached is not None:
            return cached
        data = self._check(self._read("POST", "/v1/search", json=body, headers=_model_header(model)))
        value = SearchResult(data["fingerprint"], _hits(data["results"]), data["notice"], "search", data)
        self._remember(key, value)
        return value

    def report(self, trail_id: str, outcome: str, notes: Optional[str] = None, agent_info=None, environment=None) -> Dict[str, Any]:
        """Tell the colony whether a trail worked. Failures matter as much as successes."""
        res = self._http.post(f"/v1/trails/{trail_id}/outcomes", json=self._outcome_body(outcome, notes, agent_info, environment))
        data = self._check(res)
        if res.status_code == 404:
            raise MyrmoError(404, "not_found", "No indexed trail with that id.")
        self._cache.clear()
        return data

    def validate(self, trail: Dict[str, Any]) -> Dict[str, Any]:
        """Ask the colony whether it would accept this trail, without publishing it: the schema check
        publishing runs first. Nothing is stored and no publishing quota is used. Returns
        `{"valid": True, "fingerprint": ..., "redactions": {...}}`, `{"valid": False, "errors": [{"path", "message"}]}`,
        or `{"valid": None, "reason": ...}` when the colony cannot say (unreachable, or an older one)."""
        redacted, _ = self.preview(trail)
        try:
            res = self._read("POST", "/v1/validate", json=redacted)
        except httpx.HTTPError as exc:
            return {"valid": None, "reason": str(exc)}
        if res.status_code == 404:
            return {"valid": None, "reason": "this colony does not offer validation"}
        if res.status_code == 400:
            err = (res.json() or {}).get("error", {})
            if err.get("code") == "invalid_trail":
                return {"valid": False, "errors": [{"path": str(d.get("path", "")), "message": str(d.get("message", ""))} for d in err.get("details") or []]}
        if res.status_code != 200:
            return {"valid": None, "reason": "HTTP %d" % res.status_code}
        data = res.json()
        return {"valid": True, "fingerprint": data.get("fingerprint"), "redactions": data.get("redactions") or {}}

    def publish(self, trail: Dict[str, Any]) -> Dict[str, Any]:
        """Publish a trail. Redacts locally first; the colony redacts again."""
        redacted, report = self.preview(trail)
        data = self._check(self._http.post("/v1/trails", json=redacted))
        for kind, n in (data.get("redactions") or {}).items():
            report[kind] = report.get(kind, 0) + n
        data["redactions"] = report
        return data

    def create_draft(self, trail: Dict[str, Any]) -> Dict[str, Any]:
        """Ask the colony to hold a trail until a person approves it in a browser.

        For clients that cannot ask their user: nothing is published until the user opens
        `approve_url` and chooses. Redacts locally first."""
        redacted, report = self.preview(trail)
        return _draft_result(self._check(self._http.post("/v1/drafts", json=redacted)), report)

    def draft(self, draft_id: str) -> Optional[Dict[str, Any]]:
        """State of a draft (`pending`, `published` or `discarded`), or None when it expired."""
        res = self._read("GET", f"/v1/drafts/{draft_id}")
        data = self._check(res)
        return None if res.status_code == 404 else data

    def trail(self, trail_id: str) -> Optional[Dict[str, Any]]:
        res = self._read("GET", f"/v1/trails/{trail_id}")
        data = self._check(res)
        return None if res.status_code == 404 else data

    def wait_for_trail(self, trail_id: str, timeout: float = 30.0, interval: float = 1.5) -> Optional[Dict[str, Any]]:
        """Publishing returns while the colony still checks the trail. Wait for its verdict
        (`indexed`, `merged` or `rejected` with `reasons`); returns the last state seen."""
        deadline = time.monotonic() + timeout
        while True:
            trail = self.trail(trail_id)
            if trail is None or trail.get("status") != "queued" or time.monotonic() >= deadline:
                return trail
            time.sleep(interval)

    def session(self, task: str, **kwargs) -> "Session":
        """Start a session for one task. See `myrmo.Session`."""
        from .session import Session

        return Session(self, task, **kwargs)


class AsyncColony(_Base):
    """Asynchronous client with the same methods as `Colony`."""

    def __init__(self, *args, transport: Optional[httpx.AsyncBaseTransport] = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._http = httpx.AsyncClient(base_url=self.url, headers=self.headers, timeout=self.timeout, transport=transport)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.aclose()

    async def _read(self, method: str, url: str, **kwargs) -> httpx.Response:
        """Like Colony._read: a call that may be repeated without harm, tried again while the colony is briefly unavailable."""
        for attempt in range(self.retries + 1):
            last = attempt >= self.retries
            try:
                res = await self._http.request(method, url, **kwargs)
            except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadError):
                if last:
                    raise
                await asyncio.sleep(self._pause(attempt))
                continue
            if res.status_code in UNAVAILABLE and not last:
                await asyncio.sleep(self._pause(attempt))
                continue
            return res
        raise AssertionError("unreachable")

    async def lookup(self, fp: str, model: Optional[str] = None) -> Optional[SearchResult]:
        cached = self._cached(fp)
        if cached is not ...:
            return cached
        res = await self._read("GET", f"/v1/trails/by-fingerprint/{fp}", headers=_model_header(model))
        value = None if res.status_code in (400, 404) else self._found(self._check(res))
        self._remember(fp, value)
        return value

    async def search(self, error: str, error_type=None, runtime=None, runtime_version=None, packages=(), limit: int = 3, min_strength: float = 0.0, model: Optional[str] = None) -> SearchResult:
        error = redact_text(error)
        error_type = error_type or guess_error_type(error)
        fp = fingerprint2(error)
        exact = await self.lookup(fp, model)
        if exact and exact.hits:
            return exact
        body = self._search_body(error, error_type, runtime, runtime_version, packages, limit, min_strength)
        key = f"search:{fp}:{json.dumps(body, sort_keys=True)}"
        cached = self._cached(key)
        if cached is not ... and cached is not None:
            return cached
        data = self._check(await self._read("POST", "/v1/search", json=body, headers=_model_header(model)))
        value = SearchResult(data["fingerprint"], _hits(data["results"]), data["notice"], "search", data)
        self._remember(key, value)
        return value

    async def report(self, trail_id: str, outcome: str, notes=None, agent_info=None, environment=None) -> Dict[str, Any]:
        res = await self._http.post(f"/v1/trails/{trail_id}/outcomes", json=self._outcome_body(outcome, notes, agent_info, environment))
        data = self._check(res)
        if res.status_code == 404:
            raise MyrmoError(404, "not_found", "No indexed trail with that id.")
        self._cache.clear()
        return data

    async def publish(self, trail: Dict[str, Any]) -> Dict[str, Any]:
        redacted, report = self.preview(trail)
        data = self._check(await self._http.post("/v1/trails", json=redacted))
        for kind, n in (data.get("redactions") or {}).items():
            report[kind] = report.get(kind, 0) + n
        data["redactions"] = report
        return data

    async def create_draft(self, trail: Dict[str, Any]) -> Dict[str, Any]:
        redacted, report = self.preview(trail)
        return _draft_result(self._check(await self._http.post("/v1/drafts", json=redacted)), report)

    async def draft(self, draft_id: str) -> Optional[Dict[str, Any]]:
        res = await self._read("GET", f"/v1/drafts/{draft_id}")
        data = self._check(res)
        return None if res.status_code == 404 else data

    async def trail(self, trail_id: str) -> Optional[Dict[str, Any]]:
        res = await self._read("GET", f"/v1/trails/{trail_id}")
        data = self._check(res)
        return None if res.status_code == 404 else data

    async def wait_for_trail(self, trail_id: str, timeout: float = 30.0, interval: float = 1.5) -> Optional[Dict[str, Any]]:
        deadline = time.monotonic() + timeout
        while True:
            trail = await self.trail(trail_id)
            if trail is None or trail.get("status") != "queued" or time.monotonic() >= deadline:
                return trail
            await asyncio.sleep(interval)
