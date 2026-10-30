"""A colony that is restarting answers 502 for a few seconds. A read is tried again; a write never is."""

import asyncio

import httpx
import pytest

from conftest import KNOWN_FP, RESULT, TRAIL
from myrmo import AsyncColony, Colony, MyrmoError

FAST = (0.001,)
ERROR = "ModuleNotFoundError: No module named 'distutils'"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("MYRMO_CONFIG", str(tmp_path / "config.json"))


def sequence(*answers):
    """A colony that answers with each status in turn (the last one repeats) and counts what it was asked."""
    asked = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append((request.method, request.url.path))
        status = answers[min(len(asked) - 1, len(answers) - 1)]
        if status == "refused":
            raise httpx.ConnectError("connection refused")
        if status == 200 and request.url.path.startswith("/v1/trails/by-fingerprint/"):
            return httpx.Response(200, json={"fingerprint": KNOWN_FP, "results": [RESULT], "notice": "untrusted"})
        if status == 200 and request.url.path == "/v1/search":
            return httpx.Response(200, json={"fingerprint": "fp1_0000000000000000", "results": [], "notice": "untrusted"})
        if status == 200:
            return httpx.Response(202, json={"trail_id": "c71e0f4a-2b9d-4e63-a8f5-0d3b7c1e9a26", "fingerprint": KNOWN_FP, "status": "queued", "redactions": {}})
        return httpx.Response(status, text="Bad Gateway")

    return handler, asked


def colony(handler, **kwargs):
    return Colony(url="http://colony.test", transport=httpx.MockTransport(handler), cache_ttl=0, retry_delays=FAST, **kwargs)


def test_a_lookup_is_tried_again_while_the_colony_restarts():
    handler, asked = sequence(502, 502, 200)
    result = colony(handler).search(ERROR, runtime="python")
    assert result[0].trail_id and len(asked) == 3, "two 502s, then the answer"


def test_a_refused_connection_is_tried_again_too():
    handler, asked = sequence("refused", "refused", 200)
    assert colony(handler).search(ERROR, runtime="python").source == "fingerprint"
    assert len(asked) == 3


def test_a_search_is_tried_again():
    handler, asked = sequence(404, 503, 200)  # no fingerprint match, then the semantic search recovers
    colony(handler).search("some other error line that nobody has solved", runtime="python")
    assert [path for _, path in asked].count("/v1/search") == 2


def test_still_down_after_the_retries_says_so_in_words_not_as_an_http_error():
    handler, asked = sequence(502)
    with pytest.raises(MyrmoError) as err:
        colony(handler).search(ERROR, runtime="python")
    assert err.value.code == "unavailable" and err.value.status == 502
    assert "temporarily unavailable" in str(err.value) and "try again in a few seconds" in str(err.value)
    assert len(asked) == 4, "the first try and three more"


def test_retries_can_be_switched_off():
    handler, asked = sequence(502, 200)
    with pytest.raises(MyrmoError):
        colony(handler, retries=0).search(ERROR, runtime="python")
    assert len(asked) == 1


def test_publishing_is_never_repeated():
    handler, asked = sequence(502, 200)
    with pytest.raises(MyrmoError) as err:
        colony(handler).publish(TRAIL)
    assert err.value.code == "unavailable"
    assert len(asked) == 1, "a publish that may have arrived must not be sent twice"


def test_a_bad_request_is_not_retried():
    handler, asked = sequence(400)
    with pytest.raises(MyrmoError) as err:
        colony(handler).search(ERROR, runtime="python")
    # The exact lookup treats a 400 as "no exact answer" (a colony that predates fp2) and the search that follows is
    # the request that fails. Neither is tried again.
    assert err.value.code == "http_error" and [m for m, _ in asked] == ["GET", "POST"]


def test_the_async_client_does_the_same():
    handler, asked = sequence(502, 502, 200)

    async def run():
        async with AsyncColony(url="http://colony.test", transport=httpx.MockTransport(handler), cache_ttl=0, retry_delays=FAST) as c:
            return await c.search(ERROR, runtime="python")

    assert asyncio.run(run())[0].trail_id
    assert len(asked) == 3
