# Coverage: how likely is it that an error finds a trail?

Counting trails says little: a thousand trails nobody searches for are worth less than a hundred that answer. This suite
measures the probability instead.

1. **Probes** (`probes/<ecosystem>.py`). Each one is a real breakage reproduced in a pinned Docker image, from a project
   whose documentation or code tells that the break exists (and whose licence the project can build on, see
   `tools/seed-factory/provenance.py`). `capture.py` runs the probe and keeps the error line it prints, with the digest of the
   image. A probe that does not reproduce is dropped (`rejected-probes.json`). `sources.py` fetches the source of each probe
   and checks that it exists, that its licence is allowed and that it contains the phrase the probe names. That check shows the
   source is about the subject; it does not prove that the source spells out this exact message.
2. **Split** (`split.py`). The lines are dealt at random, by ecosystem and from a fixed seed, into `candidate` and `reserved`.
   Only candidates may become tasks of the seed factory (the factory refuses a reserved one). Coverage is measured on the
   reserved half, which no trail was made from.
3. **Run** (`run.py`). Each line is searched the way an agent does with the Python SDK: the exact fingerprint first, then the
   semantic search. What comes back is judged against the line's rubric (`must`: patterns that the text of a trail has to match,
   all of them). A result is a `hit` (a trail that solves it came back), a `miss` (one exists in the colony and did not come
   back), a `false_positive` (trails came back and none solves it) or `silence` (nothing came back and nothing in the colony
   solves it: the right answer). A trail that matches only some patterns is listed as dubious, for a person to read.

The rubric is strict on purpose and is a heuristic: two rubrics were tightened after reading the hits of the first runs (a
glibc trail was counted for the opposite problem, a class-version trail for a Gradle one), and the numbers in the docs are
those of the corrected rubric.

```bash
python bench/coverage/capture.py && python bench/coverage/sources.py && python bench/coverage/split.py
python bench/coverage/run.py --base http://localhost:8080 --split reserved --out bench/results/coverage-YYYYMMDD
```

Run it against a colony on your own machine: a search counts in the public colony's statistics.
