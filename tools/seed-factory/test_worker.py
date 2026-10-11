"""The seed worker's own logic: what the agent is shown, what provenance records, which leads are tried. No Docker, no agent."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import provenance  # noqa: E402
import worker  # noqa: E402
from catalog import drafts  # noqa: E402

EVIDENCE = [{"title": "ts-node doesn't work with Typescript 7.0.2", "url": "https://github.com/TypeStrong/ts-node/issues/1", "comments": 8,
             "repo": "TypeStrong/ts-node", "licence": "MIT"},
            {"title": "TypeScript 7.0.2 fails on Node 20", "url": "https://github.com/TypeStrong/ts-node/issues/2", "comments": 3,
             "repo": "TypeStrong/ts-node", "licence": "MIT"}]
LEAD = {"ecosystem": "npm", "package": "typescript", "version": "7.0.2", "signal": "esm-only", "detail": "x", "released": "2026-07-08",
        "source": "s", "repo": "microsoft/TypeScript", "evidence": EVIDENCE}


def test_the_agent_is_shown_what_people_report_as_pointers_and_told_not_to_copy_it():
    block = worker.reports_block(LEAD)
    assert "ts-node doesn't work with Typescript 7.0.2 (TypeStrong/ts-node, 8 comments)" in block
    assert "do not copy them" in block
    assert worker.reports_block({**LEAD, "evidence": []}) == "" and worker.reports_block({}) == ""
    prompt = worker.PROMPT.format(task_id="t", image="node:20", reports=block, **LEAD)
    assert prompt.index("WHAT PEOPLE REPORT") < prompt.index("GOAL:")


def test_provenance_lists_each_repository_once_as_discovery():
    sources = worker.sources_of(LEAD)
    assert sources == [{"kind": "repository", "ref": "https://github.com/TypeStrong/ts-node", "licence": "MIT", "used_as": "discovery"}]
    assert worker.sources_of({}) == []


def test_a_source_outside_the_policy_makes_the_provenance_fail():
    record = provenance.record(task_id="t", batch="b", image="node:20", public_trail={"a": 1}, model=None,
                               sources=[{"kind": "repository", "ref": "https://github.com/x/y", "licence": "GPL-3.0-only", "used_as": "discovery"}])
    assert any("licence 'GPL-3.0-only'" in p for p in provenance.check(record))
    ok = provenance.record(task_id="t", batch="b", image="node:20", public_trail={"a": 1}, model=None, sources=worker.sources_of(LEAD))
    assert provenance.check(ok) == []


def test_a_draft_carries_its_sources_into_the_task(tmp_path):
    draft = {f: "x" for f in drafts.FIELDS}
    draft.update({"runtime": {"name": "node", "version": "20"}, "failed_approaches": ["a", "b"], "steps": ["s"], "tags": ["t"],
                  "task_id": "radar-x", "_sources": worker.sources_of(LEAD)})
    path = tmp_path / "radar-x.json"
    path.write_text(json.dumps(draft), encoding="utf-8")
    task = drafts.load(path)
    assert task.sources == tuple(worker.sources_of(LEAD)) and task.ecosystem == "radar"


def test_leads_with_a_verdict_are_not_tried_again_but_refusals_are(tmp_path, monkeypatch):
    monkeypatch.setattr(worker, "SEED_OUT", tmp_path)
    rows = [{"task_id": "skipped", "outcome": "skip"}, {"task_id": "made", "outcome": "valid"}, {"task_id": "refused", "outcome": "refused"},
            {"task_id": "empty", "outcome": "no task.json"}]
    (tmp_path / "radar-001-worker.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\nnot json\n", encoding="utf-8")
    assert worker.attempted() == {"skipped", "made"}


@pytest.mark.parametrize("lead,image", [
    ({"ecosystem": "npm", "signal": "runtime-floor", "detail": "requires Node 22.12.0 (was 20.0.0)"}, "node:20-bookworm-slim"),
    ({"ecosystem": "npm", "signal": "major", "detail": ""}, "node:20-bookworm-slim"),
    ({"ecosystem": "pypi", "signal": "runtime-floor", "detail": "requires Python 3.12.0 (was 3.11.0)"}, "python:3.11-slim-bookworm"),
    ({"ecosystem": "pypi", "signal": "major", "detail": ""}, "python:3.12-slim-bookworm"),
])
def test_the_base_image_is_the_runtime_just_below_a_raised_floor(lead, image):
    assert worker.base_image(lead) == image
