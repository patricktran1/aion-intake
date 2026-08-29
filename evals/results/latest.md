# AION Intake — Evaluation Report

Generated: 2026-08-29T22:49:04.864Z
Corpus: 289 cases · Passed: 289 · Failed: 0

## Quality scorecard

| Dimension | Score | Unit | Detail |
| --- | --- | --- | --- |
| pathway_routing_accuracy | 1 (=) | fraction correct | 242/242 routed to the expected pathway |
| routing_robustness_typos | 0.8 (=) | fraction (informational — model layer's job) | 32/40 typo-mangled openers still routed correctly deterministically |
| mean_questions | 6.94 (▲0.01) | questions (budget 9) | mean questions asked across 289 completed intakes |
| redundant_question_rate | 0 (=) | fraction of post-opener questions | 0/1716 questions re-asked a slot the opener already settled (lower is better) |
| hpi_guard_clean_rate | 1 (=) | fraction with zero guard violations | 289/289 HPIs contain no invented claims |
| unsupported_numeric_claim_rate | 0 (=) | fraction (MUST be 0) | 0/289 HPIs contain a date or measurement the patient never gave |
| completion_robustness | 1 (=) | fraction that never crashed (MUST be 1.0) | 289/289 cases completed without throwing |
| clarify_cap_adherence | 1 (=) | fraction within the cap (MUST be 1.0) | 289/289 clarify lists stayed short enough to read |
| case_pass_rate | 1 (=) | fraction passing all assertions | 289/289 cases passed every semantic assertion |

## Where scores are dragged down

**routing_robustness_typos** — gen-acne-typos-partial-2, gen-acne-typos-full-32, gen-acne-typos-partial-62, gen-acne-typos-full-92, gen-acne-typos-partial-122, gen-acne-typos-full-152, gen-acne-typos-partial-182, gen-acne-typos-full-212
