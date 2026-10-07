Retrieval benchmark: 46 published trails, seed 7, up to 5 results per search.

| Variant | Searches | Top 1 | Top 3 | MRR | Wrong trail on top | Answered by | p50 |
|---|---|---|---|---|---|---|---|
| exact | 37 | 100% | 100% | 1.00 | 0% | fingerprint 11, search 26 | 20.3 ms |
| shifted | 37 | 97% | 97% | 0.97 | 0% | fingerprint 11, search 26 | 22.4 ms |
| wrapped | 37 | 97% | 97% | 0.97 | 0% | search 37 | 24.4 ms |
| stack_header | 37 | 86% | 86% | 0.86 | 8% | search 37 | 33.7 ms |
| truncated | 16 | 100% | 100% | 1.00 | 0% | search 16 | 24.6 ms |
| no_type_prefix | 29 | 97% | 97% | 0.97 | 0% | search 29 | 22.2 ms |

9 corpus trails have an error message of fewer than three words (for example `EACCES`); they are left out of the table above. Their searches found the trail in 21 of 36.

| Should find nothing | Searches | Returned a trail | Wrong answers |
|---|---|---|---|
| Errors no trail covers | 39 | 7 | 5 (13%) |
| Look-alikes (another module or key) | 7 | 1 | 0 (0%) |

What a stricter similarity floor would have done with the same searches (semantic answers only; the colony's default is 0.72):

| Floor | Found on top | Wrong on top, positives | Wrong on top, negatives |
|---|---|---|---|
| 0.72 | 163 of 171 | 3 | 5 of 46 |
| 0.75 | 158 of 171 | 1 | 1 of 46 |
| 0.78 | 146 of 171 | 1 | 0 of 46 |
| 0.80 | 135 of 171 | 3 | 0 of 46 |
| 0.85 | 103 of 171 | 0 | 0 of 46 |
