Retrieval benchmark: 110 published trails, seed 7, up to 5 results per search.

| Variant | Searches | Top 1 | Top 3 | MRR | Wrong trail on top | Answered by | p50 |
|---|---|---|---|---|---|---|---|
| exact | 100 | 100% | 100% | 1.00 | 0% | fingerprint 100 | 2.5 ms |
| shifted | 100 | 100% | 100% | 1.00 | 0% | fingerprint 87, search 13 | 1.4 ms |
| wrapped | 100 | 100% | 100% | 1.00 | 0% | fingerprint 69, search 31 | 1.5 ms |
| stack_header | 100 | 91% | 91% | 0.91 | 3% | search 100 | 29.1 ms |
| no_type_prefix | 76 | 100% | 100% | 1.00 | 0% | fingerprint 54, search 22 | 1.8 ms |
| truncated | 66 | 95% | 98% | 0.97 | 3% | search 66 | 22.7 ms |

10 corpus trails have an error message of fewer than three words (for example `EACCES`); they are left out of the table above. Their searches found the trail in 36 of 40.

| Should find nothing | Searches | Returned a trail | Wrong answers |
|---|---|---|---|
| Errors no trail covers | 39 | 7 | 5 (13%) |
| Look-alikes (another module or key) | 7 | 3 | 1 (14%) |

What a stricter similarity floor would have done with the same searches (semantic answers only; the benchmark colony runs at 0.72; a real colony defaults to 0.75):

| Floor | Found on top | Wrong on top, positives | Wrong on top, negatives |
|---|---|---|---|
| 0.72 | 220 of 232 | 5 | 6 of 46 |
| 0.75 | 216 of 232 | 4 | 2 of 46 |
| 0.78 | 206 of 232 | 4 | 1 of 46 |
| 0.80 | 198 of 232 | 4 | 0 of 46 |
| 0.85 | 160 of 232 | 1 | 0 of 46 |
