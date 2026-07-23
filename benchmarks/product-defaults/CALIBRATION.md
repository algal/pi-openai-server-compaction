# Product-default benchmark calibration trace

This is the corrected calibration using Pi 0.80.9's default `medium` thinking
level and the extension's corresponding default Responses reasoning shape. Its
exploratory seed is excluded from the held-out totals.

The goal was to find fixed-context information densities above the easy 75/75
ceiling without imposing artificially short output caps.

| Seed | Density/category | Records | Full | Pi default | Native | Pi output tokens | Native output tokens | Recorded cost |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 111 | 120 | 600 | 75 | 75 | 75 | 11,445 | 12,905 | $2.4723 |
| 111 | 160 | 800 | 75 | 75 | 39 | 11,080 | 4,468 | $2.1888 |
| 111 | 200 | 1,000 | 75 | 40 | 41 | 3,819 | 3,913 | $1.9524 |

Every fixture targeted 50,000 estimated history tokens; the generator replaced
unrelated filler with authoritative records as density increased. Density 120
was too easy for both policies. Pi remained at ceiling at 160, while both arms
were off ceiling at 200. Density 180 was therefore locked as an interpolated
shoulder and density 200 as the observed stress point before fresh seeds 301–304
were run.

This was deliberately a sparse calibration, not an inferential sample. It also
exposed large native output variation: density 120 produced 12,905 native
output tokens, while densities 160 and 200 produced fewer than 4,500. Density
should therefore be understood as one controlled difficulty variable, not a
guarantee of monotonic native performance.

Corrected calibration cost was $6.6135. Its 225 question-level scores are not
included in the report's 600-question confirmatory totals.

An earlier calibration used reasoning off. That setting is not Pi's product
default, so neither its calibration nor holdout is used in the primary result.
That raw bundle is intentionally excluded from the published evidence.
