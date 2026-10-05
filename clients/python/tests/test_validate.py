"""Colony.validate asks the colony whether it would accept a trail, and says so plainly when it cannot tell."""

import httpx
import pytest

from conftest import TRAIL
from myrmo import Colony


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("MYRMO_CONFIG", str(tmp_path / "config.json"))


def colony_answering(status, body=None):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return httpx.Response(status, json=body if body is not None else {})

    return Colony(url="http://colony.test", transport=httpx.MockTransport(handler), cache_ttl=0), seen


def test_a_trail_the_colony_accepts():
    colony, seen = colony_answering(200, {"valid": True, "fingerprint": "fp1_abc", "redactions": {"api_key": 1}})
    assert colony.validate(TRAIL) == {"valid": True, "fingerprint": "fp1_abc", "redactions": {"api_key": 1}}
    assert seen == [("POST", "/v1/validate")], "validating never publishes"


def test_a_trail_the_colony_would_refuse_says_what_is_wrong():
    body = {"error": {"code": "invalid_trail", "message": "no", "details": [{"path": "/solution/verification_method/type", "message": '"manual" is not one of [...]'}]}}
    colony, _ = colony_answering(400, body)
    result = colony.validate(TRAIL)
    assert result["valid"] is False
    assert result["errors"] == [{"path": "/solution/verification_method/type", "message": '"manual" is not one of [...]'}]


def test_an_older_colony_or_one_that_is_down_is_not_a_verdict():
    old, _ = colony_answering(404, {"error": {"code": "not_found", "message": "none"}})
    result = old.validate(TRAIL)
    assert result["valid"] is None and "does not offer validation" in result["reason"]
    down, _ = colony_answering(503, {"error": {"code": "busy", "message": "later"}})
    assert down.validate(TRAIL)["valid"] is None

    def refuse(request):
        raise httpx.ConnectError("unreachable")

    unreachable = Colony(url="http://colony.test", transport=httpx.MockTransport(refuse), cache_ttl=0)
    assert unreachable.validate(TRAIL)["valid"] is None
