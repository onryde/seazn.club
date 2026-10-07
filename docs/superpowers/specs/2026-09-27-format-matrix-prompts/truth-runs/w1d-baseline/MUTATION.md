# W1d Stryker baseline: the first measured run and the floors (Task 20)

Data of record for the mutation floors. Every number below is read from a downloaded report artifact (the run and artifact ids are in the
per-leg table) or from a job log; nothing is projected except where a row says so. The floors it sets are in `packages/engine/stryker-floor.json`.

**State of this file: 81 of 81 legs have a report; every family is scored.**

Score = Stryker's total score: (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage). An uncovered line counts as a survivor. Ignored, CompileError and
RuntimeError mutants are outside the denominator; the mutants of `stryker-equivalent.json` (none yet) are taken out of it. A floor is floor(score, 1 dp) of the
SUM of a family's legs, never of one leg. A leg is one CI job (one `mutation.yml` matrix entry); a family is ruling 66's group of legs.

## 1. Family scores and floors

| family | legs (with report) | mutants (all statuses) | killed | timeout | survived | NoCov | out of score | detected / denominator | score % | floor % | mutants that must flip to fall under it |
|---|---|---|---|---|---|---|---|---|---|---|---|
| competition | 7 | 2556 | 1986 | 20 | 470 | 80 | 0 | 2006 / 2556 | 78.482 | 78.4 | 3 |
| core | 3 | 1002 | 892 | 2 | 107 | 1 | 0 | 894 / 1002 | 89.222 | 89.2 | 1 |
| modules | 7 | 2523 | 1656 | 2 | 686 | 177 | 2 | 1658 / 2521 | 65.768 | 65.7 | 2 |
| draws | 4 | 1486 | 1018 | 35 | 371 | 50 | 12 | 1053 / 1474 | 71.438 | 71.4 | 1 |
| sports-cricket | 16 | 5120 | 3666 | 5 | 1298 | 151 | 0 | 3671 / 5120 | 71.699 | 71.6 | 6 |
| sports-football | 9 | 2595 | 1861 | 3 | 657 | 74 | 0 | 1864 / 2595 | 71.830 | 71.8 | 1 |
| sports-period | 14 | 3037 | 2092 | 9 | 862 | 74 | 0 | 2101 / 3037 | 69.180 | 69.1 | 3 |
| sports-setbased | 6 | 2208 | 1652 | 6 | 501 | 49 | 0 | 1658 / 2208 | 75.091 | 75 | 3 |
| sports-nested | 8 | 1710 | 1269 | 0 | 401 | 40 | 0 | 1269 / 1710 | 74.211 | 74.2 | 1 |
| sports-other | 7 | 2591 | 1914 | 0 | 616 | 61 | 0 | 1914 / 2591 | 73.871 | 73.8 | 2 |

"Mutants that must flip" is the smallest number of detected mutants (killed or timed out) that would have to become undetected in a re-run for the family to score under its
floor. The floors are set at floor(score, 1 dp), so the slack is under 0.1 point: between 1 and 6 mutants a family.

**Controller ruling T20-FLOOR-AT-SCORE: the floor stays at the measured score** (the brief's rule, floor(score, 1 dp)), not a margin below it. Evidence, in two readings of the same measurement (section 10): with the three legs whose parts were in first, 1,295 identical mutants run twice gave 1,293 the same and 2 Timeout -> Killed (detected both times), 0 Killed, Survived or NoCoverage changes, a measured noise of 0.0 points. With the period-9 cut's three parts run (543ee2b53) the compared set is 1,523 mutants: 1,511 the same and 12 changed, every one a change to or from Timeout; 11 stayed detected (3 x Killed -> Timeout, 8 x Timeout -> Killed), 1 x Survived -> Timeout went from undetected to detected, and none went from detected to undetected. So the measured downward noise is 0 in 1,523 and the one upward flip is already in the period floor (the floors are taken from the re-run). The slack above is 1 to 6 detected mutants a family. Cost if the ruling is wrong: one weekly run goes red naming the mutant, and it is fixed by a test that kills it or by an entry in `stryker-equivalent.json`, which is the ratchet's intended signal.

## 2. Runs and where every report came from

Every report was downloaded by its run id and artifact id (never by name: duplicate artifact names exist from the contaminated and cancelled runs) and the artifact's own
metadata (name, run id, not expired) was checked against the table before unzipping. The first 78 reports are byte-identical to the copies pre-flighted before the download; the last three (the sports-period-9, -13 and -14 parts) were fetched once by id, and each passed `--check-selection` (every mutant inside the leg's files and line ranges, none Pending).

| run id | what | legs taken from it | count |
|---|---|---|---|
| 37371368951 | first full run (sha 78c7ef3e6) | 62 legs (see section 3) | 62 |
| 37538987509 | re-run of the cut part (job 112527140683, sha 34ac56eb7) | sports-cricket-9 | 1 |
| 37538997992 | re-run of the cut part (job 112527184538, sha 34ac56eb7) | sports-cricket-10 | 1 |
| 37532620624 | re-run of the cut part (job 112505632112, sha 0920dbf5e) | sports-cricket-15 | 1 |
| 37532639397 | re-run of the cut part (job 112505671221, sha 0920dbf5e) | sports-cricket-16 | 1 |
| 37532548091 | re-run of the cut part (job 112505377568, sha 0920dbf5e) | sports-football-7 | 1 |
| 37532557075 | re-run of the cut part (job 112505439220, sha 0920dbf5e) | sports-football-8 | 1 |
| 37532565988 | re-run of the cut part (job 112505454296, sha 0920dbf5e) | sports-football-9 | 1 |
| 37532530767 | re-run of the cut part (job 112505341469, sha 0920dbf5e) | sports-period-1 | 1 |
| 37539005165 | re-run of the cut part (job 112527241706, sha 34ac56eb7) | sports-period-2 | 1 |
| 37583585117 | cut part, first run of the new cut (job 112668631253, sha 543ee2b53) | sports-period-9 | 1 |
| 37532539994 | re-run of the cut part (job 112505368627, sha 0920dbf5e) | sports-period-10 | 1 |
| 37532657110 | re-run of the cut part (job 112505753247, sha 0920dbf5e) | sports-period-11 | 1 |
| 37532673771 | re-run of the cut part (job 112505800301, sha 0920dbf5e) | sports-period-12 | 1 |
| 37583590932 | cut part, first run of the new cut (job 112668660780, sha 543ee2b53) | sports-period-13 | 1 |
| 37583597153 | cut part, first run of the new cut (job 112668671105, sha 543ee2b53) | sports-period-14 | 1 |
| 37532575325 | re-run of the cut part (job 112505476305, sha 0920dbf5e) | sports-nested-5 | 1 |
| 37532585435 | re-run of the cut part (job 112505627466, sha 0920dbf5e) | sports-nested-6 | 1 |
| 37532594187 | re-run of the cut part (job 112505539241, sha 0920dbf5e) | sports-nested-7 | 1 |
| 37532603444 | re-run of the cut part (job 112505576837, sha 0920dbf5e) | sports-nested-8 | 1 |

Summary of the report-source table (`report-sources.tsv`, one row per leg): 81 legs, 81 with a report: 62 whole legs from run 37371368951 (core-3 from its attempt 3), 19 cut parts each from its own run (16 at 0920dbf5e or 34ac56eb7, and the three period parts of the last cut, each from its own run at 543ee2b53). Every row names the run id, the artifact id, the leg's mutant count from the table and from the report, the `--check-selection` result (OK: every mutant is inside the leg's files and line ranges, none Pending) and Stryker's exit code (0 on every row).

Runs that produced NO report used by the floors (listed so nobody downloads them by mistake):

| run id | sha | leg | what happened |
|---|---|---|---|
| 37371368951 (attempts 1-3) | 78c7ef3e6 | sports-football-7, sports-period-1, sports-nested-5 | the first full run. Each hit its timeout (cancelled, no report, in attempts 2 and 3 alike); all three were cut into parts. Its other 66 legs completed; core-3 only in attempt 3 (its attempt-2 job never started). The old whole-leg reports of sports-cricket-9, sports-cricket-10, sports-period-2 and sports-period-9 are superseded by their parts (they are used in section 6 as the "before" side) |
| 37532612195 | 0920dbf5e | sports-cricket-9 | reused 173 of 173 results of the OLD cut's cache in 2 min 50 s, then the Survivors step refused the report (see section 9); no report |
| 37532630722 | 0920dbf5e | sports-cricket-10 | same: 97 of 99 reused, refused |
| 37532647507 | 0920dbf5e | sports-period-2 | same: 269 of 269 reused, refused |
| 37532665826 | 0920dbf5e | sports-period-9 | same: 228 of 228 reused, refused |
| 37539011809 | 34ac56eb7 | sports-period-9 (the 228-mutant part) | CANCELLED at its 216-minute timeout with 227 of 228 mutants tested (no report); re-cut into three parts |

## 3. Per leg

Columns: wall = the job's wall in minutes (job start to end); dry = the in-job dry run in seconds ("Initial test run succeeded ... in X"); timeout = the CI timeout
now in `stryker-timeouts.json` (minutes); score = the floor tool's formula, rounded DOWN to 1 dp (as a floor is). A part's wall and dry run are its own run's. "-" = not run yet.

| leg | family | mutants | killed | survived | NoCov | timed out | out of score | score % | wall min | dry s | CI timeout min | run id | artifact id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| competition-1 | competition | 407 | 363 | 41 | 3 | 0 | 0 | 89.1 | 45.5 | 152 | 69 | 37371368951 | 11374295578 |
| competition-2 | competition | 300 | 239 | 56 | 5 | 0 | 0 | 79.6 | 45.0 | 151 | 68 | 37371368951 | 11374051187 |
| competition-3 | competition | 306 | 268 | 31 | 2 | 5 | 0 | 89.2 | 3.6 | 117 | 10 | 37371368951 | 11371627801 |
| competition-4 | competition | 408 | 316 | 59 | 32 | 1 | 0 | 77.6 | 7.5 | 149 | 12 | 37371368951 | 11371353634 |
| competition-5 | competition | 383 | 259 | 91 | 32 | 1 | 0 | 67.8 | 66.4 | 152 | 100 | 37371368951 | 11375358143 |
| competition-6 | competition | 402 | 321 | 77 | 4 | 0 | 0 | 79.8 | 61.8 | 159 | 93 | 37371368951 | 11375312884 |
| competition-7 | competition | 350 | 220 | 115 | 2 | 13 | 0 | 66.5 | 39.5 | 148 | 60 | 37371368951 | 11372609533 |
| core-1 | core | 409 | 369 | 39 | 1 | 0 | 0 | 90.2 | 66.5 | 190 | 100 | 37371368951 | 11375068890 |
| core-2 | core | 403 | 353 | 50 | 0 | 0 | 0 | 87.5 | 61.4 | 133 | 93 | 37371368951 | 11375887161 |
| core-3 | core | 190 | 170 | 18 | 0 | 2 | 0 | 90.5 | 11.7 | 152 | 18 | 37371368951 | 11422305976 |
| modules-1 | modules | 405 | 259 | 121 | 25 | 0 | 0 | 63.9 | 1.2 | 2 | 10 | 37371368951 | 11372201174 |
| modules-2 | modules | 181 | 61 | 120 | 0 | 0 | 0 | 33.7 | 1.3 | 3 | 10 | 37371368951 | 11371891436 |
| modules-3 | modules | 373 | 191 | 79 | 103 | 0 | 0 | 51.2 | 1.0 | 2 | 10 | 37371368951 | 11372435174 |
| modules-4 | modules | 382 | 222 | 140 | 19 | 1 | 0 | 58.3 | 1.9 | 2 | 10 | 37371368951 | 11371447973 |
| modules-5 | modules | 364 | 258 | 85 | 19 | 0 | 2 | 71.2 | 49.0 | 176 | 74 | 37371368951 | 11375895241 |
| modules-6 | modules | 408 | 316 | 89 | 3 | 0 | 0 | 77.4 | 12.8 | 171 | 20 | 37371368951 | 11372457206 |
| modules-7 | modules | 410 | 349 | 52 | 8 | 1 | 0 | 85.3 | 6.4 | 120 | 10 | 37371368951 | 11371489210 |
| draws-1 | draws | 297 | 212 | 71 | 9 | 2 | 3 | 72.7 | 58.6 | 158 | 88 | 37371368951 | 11375902283 |
| draws-2 | draws | 381 | 248 | 100 | 28 | 5 | 0 | 66.4 | 1.3 | 2 | 10 | 37371368951 | 11372267297 |
| draws-3 | draws | 401 | 321 | 63 | 4 | 6 | 7 | 82.9 | 14.4 | 155 | 22 | 37371368951 | 11372309488 |
| draws-4 | draws | 407 | 237 | 137 | 9 | 22 | 2 | 63.9 | 95.7 | 87 | 144 | 37371368951 | 11379862348 |
| sports-cricket-1 | sports-cricket | 368 | 263 | 95 | 10 | 0 | 0 | 71.4 | 171.9 | 170 | 258 | 37371368951 | 11382986246 |
| sports-cricket-2 | sports-cricket | 384 | 328 | 51 | 5 | 0 | 0 | 85.4 | 105.4 | 196 | 159 | 37371368951 | 11379784877 |
| sports-cricket-3 | sports-cricket | 375 | 291 | 70 | 14 | 0 | 0 | 77.6 | 111.4 | 172 | 168 | 37371368951 | 11381590600 |
| sports-cricket-4 | sports-cricket | 345 | 261 | 67 | 17 | 0 | 0 | 75.6 | 92.8 | 191 | 140 | 37371368951 | 11381076257 |
| sports-cricket-5 | sports-cricket | 367 | 228 | 88 | 51 | 0 | 0 | 62.1 | 63.8 | 114 | 96 | 37371368951 | 11379942539 |
| sports-cricket-6 | sports-cricket | 350 | 211 | 132 | 6 | 1 | 0 | 60.5 | 117.2 | 96 | 176 | 37371368951 | 11381124767 |
| sports-cricket-7 | sports-cricket | 309 | 134 | 173 | 2 | 0 | 0 | 43.3 | 160.4 | 173 | 241 | 37371368951 | 11384002013 |
| sports-cricket-8 | sports-cricket | 383 | 313 | 66 | 4 | 0 | 0 | 81.7 | 94.5 | 125 | 142 | 37371368951 | 11381383256 |
| sports-cricket-9 | sports-cricket | 173 | 136 | 37 | 0 | 0 | 0 | 78.6 | 62.5 | 94 | 94 | 37538987509 | 11450396808 |
| sports-cricket-10 | sports-cricket | 99 | 49 | 50 | 0 | 0 | 0 | 49.4 | 107.2 | 165 | 161 | 37538997992 | 11452372231 |
| sports-cricket-11 | sports-cricket | 374 | 269 | 102 | 3 | 0 | 0 | 71.9 | 95.5 | 100 | 144 | 37371368951 | 11382166181 |
| sports-cricket-12 | sports-cricket | 384 | 242 | 139 | 1 | 2 | 0 | 63.5 | 170.5 | 104 | 256 | 37371368951 | 11386230332 |
| sports-cricket-13 | sports-cricket | 349 | 273 | 73 | 1 | 2 | 0 | 78.7 | 85.3 | 120 | 128 | 37371368951 | 11382813004 |
| sports-cricket-14 | sports-cricket | 406 | 323 | 65 | 18 | 0 | 0 | 79.5 | 92.1 | 169 | 139 | 37371368951 | 11383666166 |
| sports-cricket-15 | sports-cricket | 206 | 170 | 36 | 0 | 0 | 0 | 82.5 | 125.3 | 165 | 188 | 37532620624 | 11451066401 |
| sports-cricket-16 | sports-cricket | 248 | 175 | 54 | 19 | 0 | 0 | 70.5 | 111.0 | 179 | 167 | 37532639397 | 11449823630 |
| sports-football-1 | sports-football | 362 | 322 | 38 | 1 | 1 | 0 | 89.2 | 61.1 | 104 | 92 | 37371368951 | 11382328605 |
| sports-football-2 | sports-football | 393 | 288 | 77 | 28 | 0 | 0 | 73.2 | 123.5 | 169 | 186 | 37371368951 | 11385219899 |
| sports-football-3 | sports-football | 367 | 267 | 80 | 20 | 0 | 0 | 72.7 | 71.3 | 90 | 107 | 37371368951 | 11384016824 |
| sports-football-4 | sports-football | 379 | 301 | 69 | 9 | 0 | 0 | 79.4 | 102.3 | 171 | 154 | 37371368951 | 11384988662 |
| sports-football-5 | sports-football | 338 | 219 | 113 | 6 | 0 | 0 | 64.7 | 183.8 | 126 | 276 | 37371368951 | 11388041902 |
| sports-football-6 | sports-football | 388 | 301 | 79 | 8 | 0 | 0 | 77.5 | 114.3 | 167 | 172 | 37371368951 | 11386607769 |
| sports-football-7 | sports-football | 113 | 65 | 48 | 0 | 0 | 0 | 57.5 | 74.9 | 167 | 113 | 37532548091 | 11448069382 |
| sports-football-8 | sports-football | 129 | 36 | 90 | 2 | 1 | 0 | 28.6 | 115.0 | 170 | 173 | 37532557075 | 11449804239 |
| sports-football-9 | sports-football | 126 | 62 | 63 | 0 | 1 | 0 | 50.0 | 84.6 | 135 | 127 | 37532565988 | 11449126650 |
| sports-period-1 | sports-period | 192 | 54 | 138 | 0 | 0 | 0 | 28.1 | 111.0 | 130 | 167 | 37532530767 | 11450050911 |
| sports-period-2 | sports-period | 269 | 122 | 147 | 0 | 0 | 0 | 45.3 | 160.1 | 173 | 241 | 37539005165 | 11453422902 |
| sports-period-3 | sports-period | 387 | 310 | 73 | 2 | 2 | 0 | 80.6 | 110.8 | 150 | 167 | 37371368951 | 11387832610 |
| sports-period-4 | sports-period | 321 | 271 | 45 | 5 | 0 | 0 | 84.4 | 102.3 | 139 | 154 | 37371368951 | 11387503308 |
| sports-period-5 | sports-period | 280 | 204 | 65 | 11 | 0 | 0 | 72.8 | 89.1 | 132 | 134 | 37371368951 | 11388077210 |
| sports-period-6 | sports-period | 306 | 214 | 69 | 23 | 0 | 0 | 69.9 | 52.2 | 99 | 79 | 37371368951 | 11387393032 |
| sports-period-7 | sports-period | 307 | 205 | 96 | 6 | 0 | 0 | 66.7 | 175.9 | 128 | 264 | 37371368951 | 11391270707 |
| sports-period-8 | sports-period | 318 | 276 | 28 | 14 | 0 | 0 | 86.7 | 82.4 | 172 | 124 | 37371368951 | 11388816760 |
| sports-period-9 | sports-period | 72 | 40 | 31 | 0 | 1 | 0 | 56.9 | 37.4 | 178 | 57 | 37583585117 | 11466803215 |
| sports-period-10 | sports-period | 129 | 112 | 17 | 0 | 0 | 0 | 86.8 | 74.4 | 174 | 112 | 37532539994 | 11448835043 |
| sports-period-11 | sports-period | 119 | 97 | 22 | 0 | 0 | 0 | 81.5 | 64.0 | 172 | 96 | 37532657110 | 11447843699 |
| sports-period-12 | sports-period | 181 | 117 | 64 | 0 | 0 | 0 | 64.6 | 115.6 | 151 | 174 | 37532673771 | 11449824392 |
| sports-period-13 | sports-period | 98 | 54 | 38 | 0 | 6 | 0 | 61.2 | 110.6 | 179 | 166 | 37583590932 | 11470870760 |
| sports-period-14 | sports-period | 58 | 16 | 29 | 13 | 0 | 0 | 27.5 | 62.1 | 171 | 94 | 37583597153 | 11468335635 |
| sports-setbased-1 | sports-setbased | 304 | 205 | 93 | 5 | 1 | 0 | 67.7 | 116.0 | 102 | 174 | 37371368951 | 11390271697 |
| sports-setbased-2 | sports-setbased | 398 | 332 | 60 | 5 | 1 | 0 | 83.6 | 113.0 | 165 | 170 | 37371368951 | 11390848496 |
| sports-setbased-3 | sports-setbased | 394 | 306 | 69 | 19 | 0 | 0 | 77.6 | 63.8 | 168 | 96 | 37371368951 | 11388659793 |
| sports-setbased-4 | sports-setbased | 370 | 258 | 109 | 3 | 0 | 0 | 69.7 | 199.5 | 164 | 300 | 37371368951 | 11393897952 |
| sports-setbased-5 | sports-setbased | 351 | 243 | 100 | 8 | 0 | 0 | 69.2 | 127.8 | 175 | 192 | 37371368951 | 11392380242 |
| sports-setbased-6 | sports-setbased | 391 | 308 | 70 | 9 | 4 | 0 | 79.7 | 195.9 | 199 | 294 | 37371368951 | 11394124690 |
| sports-nested-1 | sports-nested | 242 | 215 | 25 | 2 | 0 | 0 | 88.8 | 48.1 | 94 | 73 | 37371368951 | 11390540692 |
| sports-nested-2 | sports-nested | 365 | 327 | 38 | 0 | 0 | 0 | 89.5 | 102.9 | 187 | 155 | 37371368951 | 11392737182 |
| sports-nested-3 | sports-nested | 364 | 262 | 79 | 23 | 0 | 0 | 71.9 | 90.7 | 99 | 137 | 37371368951 | 11392917758 |
| sports-nested-4 | sports-nested | 370 | 218 | 147 | 5 | 0 | 0 | 58.9 | 184.8 | 165 | 278 | 37371368951 | 11396048569 |
| sports-nested-5 | sports-nested | 90 | 66 | 18 | 6 | 0 | 0 | 73.3 | 37.8 | 132 | 57 | 37532575325 | 11446428943 |
| sports-nested-6 | sports-nested | 93 | 65 | 28 | 0 | 0 | 0 | 69.8 | 25.3 | 102 | 38 | 37532585435 | 11446970005 |
| sports-nested-7 | sports-nested | 96 | 57 | 35 | 4 | 0 | 0 | 59.3 | 89.8 | 173 | 135 | 37532594187 | 11448533031 |
| sports-nested-8 | sports-nested | 90 | 59 | 31 | 0 | 0 | 0 | 65.5 | 63.4 | 128 | 96 | 37532603444 | 11448371262 |
| sports-other-1 | sports-other | 362 | 298 | 64 | 0 | 0 | 0 | 82.3 | 136.1 | 168 | 205 | 37371368951 | 11395930104 |
| sports-other-2 | sports-other | 348 | 233 | 103 | 12 | 0 | 0 | 66.9 | 160.3 | 166 | 241 | 37371368951 | 11396158597 |
| sports-other-3 | sports-other | 383 | 318 | 58 | 7 | 0 | 0 | 83.0 | 84.8 | 137 | 128 | 37371368951 | 11394165834 |
| sports-other-4 | sports-other | 395 | 279 | 112 | 4 | 0 | 0 | 70.6 | 180.4 | 172 | 271 | 37371368951 | 11397997345 |
| sports-other-5 | sports-other | 407 | 287 | 110 | 10 | 0 | 0 | 70.5 | 198.7 | 169 | 299 | 37371368951 | 11400341188 |
| sports-other-6 | sports-other | 342 | 250 | 88 | 4 | 0 | 0 | 73.0 | 70.2 | 102 | 106 | 37371368951 | 11395411042 |
| sports-other-7 | sports-other | 354 | 249 | 81 | 24 | 0 | 0 | 70.3 | 144.9 | 165 | 218 | 37371368951 | 11399001289 |

## 4. The ten files with the most survivors, per family

Survivors here = Survived + NoCoverage (both count against the score). Files are the engine-relative paths in the reports.

### competition

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/competition/tiebreakers.ts | 197 | 191 | 6 | 503 | 13 | 713 |
| src/competition/progression.ts | 124 | 90 | 34 | 433 | 5 | 562 |
| src/competition/stage.ts | 123 | 91 | 32 | 259 | 1 | 383 |
| src/competition/points.ts | 61 | 56 | 5 | 239 | 0 | 300 |
| src/competition/display.ts | 34 | 31 | 3 | 89 | 0 | 123 |
| src/competition/round-role.ts | 6 | 6 | 0 | 138 | 0 | 144 |
| src/competition/tie-what-if.ts | 4 | 4 | 0 | 136 | 0 | 140 |
| src/competition/standings.ts | 1 | 1 | 0 | 38 | 0 | 39 |

All 8 files with a survivor are listed; the family has 550 survivors in 8 of its 9 files.

### core

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/core/lineup.ts | 42 | 41 | 1 | 381 | 0 | 423 |
| src/core/events.ts | 36 | 36 | 0 | 228 | 0 | 264 |
| src/core/time.ts | 14 | 14 | 0 | 85 | 0 | 99 |
| src/core/position.ts | 10 | 10 | 0 | 86 | 0 | 96 |
| src/core/types.ts | 3 | 3 | 0 | 51 | 0 | 54 |
| src/core/rng.ts | 2 | 2 | 0 | 11 | 2 | 15 |
| src/core/clock.ts | 1 | 1 | 0 | 10 | 0 | 11 |

All 7 files with a survivor are listed; the family has 108 survivors in 7 of its 8 files.

### modules

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/import/plan.ts | 156 | 134 | 22 | 308 | 0 | 464 |
| src/exports/build.ts | 146 | 121 | 25 | 259 | 0 | 405 |
| src/history/history.ts | 142 | 57 | 85 | 141 | 0 | 283 |
| src/officials/assign.ts | 135 | 116 | 19 | 217 | 1 | 353 |
| src/import/types.ts | 57 | 57 | 0 | 3 | 0 | 60 |
| src/stats/stats.ts | 48 | 40 | 8 | 288 | 1 | 337 |
| src/exports/types.ts | 46 | 46 | 0 | 13 | 0 | 59 |
| src/officials/source.ts | 40 | 22 | 18 | 50 | 0 | 90 |
| src/sport/module.ts | 29 | 29 | 0 | 138 | 0 | 169 |
| src/officials/types.ts | 18 | 18 | 0 | 5 | 0 | 23 |

The ten files hold 817 of the family's 863 survivors (95%); the family has 863 survivors in 14 of its 14 files.

### draws

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/scheduling/swiss.ts | 146 | 137 | 9 | 237 | 22 | 407 |
| src/scheduling/bracket-layout.ts | 121 | 93 | 28 | 236 | 2 | 359 |
| src/scheduling/bracket.ts | 67 | 63 | 4 | 321 | 6 | 401 |
| src/scheduling/roundrobin.ts | 33 | 30 | 3 | 98 | 0 | 134 |
| src/scheduling/americano.ts | 24 | 21 | 3 | 42 | 2 | 68 |
| src/scheduling/participants.ts | 23 | 20 | 3 | 72 | 0 | 95 |
| src/scheduling/feedgraph.ts | 7 | 7 | 0 | 12 | 3 | 22 |

All 7 files with a survivor are listed; the family has 421 survivors in 7 of its 7 files.

### sports-cricket

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/sports/cricket/cricket.ts | 1238 | 1108 | 130 | 3004 | 3 | 4245 |
| src/sports/cricket/scorecard.ts | 157 | 138 | 19 | 596 | 2 | 755 |
| src/sports/cricket/dls.ts | 54 | 52 | 2 | 66 | 0 | 120 |

All 3 files with a survivor are listed; the family has 1449 survivors in 3 of its 3 files.

### sports-football

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/sports/football/football.ts | 731 | 657 | 74 | 1861 | 3 | 2595 |

All 1 files with a survivor are listed; the family has 731 survivors in 1 of its 1 files.

### sports-period

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/sports/period/kernel.ts | 602 | 528 | 74 | 1556 | 8 | 2166 |
| src/sports/icehockey/icehockey.ts | 169 | 169 | 0 | 219 | 0 | 388 |
| src/sports/hockey/hockey.ts | 155 | 155 | 0 | 166 | 0 | 321 |
| src/sports/period/suspensions.ts | 9 | 9 | 0 | 90 | 0 | 99 |
| src/sports/period/shootout.ts | 1 | 1 | 0 | 61 | 1 | 63 |

All 5 files with a survivor are listed; the family has 936 survivors in 5 of its 5 files.

### sports-setbased

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/sports/setbased/kernel.ts | 435 | 391 | 44 | 1367 | 5 | 1807 |
| src/sports/setbased/volleyball.ts | 52 | 47 | 5 | 118 | 1 | 171 |
| src/sports/setbased/tabletennis.ts | 26 | 26 | 0 | 41 | 0 | 67 |
| src/sports/setbased/badminton.ts | 20 | 20 | 0 | 46 | 0 | 66 |
| src/sports/tennis/tennis.ts | 17 | 17 | 0 | 80 | 0 | 97 |

All 5 files with a survivor are listed; the family has 550 survivors in 5 of its 5 files.

### sports-nested

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/sports/nested/kernel.ts | 441 | 401 | 40 | 1269 | 0 | 1710 |

All 1 files with a survivor are listed; the family has 441 survivors in 1 of its 1 files.

### sports-other

| file | survivors | survived | NoCov | killed | timeout | file mutants |
|---|---|---|---|---|---|---|
| src/sports/carrom/carrom.ts | 270 | 254 | 16 | 745 | 0 | 1015 |
| src/sports/generic/generic.ts | 213 | 183 | 30 | 584 | 0 | 797 |
| src/sports/boardgame/boardgame.ts | 179 | 167 | 12 | 531 | 0 | 710 |
| src/sports/squad-state.ts | 13 | 12 | 1 | 53 | 0 | 66 |
| src/sports/index.ts | 2 | 0 | 2 | 1 | 0 | 3 |

All 5 files with a survivor are listed; the family has 677 survivors in 5 of its 5 files.

## 5. Dry-run comparison: Task 15 Step 4 estimate against the measured wall

Task 15 Step 4 sized each group from one local dry run: `est = ceil((max(dry, 344) + mutants x 10 / 3) / 60)` minutes (D14: a pessimistic 10 runner-seconds a mutant at concurrency 3,
and the 344 s CI dry run as a floor; the local dry run was 44 s so every group used 344). The first table is that Task 15 table (its 11 groups) against the family as it ran. "job-minutes" is
the sum of the legs' walls (what the family costs); "longest" is the slowest leg (what a family costs in time with all its legs parallel).

| group (Task 15) | T15 mutants | T15 est min (one job) | T15 timeout min | measured mutants | legs run / legs | job-minutes | longest leg min | job-minutes / T15 est | CI dry run s (min-max over the legs) |
|---|---|---|---|---|---|---|---|---|---|
| competition | 2556 | 148 | 222 | 2556 | 7 / 7 | 269 | 66.4 | 1.82x | 117-159 |
| core | 1002 | 62 | 93 | 1002 | 3 / 3 | 140 | 66.5 | 2.25x | 133-190 |
| modules | 2524 | 146 | 219 | 2523 | 7 / 7 | 74 | 49.0 | 0.50x | 2-176 |
| draws | 1486 | 89 | 134 | 1486 | 4 / 4 | 170 | 95.7 | 1.91x | 2-158 |
| sports-cricket (two groups: all but cricket.ts 875 + cricket.ts 4,248) | 5123 | 297 | 383 | 5120 | 16 / 16 | 1767 | 171.9 | 5.95x | 94-196 |
| sports-football | 2597 | 151 | 227 | 2595 | 9 / 9 | 931 | 183.8 | 6.16x | 90-171 |
| sports-period | 3040 | 175 | 263 | 3037 | 14 / 14 | 1348 | 175.9 | 7.70x | 99-179 |
| sports-setbased | 2210 | 129 | 194 | 2208 | 6 / 6 | 816 | 199.5 | 6.33x | 102-199 |
| sports-nested | 1713 | 101 | 152 | 1710 | 8 / 8 | 643 | 184.8 | 6.36x | 94-187 |
| sports-other | 2591 | 150 | 225 | 2591 | 7 / 7 | 975 | 198.7 | 6.50x | 102-172 |

The probe in Task 15 measured 26.0 runner-seconds a mutant locally; the hosted first run measured the phase (mutation, after the dry run) at 0.3 to 114 runner-seconds a mutant (phase seconds x 3 / mutants),
cost being set by how many mutants are static, not by the mutant count (section 8). Of the 81 legs that have run, 70 cost more than the D14 figure of 10 runner-seconds a mutant and 11 cost no more; the dearest is 197.

Per leg, for every leg that has run (the 62 whole legs of the first run and the parts that have run; est = the D14 formula on the leg's measured mutants, with the 344 s dry-run floor):

| leg | mutants | D14 est min | wall min | wall / est | dry s (CI) | phase s | runner-s per mutant |
|---|---|---|---|---|---|---|---|
| competition-1 | 407 | 29 | 45.5 | 1.57x | 152 | 2538 | 18.7 |
| competition-2 | 300 | 23 | 45.0 | 1.96x | 151 | 2522 | 25.2 |
| competition-3 | 306 | 23 | 3.6 | 0.16x | 117 | 70 | 0.7 |
| competition-4 | 408 | 29 | 7.5 | 0.26x | 149 | 264 | 1.9 |
| competition-5 | 383 | 28 | 66.4 | 2.37x | 152 | 3803 | 29.8 |
| competition-6 | 402 | 29 | 61.8 | 2.13x | 159 | 3518 | 26.3 |
| competition-7 | 350 | 26 | 39.5 | 1.52x | 148 | 2189 | 18.8 |
| core-1 | 409 | 29 | 66.5 | 2.29x | 190 | 3771 | 27.7 |
| core-2 | 403 | 29 | 61.4 | 2.12x | 133 | 3518 | 26.2 |
| core-3 | 190 | 17 | 11.7 | 0.69x | 152 | 514 | 8.1 |
| modules-1 | 405 | 29 | 1.2 | 0.04x | 2 | 41 | 0.3 |
| modules-2 | 181 | 16 | 1.3 | 0.08x | 3 | 41 | 0.7 |
| modules-3 | 373 | 27 | 1.0 | 0.04x | 2 | 33 | 0.3 |
| modules-4 | 382 | 27 | 1.9 | 0.07x | 2 | 80 | 0.6 |
| modules-5 | 364 | 26 | 49.0 | 1.88x | 176 | 2728 | 22.5 |
| modules-6 | 408 | 29 | 12.8 | 0.44x | 171 | 566 | 4.2 |
| modules-7 | 410 | 29 | 6.4 | 0.22x | 120 | 233 | 1.7 |
| draws-1 | 297 | 23 | 58.6 | 2.55x | 158 | 3328 | 33.6 |
| draws-2 | 381 | 27 | 1.3 | 0.05x | 2 | 40 | 0.3 |
| draws-3 | 401 | 29 | 14.4 | 0.50x | 155 | 675 | 5.0 |
| draws-4 | 407 | 29 | 95.7 | 3.30x | 87 | 5620 | 41.4 |
| sports-cricket-1 | 368 | 27 | 171.9 | 6.37x | 170 | 10112 | 82.4 |
| sports-cricket-2 | 384 | 28 | 105.4 | 3.76x | 196 | 6086 | 47.5 |
| sports-cricket-3 | 375 | 27 | 111.4 | 4.12x | 172 | 6480 | 51.8 |
| sports-cricket-4 | 345 | 25 | 92.8 | 3.71x | 191 | 5344 | 46.5 |
| sports-cricket-5 | 367 | 27 | 63.8 | 2.36x | 114 | 3683 | 30.1 |
| sports-cricket-6 | 350 | 26 | 117.2 | 4.51x | 96 | 6908 | 59.2 |
| sports-cricket-7 | 309 | 23 | 160.4 | 6.97x | 173 | 9413 | 91.4 |
| sports-cricket-8 | 383 | 28 | 94.5 | 3.38x | 125 | 5510 | 43.2 |
| sports-cricket-9 | 173 | 16 | 62.5 | 3.90x | 94 | 3627 | 62.9 |
| sports-cricket-10 | 99 | 12 | 107.2 | 8.93x | 165 | 6235 | 188.9 |
| sports-cricket-11 | 374 | 27 | 95.5 | 3.54x | 100 | 5603 | 44.9 |
| sports-cricket-12 | 384 | 28 | 170.5 | 6.09x | 104 | 10098 | 78.9 |
| sports-cricket-13 | 349 | 26 | 85.3 | 3.28x | 120 | 4970 | 42.7 |
| sports-cricket-14 | 406 | 29 | 92.1 | 3.17x | 169 | 5321 | 39.3 |
| sports-cricket-15 | 206 | 18 | 125.3 | 6.96x | 165 | 7321 | 106.6 |
| sports-cricket-16 | 248 | 20 | 111.0 | 5.55x | 179 | 6457 | 78.1 |
| sports-football-1 | 362 | 26 | 61.1 | 2.35x | 104 | 3538 | 29.3 |
| sports-football-2 | 393 | 28 | 123.5 | 4.41x | 169 | 7203 | 55.0 |
| sports-football-3 | 367 | 27 | 71.3 | 2.64x | 90 | 4161 | 34.0 |
| sports-football-4 | 379 | 27 | 102.3 | 3.79x | 171 | 5934 | 47.0 |
| sports-football-5 | 338 | 25 | 183.8 | 7.35x | 126 | 10868 | 96.5 |
| sports-football-6 | 388 | 28 | 114.3 | 4.08x | 167 | 6662 | 51.5 |
| sports-football-7 | 113 | 13 | 74.9 | 5.76x | 167 | 4305 | 114.3 |
| sports-football-8 | 129 | 13 | 115.0 | 8.84x | 170 | 6705 | 155.9 |
| sports-football-9 | 126 | 13 | 84.6 | 6.51x | 135 | 4913 | 117.0 |
| sports-period-1 | 192 | 17 | 111.0 | 6.53x | 130 | 6504 | 101.6 |
| sports-period-2 | 269 | 21 | 160.1 | 7.62x | 173 | 9404 | 104.9 |
| sports-period-3 | 387 | 28 | 110.8 | 3.96x | 150 | 6468 | 50.1 |
| sports-period-4 | 321 | 24 | 102.3 | 4.26x | 139 | 5964 | 55.7 |
| sports-period-5 | 280 | 22 | 89.1 | 4.05x | 132 | 5181 | 55.5 |
| sports-period-6 | 306 | 23 | 52.2 | 2.27x | 99 | 2998 | 29.4 |
| sports-period-7 | 307 | 23 | 175.9 | 7.65x | 128 | 10394 | 101.6 |
| sports-period-8 | 318 | 24 | 82.4 | 3.43x | 172 | 4745 | 44.8 |
| sports-period-9 | 72 | 10 | 37.4 | 3.74x | 178 | 2036 | 84.8 |
| sports-period-10 | 129 | 13 | 74.4 | 5.72x | 174 | 4255 | 99.0 |
| sports-period-11 | 119 | 13 | 64.0 | 4.92x | 172 | 3638 | 91.7 |
| sports-period-12 | 181 | 16 | 115.6 | 7.23x | 151 | 6758 | 112.0 |
| sports-period-13 | 98 | 12 | 110.6 | 9.21x | 179 | 6420 | 196.5 |
| sports-period-14 | 58 | 9 | 62.1 | 6.90x | 171 | 3521 | 182.1 |
| sports-setbased-1 | 304 | 23 | 116.0 | 5.04x | 102 | 6828 | 67.4 |
| sports-setbased-2 | 398 | 28 | 113.0 | 4.03x | 165 | 6580 | 49.6 |
| sports-setbased-3 | 394 | 28 | 63.8 | 2.28x | 168 | 3629 | 27.6 |
| sports-setbased-4 | 370 | 27 | 199.5 | 7.39x | 164 | 11774 | 95.5 |
| sports-setbased-5 | 351 | 26 | 127.8 | 4.92x | 175 | 7467 | 63.8 |
| sports-setbased-6 | 391 | 28 | 195.9 | 7.00x | 199 | 11519 | 88.4 |
| sports-nested-1 | 242 | 20 | 48.1 | 2.40x | 94 | 2758 | 34.2 |
| sports-nested-2 | 365 | 27 | 102.9 | 3.81x | 187 | 5952 | 48.9 |
| sports-nested-3 | 364 | 26 | 90.7 | 3.49x | 99 | 5318 | 43.8 |
| sports-nested-4 | 370 | 27 | 184.8 | 6.84x | 165 | 10893 | 88.3 |
| sports-nested-5 | 90 | 11 | 37.8 | 3.43x | 132 | 2102 | 70.1 |
| sports-nested-6 | 93 | 11 | 25.3 | 2.30x | 102 | 1389 | 44.8 |
| sports-nested-7 | 96 | 12 | 89.8 | 7.49x | 173 | 5190 | 162.2 |
| sports-nested-8 | 90 | 11 | 63.4 | 5.76x | 128 | 3644 | 121.5 |
| sports-other-1 | 362 | 26 | 136.1 | 5.23x | 168 | 7971 | 66.1 |
| sports-other-2 | 348 | 26 | 160.3 | 6.17x | 166 | 9427 | 81.3 |
| sports-other-3 | 383 | 28 | 84.8 | 3.03x | 137 | 4921 | 38.5 |
| sports-other-4 | 395 | 28 | 180.4 | 6.44x | 172 | 10620 | 80.7 |
| sports-other-5 | 407 | 29 | 198.7 | 6.85x | 169 | 11728 | 86.4 |
| sports-other-6 | 342 | 25 | 70.2 | 2.81x | 102 | 4085 | 35.8 |
| sports-other-7 | 354 | 26 | 144.9 | 5.57x | 165 | 8500 | 72.0 |

CI dry runs (each leg's own job): 81 legs, 2 to 199 s, median 152 s; 81 of them are under the 344 s the Task 15 formula assumed.

## 6. Part dry runs: measured against the dry run the part was timed with before

A part cut from a leg inherits no dry run: each part was first timed with the original leg's. Their own jobs' dry runs ("Initial test run succeeded ... in X"):

| part | original leg | original leg's dry s (first run, or the cancelled attempt) | the part's own dry s | change | the part's run |
|---|---|---|---|---|---|
| sports-cricket-9 | sports-cricket-9 | 165 | 94 | -43% | 37538987509 (job 112527140683, 34ac56eb7) |
| sports-cricket-15 | sports-cricket-9 | 165 | 165 | +0% | 37532620624 (job 112505632112, 0920dbf5e) |
| sports-cricket-10 | sports-cricket-10 | 170 | 165 | -3% | 37538997992 (job 112527184538, 34ac56eb7) |
| sports-cricket-16 | sports-cricket-10 | 170 | 179 | +5% | 37532639397 (job 112505671221, 0920dbf5e) |
| sports-period-2 | sports-period-2 | 167 | 173 | +4% | 37539005165 (job 112527241706, 34ac56eb7) |
| sports-period-11 | sports-period-2 | 167 | 172 | +3% | 37532657110 (job 112505753247, 0920dbf5e) |
| sports-period-9 | sports-period-9 | 145 | 178 | +23% | 37583585117 (job 112668631253, 543ee2b53) |
| sports-period-13 | sports-period-9 | 145 | 179 | +23% | 37583590932 (job 112668660780, 543ee2b53) |
| sports-period-14 | sports-period-9 | 145 | 171 | +18% | 37583597153 (job 112668671105, 543ee2b53) |
| sports-period-12 | sports-period-9 | 145 | 151 | +4% | 37532673771 (job 112505800301, 0920dbf5e) |
| sports-period-1 | sports-period-1 | 167 | 130 | -22% | 37532530767 (job 112505341469, 0920dbf5e) |
| sports-period-10 | sports-period-1 | 167 | 174 | +4% | 37532539994 (job 112505368627, 0920dbf5e) |
| sports-football-7 | sports-football-7 | 185 | 167 | -10% | 37532548091 (job 112505377568, 0920dbf5e) |
| sports-football-8 | sports-football-7 | 185 | 170 | -8% | 37532557075 (job 112505439220, 0920dbf5e) |
| sports-football-9 | sports-football-7 | 185 | 135 | -27% | 37532565988 (job 112505454296, 0920dbf5e) |
| sports-nested-5 | sports-nested-5 | 177 | 132 | -25% | 37532575325 (job 112505476305, 0920dbf5e) |
| sports-nested-6 | sports-nested-5 | 177 | 102 | -42% | 37532585435 (job 112505627466, 0920dbf5e) |
| sports-nested-7 | sports-nested-5 | 177 | 173 | -2% | 37532594187 (job 112505539241, 0920dbf5e) |
| sports-nested-8 | sports-nested-5 | 177 | 128 | -28% | 37532603444 (job 112505576837, 0920dbf5e) |
| sports-period-9 (the cancelled 228-mutant part) | sports-period-9 | 145 | 188 | +30% | 37539011809 (job 112527212464, 34ac56eb7) |

19 parts have run: their own dry runs differ from the original leg's by -43% to +23%, and the cancelled period-9 part's by +30%. A part's dry run is its own, so the figure the original leg recorded is not the part's. Every part is now timed from its own run, never from the leg it was cut from.

## 7. The 14 mutants no leg runs (unscored)

A cut inside a declaration (a member cut) cannot be loss-free: the node that contains the cut (the object literal or the function body) lies inside no part, and Stryker
drops a mutant whose node is in no range. Those are the container's own mutants ("replace the whole object with {}", "empty the whole body"). They are never scored: no leg runs them
and no report counts them, so no floor covers them. `stryker-unscored.json` names each (file, mutator, replacement, host declaration, line text, nth); a test holds it equal to what Stryker's
instrumenter finds. Line numbers are information only.

| # | file | line (info) | mutator | replacement | enclosing declaration |
|---|---|---|---|---|---|
| 1 | src/import/plan.ts | 46 | BlockStatement | `{}` | planImport |
| 2 | src/sports/cricket/cricket.ts | 3015 | BlockStatement | `{}` | padSpec |
| 3 | src/sports/cricket/cricket.ts | 3524 | ObjectLiteral | `{}` | cricket |
| 4 | src/sports/cricket/cricket.ts | 3989 | BlockStatement | `{}` | cricket |
| 5 | src/sports/football/football.ts | 2437 | ObjectLiteral | `{}` | football |
| 6 | src/sports/football/football.ts | 2823 | BlockStatement | `{}` | football |
| 7 | src/sports/nested/kernel.ts | 1982 | BlockStatement | `{}` | makeNestedModule |
| 8 | src/sports/nested/kernel.ts | 2052 | ObjectLiteral | `{}` | makeNestedModule |
| 9 | src/sports/nested/kernel.ts | 2252 | BlockStatement | `{}` | makeNestedModule |
| 10 | src/sports/period/kernel.ts | 1855 | BlockStatement | `{}` | makePeriodModule |
| 11 | src/sports/period/kernel.ts | 2434 | ObjectLiteral | `{}` | makePeriodModule |
| 12 | src/sports/period/kernel.ts | 2681 | BlockStatement | `{}` | makePeriodModule |
| 13 | src/sports/setbased/kernel.ts | 2149 | BlockStatement | `{}` | makeSetBasedModule |
| 14 | src/sports/setbased/kernel.ts | 2267 | ObjectLiteral | `{}` | makeSetBasedModule |

The legs hold 24828 mutants between them; with these 14 the instrumenter finds 24842 (0.06% of them unscored). Every family total above is the sum of its legs' reports.

## 8. Static mutants (Stryker's WARN) and `ignoreStatic`

Stryker prints `Detected N static mutants (X% of total) that are estimated to take Y% of the time running the tests!` for a leg whose static share is over its threshold. A static mutant is one
executed only while a file is loaded: Stryker must reload the whole environment to test it and run every test against it. The table is every leg that printed the WARN, from the leg's own job log
(the first run's log for an unchanged leg, the re-run's for a part).

| leg | static mutants | share of the leg's mutants | share of the test time Stryker estimates they take |
|---|---|---|---|
| sports-cricket-10 | 99 | 100% | 100% |
| sports-cricket-15 | 206 | 100% | 100% |
| sports-cricket-9 | 173 | 100% | 100% |
| sports-period-10 | 129 | 100% | 100% |
| sports-period-11 | 119 | 100% | 100% |
| sports-period-13 | 98 | 100% | 100% |
| sports-football-5 | 315 | 93% | 100% |
| sports-nested-7 | 88 | 92% | 99% |
| sports-nested-8 | 83 | 92% | 100% |
| sports-football-7 | 103 | 91% | 100% |
| sports-nested-2 | 327 | 90% | 100% |
| sports-period-12 | 161 | 89% | 100% |
| sports-cricket-12 | 337 | 88% | 100% |
| sports-football-1 | 317 | 88% | 100% |
| sports-period-4 | 281 | 88% | 99% |
| sports-period-7 | 269 | 88% | 100% |
| sports-period-8 | 280 | 88% | 100% |
| sports-setbased-2 | 348 | 87% | 98% |
| sports-cricket-11 | 320 | 86% | 99% |
| sports-period-3 | 331 | 86% | 99% |
| sports-cricket-16 | 212 | 85% | 100% |
| sports-cricket-2 | 322 | 84% | 99% |
| sports-cricket-1 | 306 | 83% | 100% |
| sports-nested-6 | 76 | 82% | 100% |
| sports-cricket-6 | 282 | 81% | 100% |
| sports-football-8 | 102 | 79% | 99% |
| sports-other-1 | 281 | 78% | 100% |
| sports-period-14 | 45 | 78% | 100% |
| sports-setbased-1 | 238 | 78% | 100% |
| sports-other-5 | 311 | 76% | 100% |
| sports-cricket-13 | 257 | 74% | 100% |
| sports-cricket-4 | 257 | 74% | 98% |
| sports-football-9 | 93 | 74% | 100% |
| sports-other-3 | 285 | 74% | 100% |
| sports-cricket-3 | 272 | 73% | 100% |
| sports-other-2 | 253 | 73% | 100% |
| sports-period-5 | 203 | 73% | 99% |
| sports-period-1 | 139 | 72% | 100% |
| sports-nested-1 | 171 | 71% | 100% |
| sports-football-2 | 270 | 69% | 100% |
| sports-other-4 | 270 | 68% | 100% |
| sports-period-2 | 183 | 68% | 100% |
| sports-football-3 | 245 | 67% | 100% |
| modules-2 | 120 | 66% | 100% |
| sports-setbased-6 | 259 | 66% | 99% |
| sports-football-6 | 251 | 65% | 99% |
| sports-setbased-4 | 241 | 65% | 100% |
| draws-1 | 191 | 64% | 90% |
| sports-nested-3 | 232 | 64% | 100% |
| sports-nested-5 | 58 | 64% | 100% |
| sports-other-7 | 226 | 64% | 100% |
| core-2 | 244 | 61% | 91% |
| sports-cricket-14 | 245 | 60% | 100% |
| sports-cricket-7 | 185 | 60% | 92% |
| sports-nested-4 | 221 | 60% | 100% |
| sports-period-9 | 43 | 60% | 91% |
| draws-4 | 241 | 59% | 99% |
| sports-cricket-8 | 218 | 57% | 100% |
| sports-cricket-5 | 207 | 56% | 100% |
| sports-setbased-5 | 185 | 53% | 100% |
| sports-other-6 | 176 | 51% | 100% |
| core-1 | 205 | 50% | 100% |
| sports-football-4 | 184 | 49% | 100% |
| competition-2 | 105 | 35% | 100% |
| sports-period-6 | 107 | 35% | 99% |
| core-3 | 53 | 28% | 98% |
| modules-5 | 99 | 27% | 100% |
| sports-setbased-3 | 96 | 24% | 100% |
| competition-6 | 87 | 22% | 53% |
| competition-1 | 69 | 17% | 100% |
| competition-7 | 60 | 17% | 75% |
| modules-6 | 11 | 3% | 95% |
| modules-7 | 13 | 3% | 84% |

WARN on 73 legs. No WARN (static share under Stryker's threshold): 8 legs: competition-3, competition-4, competition-5, modules-1, modules-3, modules-4, draws-2, draws-3.
Across the 73 WARN legs that have a report: 14089 static mutants of 21789 (65%).

**FYI for the owner: `ignoreStatic` is a lever, not a recommendation.** Stryker 10.0.0 has the option (`ignoreStatic`, default `false`; its schema text: "Ignore static mutants ... it might make sense
to ignore static mutants"), and `stryker.config.mjs` does not set it, so every figure in this file, and both the floors and the timeouts, INCLUDE the static mutants. In the table above they are most of the mutants in most sports legs and, by
Stryker's own estimate, nearly all of the test time. With the option on, Stryker skips them (it reports them as Ignored, which sits outside the score's denominator): the run would be cheaper by Stryker's own estimate, and the score would
stop saying anything about mutants in code that runs at module load. Every floor, every timeout and every cut in this file was measured with the static mutants in, so changing the option means re-measuring all three. This task changes nothing about it and does not recommend a change.

## 9. Incremental reuse, with the evidence

`mutation.yml` restores the leg's `*.incremental.json` and saves it again, so a re-run of an unchanged leg tests nothing it has already tested. The live proof came from the failed re-dispatch of the
four re-cut legs (run 37532612195, job 112505580391, sports-cricket-9, sha 0920dbf5e):

- the cache step restored `stryker-sports-cricket-9@78c7ef3e6...` (the old, wider cut's file; that key was the leg's NAME plus the sha, and the restore key was its prefix);
- Stryker: `Found 1 of 340 file(s) to be mutated using incremental report with 379 mutant(s), and 2091 test(s)`; `Result: 173 of 173 mutant result(s) are reused`; `MutationTestExecutor Done in 2 minutes and 50 seconds` (the
  same 173 mutants cost 62.5 minutes when run for real: section 3, sports-cricket-9);
- the Survivors step then refused the report: `the report is not group "sports-cricket-9"'s: it mutated src/sports/cricket/cricket.ts:3135 ... outside the group's files and line ranges`, exit 2.

The GOOD re-run of the same leg is a different run and ran cold: sports-cricket-9 at 34ac56eb7 (run 37538987509, job 112527140683) used the new key, which carries the cut fingerprint, found no cache to restore, logged `No incremental result file found at reports/mutation/sports-cricket-9.incremental.json, a full mutation testing run will be performed`, and tested all 173 mutants in 62.5 minutes. Its report is the one in section 3.

Reuse works (173/173 in about three minutes against about an hour); what it exposed was the cache key following the leg's name rather than its cut. The same happened on the other three:

| run | job | leg | mutants in the restored file | mutants in the leg | reused | outcome |
|---|---|---|---|---|---|---|
| 37532612195 | 112505580391 | sports-cricket-9 | 379 | 173 | 173 of 173 | refused by Survivors, exit 2 |
| 37532630722 | 112505663319 | sports-cricket-10 | 347 | 99 | 97 of 99 | refused by Survivors, exit 2 |
| 37532647507 | 112505701042 | sports-period-2 | 388 | 269 | 269 of 269 | refused by Survivors, exit 2 |
| 37532665826 | 112505771044 | sports-period-9 | 410 | 228 | 228 of 228 | refused by Survivors, exit 2 |

Fixed before any floor was set (commits 765d3efd4, dfbeff941): the incremental key now carries a 16-hex fingerprint of the leg's cut (its entries, its anchor lines and the files they resolve to) and is restored by prefix only,
and a file is saved only after `stryker-floor.ts --check-selection` accepts it, so a refused or poisoned report is never cached. Every one of the 20 jobs of the re-cut parts (19 that produced a report in this file, and the cancelled period-9 part) logged `No incremental result file found ... a full mutation testing run will be performed`:
every number in section 3 is a real execution, none is a reuse.

## 10. Measured spread: the same mutants run twice

The only mutants run twice are those of the four legs of the first run that were later cut and re-run in full (no cache reused, section 9). A mutant is identified by file, start and end position,
mutator and replacement; the "before" side is the first run's whole-leg report, the "after" side is the parts' reports in this file.

| before (first run, sha 78c7ef3e6) | mutants | after (re-run parts) | identical mutants found | same status | differ |
|---|---|---|---|---|---|
| sports-cricket-9 | 379 | sports-cricket-9 + sports-cricket-15 | 379 | 379 | 0 |
| sports-cricket-10 | 347 | sports-cricket-10 + sports-cricket-16 | 347 | 347 | 0 |
| sports-period-2 | 388 | sports-period-2 + sports-period-11 | 388 | 388 | 0 |
| sports-period-9 | 410 | sports-period-9 + sports-period-13 + sports-period-14 + sports-period-12 | 409 | 397 | 3 Killed -> Timeout, 1 Survived -> Timeout, 8 Timeout -> Killed |

1523 identical mutants were run twice (with the first run's whole leg and the re-run's parts both reporting them): 1511 kept their status and 12 changed.
The changes: 3 x Killed -> Timeout; 1 x Survived -> Timeout; 8 x Timeout -> Killed.
- sports-period-9: `src/sports/period/kernel.ts:2699:21` ArrowFunction -> `() => undefined`: Killed -> Timeout
- sports-period-13: `src/sports/period/kernel.ts:2728:24` EqualityOperator -> `rng() >= 0.12`: Survived -> Timeout
- sports-period-13: `src/sports/period/kernel.ts:2761:11` ConditionalExpression -> `true`: Killed -> Timeout
- sports-period-13: `src/sports/period/kernel.ts:2761:11` LogicalOperator -> `roll < 0.13 || state.cfg.suspensions !== null`: Killed -> Timeout
- sports-period-14: `src/sports/period/kernel.ts:2784:11` ConditionalExpression -> `true`: Timeout -> Killed
- sports-period-14: `src/sports/period/kernel.ts:2784:11` ConditionalExpression -> `true`: Timeout -> Killed
- sports-period-14: `src/sports/period/kernel.ts:2784:11` LogicalOperator -> `roll < 0.22 || cfgKinds.length > 0`: Timeout -> Killed
- sports-period-14: `src/sports/period/kernel.ts:2784:11` EqualityOperator -> `roll >= 0.22`: Timeout -> Killed
- sports-period-14: `src/sports/period/kernel.ts:2817:11` LogicalOperator -> `roll < 0.3 || shotTracking`: Timeout -> Killed
- sports-period-14: `src/sports/period/kernel.ts:2817:11` ConditionalExpression -> `true`: Timeout -> Killed
- sports-period-12: `src/sports/period/kernel.ts:2833:11` ConditionalExpression -> `true`: Timeout -> Killed
- sports-period-12: `src/sports/period/kernel.ts:2833:11` EqualityOperator -> `roll >= 0.33`: Timeout -> Killed

The first run's four whole legs held 11 Timeout mutants; 11 of them have been run again so far: 3 timed out again and 8 came back with another status. Timeout is the one status whose outcome depends on the runner's speed.
Of the 12 that changed, 11 stayed detected (3 x Killed -> Timeout, 8 x Timeout -> Killed), 1 went from undetected to detected, and 0 went from detected to undetected. Every status that changed is a change to or from Timeout (12 of 12), the one status whose outcome depends on the runner's speed: 4 mutants timed out on the re-run that had been decided before.
A change between two detected statuses leaves the score where it was; only a detected mutant turning undetected moves a family's score down (0 in 1523), and a mutant turning detected moves it up (1 in 1523: the floors are taken from the re-run, so that one is in them, and a later run that has it undetected again costs one mutant of the slack in section 1).

What a timed-out mutant could cost a floor (the families that have a floor; the numbers are section 1's):

| family | Timeout mutants | of the detected | detected mutants that must turn undetected to fall under the floor |
|---|---|---|---|
| competition | 20 | 2006 | 3 |
| core | 2 | 894 | 1 |
| modules | 2 | 1658 | 2 |
| draws | 35 | 1053 | 1 |
| sports-cricket | 5 | 3671 | 6 |
| sports-football | 3 | 1864 | 1 |
| sports-period | 9 | 2101 | 3 |
| sports-setbased | 6 | 1658 | 3 |
| sports-nested | 0 | 1269 | 1 |
| sports-other | 0 | 1914 | 2 |

So a re-run of an unchanged tree can only move a family under its floor through a mutant that was detected and is now not; none was seen to (section 10), and the statuses that did change are all to or from Timeout.

## 11. Timing history

1. **D14 (Task 15):** `est = ceil((max(dry, 344) + mutants x 10 / 3) / 60)`, 10 runner-seconds a mutant. The local probe measured 26.0 runner-seconds a mutant, 2.6x that; Task 15 recorded the gap and re-cut to 27 legs.
2. **T20-PRE: the "77 s/mutant" model.** A hosted run of the probe (run 37330725739: 134 mutants, mutation phase 3,400.6 s at concurrency 3 = 76.13 runner-seconds, pinned 77) priced a leg at 77 runner-seconds a
   mutant, so 454 mutants a leg for a 200-minute prediction: about 69 legs, 184 runner-hours. The 69 legs ran as the first full run (37371368951).
3. **The first run falsified it.** Measured rates (phase x 3 / mutants) ran from 0.3 to 114 runner-seconds a mutant: cost follows the STATIC mutants (each runs every test), not the mutant count. 66 legs finished;
   **three were cancelled at their timeout in both attempts** (sports-period-1 304 of 321 tested, sports-football-7 316 of 369, sports-nested-5 357 of 372) and so had no measurement; their pace
   (127, 230 and 204 runner-seconds a mutant, the dearer of the whole-phase average and the last hour) was the only figure to size their parts with. Four finished legs were over the 200-minute split line (sports-cricket-9 229 min,
   sports-cricket-10 217, sports-period-2 221, sports-period-9 263; a measured wall over 200 minutes times 1.5 would pass the 300 cap) and were cut too: 7 legs into 17 parts, 79 legs.
4. **Projected against measured, the 17 re-runs:** wall error (measured / projected) 0.23x to 1.16x on sixteen parts (the cancelled-leg pace was always over: 0.23x to 0.80x on nine; the
   report-share model 0.54x to 1.16x on seven) and **1.50x or more on the eighth: the 228-mutant period-9 part**, projected 144.8 minutes, cancelled at its 216-minute timeout (1.5 x the projection) with 227 of 228 mutants tested.
   Its last hour tested only 42 mutants (the static mutants run last), a pace of 258 runner-seconds a mutant against 169 for the whole phase. No cut of it into two parts fits the 175-minute line at that pace, so it was cut into three (72, 98 and 58 mutants): 81 legs.
5. **The three parts of that cut ran** (543ee2b53, runs 37583585117, 37583590932 and 37583597153, all successful): sports-period-9 37.4 min against 107.3 projected (0.35x), timeout 159 -> 57; sports-period-13 110.6 min against 144.6 projected (0.76x), timeout 215 -> 166; sports-period-14 62.1 min against 87.3 projected (0.71x), timeout 129 -> 94. The pace of the cancelled part was over again, on the safe side. Every one of the 81 legs is now timed from its own job's wall: no projection is left in the data, and a test holds that none is when a branch merges.
6. **The rule that follows: measured beats projected.** A leg that ran is timed ceil(1.5 x its measured wall) (10 to 300 minutes); a part is timed from its OWN run, never from the leg it was cut from; only a part with no run of its own is a projection (the pace of the
   cancelled part), and a projection is held to 175 minutes (`PROJECTED_LINE_MINUTES`) where a measurement is held to 200 (`SPLIT_LINE_MINUTES`), because the one projection that was tested missed by 1.5x. The cost model fitted on the first run's reports (about 25% error a leg) was deleted once every part had run.

## 12. What happens to the survivors

Survivors are killed by a test or recorded as equivalent in `stryker-equivalent.json` (by file:line:col mutator), by the wave that owns the file.

Each leg's job writes `SURVIVORS.md` next to its report (artifact `mutation-<leg>`), one `file:line:col mutator -> replacement` line per survivor and per uncovered mutant. The floors only rise: a wave that kills survivors raises its family's floor with
`pnpm mutation:floor --set-floor <family> <dir>`, and `ci.yml` refuses a lower one (`--check-file-against`).

