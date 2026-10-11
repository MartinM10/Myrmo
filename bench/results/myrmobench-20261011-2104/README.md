# myrmobench-20261011-2104

Diagnostic: `acme-db-lock`, follower gpt-oss-120b-medium, 3 repetitions, `with` and the hooks' own lookup, private mode, on the colony of run 1714's pioneers. Transcripts kept locally.

All three failed the same way: the agent got the right trail (`acmectl db unlock --stale`, then `acmectl db migrate`) and stopped to ask the user for confirmation, calling the commands medium risk, so an unattended run ended there. The colony had flagged none of them (risk low); nothing said so, the trail was framed as untrusted data, and the search result marked its verification command (the same `acmectl db migrate`) "not risk-analysed, ask the user first". Without Myrmo the same model ran the unlock itself. Fixed in the clients: they now say when no command is flagged, and a verification command that is one of the analysed commands needs no extra approval.
