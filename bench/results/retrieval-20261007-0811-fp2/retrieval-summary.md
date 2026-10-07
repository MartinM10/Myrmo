Retrieval benchmark: 46 published trails, seed 7, up to 5 results per search.

| Variant | Searches | Top 1 | Top 3 | MRR | Wrong trail on top | Answered by | p50 |
|---|---|---|---|---|---|---|---|
| exact | 37 | 100% | 100% | 1.00 | 0% | fingerprint 37 | 2.0 ms |
| shifted | 37 | 100% | 100% | 1.00 | 0% | fingerprint 36, search 1 | 1.2 ms |
| wrapped | 37 | 97% | 97% | 0.97 | 0% | fingerprint 28, search 9 | 1.2 ms |
| stack_header | 37 | 86% | 86% | 0.86 | 8% | search 37 | 20.7 ms |
| truncated | 16 | 100% | 100% | 1.00 | 0% | search 16 | 16.4 ms |
| no_type_prefix | 29 | 100% | 100% | 1.00 | 0% | fingerprint 20, search 9 | 1.2 ms |

9 corpus trails have an error message of fewer than three words (for example `EACCES`); they are left out of the table above. Their searches found the trail in 30 of 36.

| Should find nothing | Searches | Returned a trail | Wrong answers |
|---|---|---|---|
| Errors no trail covers | 39 | 7 | 5 (13%) |
| Look-alikes (another module or key) | 7 | 1 | 0 (0%) |

What a stricter similarity floor would have done with the same searches (semantic answers only; the colony's default is 0.72):

| Floor | Found on top | Wrong on top, positives | Wrong on top, negatives |
|---|---|---|---|
| 0.72 | 66 of 72 | 3 | 5 of 46 |
| 0.75 | 62 of 72 | 1 | 1 of 46 |
| 0.78 | 59 of 72 | 0 | 0 of 46 |
| 0.80 | 53 of 72 | 0 | 0 of 46 |
| 0.85 | 34 of 72 | 0 | 0 of 46 |
