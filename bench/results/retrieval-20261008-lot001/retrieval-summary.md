Retrieval benchmark: 86 published trails, seed 7, up to 5 results per search.

| Variant | Searches | Top 1 | Top 3 | MRR | Wrong trail on top | Answered by | p50 |
|---|---|---|---|---|---|---|---|
| exact | 76 | 100% | 100% | 1.00 | 0% | fingerprint 76 | 2.1 ms |
| shifted | 76 | 100% | 100% | 1.00 | 0% | fingerprint 69, search 7 | 1.2 ms |
| wrapped | 76 | 100% | 100% | 1.00 | 0% | fingerprint 56, search 20 | 1.3 ms |
| stack_header | 76 | 89% | 89% | 0.89 | 5% | search 76 | 28.9 ms |
| no_type_prefix | 59 | 100% | 100% | 1.00 | 0% | fingerprint 44, search 15 | 1.4 ms |
| truncated | 48 | 96% | 98% | 0.97 | 2% | search 48 | 20.1 ms |

10 corpus trails have an error message of fewer than three words (for example `EACCES`); they are left out of the table above. Their searches found the trail in 35 of 40.

| Should find nothing | Searches | Returned a trail | Wrong answers |
|---|---|---|---|
| Errors no trail covers | 39 | 8 | 6 (15%) |
| Look-alikes (another module or key) | 7 | 2 | 1 (14%) |

What a stricter similarity floor would have done with the same searches (semantic answers only; the colony's default is 0.72):

| Floor | Found on top | Wrong on top, positives | Wrong on top, negatives |
|---|---|---|---|
| 0.72 | 156 of 166 | 5 | 7 of 46 |
| 0.75 | 152 of 166 | 4 | 2 of 46 |
| 0.78 | 146 of 166 | 3 | 1 of 46 |
| 0.80 | 137 of 166 | 2 | 0 of 46 |
| 0.85 | 105 of 166 | 1 | 0 of 46 |
