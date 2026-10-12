# myrmobench-20261012-1011

Company suite (`acme-*`, a fictional company; `acme-db-lock` made harder first: the supported release is the platform
team's tool that only a comment in the CLI's source mentions), Antigravity CLI, empty local colony in private mode,
pioneer `gemini-3.1-pro-high` with the hooks, follower `gpt-oss-120b-medium`, **10 repetitions** per task and condition.
Conditions: `without` (no Myrmo), `with` and `--lookup` (the hooks look the error up and show a strong match), `notes`
(no Myrmo; the same trails exported as Markdown notes, with a rule to read them). Transcripts kept locally.

All four pioneers solved their task and published (with the supported fix each time).

| Condition | Solved | Median turns (solved runs) | Median tokens (solved runs) |
|---|---|---|---|
| without | 5/40 | 22 | 32k |
| with, lookup | 21/40 | 9 | 25k |
| notes | 23/40 | 17 | 28k |

Fisher's exact test on success: lookup vs without p < 0.001, notes vs without p < 0.001, lookup vs notes p = 0.82.
Mann-Whitney on solved runs, lookup vs notes: turns p = 0.0006, tokens p = 0.06, seconds p = 0.09.
