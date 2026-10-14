"""An organisation's colony (protocol 1.7): it says what it is, answers task requests, keeps the network's names, and
collects what solving a problem cost."""

import json

import httpx
import pytest

from myrmo import Colony
from myrmo.redact import redact_text

TRAIL_ID = "3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b"


def colony_with(handler, **kwargs):
    return Colony(url="http://colony.internal:8080", agent_id="tester_123", transport=httpx.MockTransport(handler), retries=0, **kwargs)


def test_the_colony_says_what_it_is():
    def handler(request):
        assert request.url.path == "/v1/version"
        return httpx.Response(200, json={"server": "0.17.0", "colony": {"profile": "organisation", "effort": True, "people_detail": "aggregate"}})

    with colony_with(handler) as c:
        assert c.colony_info()["profile"] == "organisation"


def test_a_task_request_goes_to_the_task_index():
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"results": [], "notice": "untrusted"})

    with colony_with(handler, private=True) as c:
        assert len(c.search_task("despliega un tenant nuevo en dev-db-02.corp", limit=50)) == 0
    assert seen["mode"] == "task" and seen["limit"] == 10
    assert "dev-db-02.corp" in seen["query"], "an organisation's colony keeps its host names"


def test_the_network_stays_only_for_a_private_colony_and_never_for_the_public_one():
    line = "connect ECONNREFUSED 10.20.0.7:5432 on db-01.corp"
    assert "10.20.0.7" not in redact_text(line)
    assert "10.20.0.7" in redact_text(line, keep_network=True)
    assert "sk-" not in redact_text("token sk-abcdefghijklmnopqrstuvwxyz0123", keep_network=True)
    public = Colony(url="https://myrmo.dev", private=True, agent_id=False)
    assert public.private is False


def test_effort_is_sent_with_numbers_only_and_an_aided_record_names_its_trail():
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(202, json={"stored": True, "role": "aided"})

    with colony_with(handler) as c:
        ok = c.report_effort("aided", "migrate: lock 'migrate' is held by ci-runner-17", {"output_tokens": 400, "turns": 3, "bogus": 1}, trail_id=TRAIL_ID)
        assert ok is True
        with pytest.raises(ValueError):
            c.report_effort("aided", "migrate: lock 'migrate' is held", {"turns": 1})
        with pytest.raises(ValueError):
            c.report_effort("holdout", "migrate: lock 'migrate' is held", {"turns": 1})
    assert sent[0]["protocol_version"] == "1.7"
    assert sent[0]["effort"] == {"output_tokens": 400, "turns": 3}
    assert sent[0]["trail_id"] == TRAIL_ID


def test_a_colony_that_does_not_collect_effort_is_not_an_error():
    with colony_with(lambda request: httpx.Response(404, json={"error": {"code": "not_collected", "message": "no"}})) as c:
        assert c.report_effort("unaided", "some error line here", {"turns": 2}) is False
