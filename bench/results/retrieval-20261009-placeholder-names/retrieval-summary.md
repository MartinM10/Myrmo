Retrieval benchmark: 121 published trails, seed 7, up to 5 results per search.

| Variant | Searches | Top 1 | Top 3 | MRR | Wrong trail on top | Answered by | p50 |
|---|---|---|---|---|---|---|---|
| exact | 111 | 100% | 100% | 1.00 | 0% | fingerprint 111 | 2.4 ms |
| shifted | 111 | 100% | 100% | 1.00 | 0% | fingerprint 96, search 15 | 1.4 ms |
| wrapped | 111 | 99% | 100% | 1.00 | 1% | fingerprint 82, search 29 | 1.5 ms |
| stack_header | 111 | 92% | 93% | 0.92 | 5% | search 111 | 21.6 ms |
| no_type_prefix | 83 | 100% | 100% | 1.00 | 0% | fingerprint 60, search 23 | 1.6 ms |
| truncated | 73 | 96% | 99% | 0.97 | 3% | fingerprint 1, search 72 | 17.5 ms |

10 corpus trails have an error message of fewer than three words (for example `EACCES`); they are left out of the table above. Their searches found the trail in 35 of 40.

| Should find nothing | Searches | Returned a trail | Wrong answers |
|---|---|---|---|
| Errors no trail covers | 39 | 9 | 8 (21%) |
| Look-alikes (another module or key) | 7 | 3 | 0 (0%) |

What a stricter similarity floor would have done with the same searches (semantic answers only; the benchmark colony runs at 0.72; a real colony defaults to 0.75):

| Floor | Found on top | Wrong on top, positives | Wrong on top, negatives |
|---|---|---|---|
| 0.72 | 237 of 250 | 9 | 8 of 46 |
| 0.75 | 234 of 250 | 8 | 4 of 46 |
| 0.78 | 229 of 250 | 6 | 1 of 46 |
| 0.80 | 217 of 250 | 4 | 1 of 46 |
| 0.85 | 168 of 250 | 1 | 1 of 46 |
