# myrmobench-20261011-2118

Company suite, Antigravity CLI, private mode, follower gpt-oss-120b-medium, 5 repetitions, `with` and the hooks' own lookup (`--lookup`), on the colony of run 1714's pioneers, after the fix of how trails show risk (myrmo 0.14.1: the clients say when no command is flagged). 14 of 20 solved (`acme-db-lock` 4 of 5, from 0 of 5 in run 1856). Transcripts kept locally.

Caveats: only the `with` condition ran, so there is no same-run control; the 7 of 20 it is compared with comes from an earlier run on another colony state and version. With 21 successes in total, Fisher's exact test gives p ≈ 0.06 (two-sided) for 14 of 20 against 7 of 20. The cost fields are 0.0 because Antigravity reports no cost: the true spend is unmeasured (the console's ~$1.78 is an estimate from tokens). Those fields are now recorded as unmeasured in new runs (see the commit that changed the parsers).
