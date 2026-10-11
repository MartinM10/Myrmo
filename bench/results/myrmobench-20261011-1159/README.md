# myrmobench-20261011-1159

Company suite (`acme-*`, a fictional company), Antigravity CLI, local colony in private mode (`--private`), followers `gpt-oss-120b-medium` and `gemini-3.8-flash-low`, 5 repetitions per cell unless said otherwise. See docs/operate/benchmarks.md for the analysis.

Empty colony. Conditions `without`, `unseen`, `with`; Myrmo's rules only (no hook). The four pioneers (`gemini-3.1-pro-high`) solved three tasks and published **nothing** (no Myrmo call), so the colony stayed empty and the run was stopped at 90 of 124: its `with` rows measure an empty colony, not a trail. `acme-private-index` hung on pip's username prompt for GPT-OSS in every condition (fixed afterwards with `PIP_NO_INPUT=1`), so its rows for that task measure nothing about Myrmo.
