# Agent Note: Topic-aware lecture question ranking

Status: implemented

English | [中文](2026-10-11-topic-aware-lecture-questions.zh.md)

## Problem

A live transcript of the toxicology lecture "Salycylates" (13 papers, 510 indexed questions) carried 29 bank questions but no `[Past Exams - YEAR]` badge, although two dated aspirin questions existed ("Cause of death in aspirin…" 2022, "As regarding aspirin toxicity" 2025). Ranking read only stems, so questions whose content sits in options scored nothing; the misspelled title matched no question; evidence weights of count divided by document frequency favoured incidental words such as "increase" that appear in two questions; and dated questions about cathartics, carbon monoxide and corrosives filled the 50 entries.

## Decision

`ranked_questions` treats the lecture's evidence as a query. A question word scores `(1 + log(lecture count)) × log(1 + bank size / question frequency)`; words the lecture mentions once score nothing, and option words count half. The score is divided by the square root of the question length. Question text is the stem, options and paper-verified printed answers.

A question qualifies only when its stem matches the lecture's evidence, or the lecture title or assigned material names match it anywhere. Title matching tolerates case, diacritics, y/i, doubled letters and one spelling edit (two from nine letters). Explicit search terms add score, and qualify questions only for untitled lectures.

Generic words come from the module's own data: words in at least half of the module's defined lectures (`_find_questions` passes the other lectures' evidence) and words in more than 15% of the bank. A common title word is dropped when the title has a distinctive word ("poisoning" in "Food poisoning") and kept when the whole title is common ("Corrosives" in a corrosives-only bank).

A verified exam year multiplies the score by 1.5 instead of taking absolute priority.

## Alternatives considered

**Hardcoded synonym and generic-word lists.** A toxicology list (aspirin ⇄ salicylate, "gastric lavage", "coma") fixes one module and fails cardiology, pediatrics and every other subject; repository rules also forbid hardcoded deployment-varying lists.

**Co-occurrence synonym discovery in the bank.** In the measured bank, aspirin questions rarely say "salicylate", so co-occurrence produced noise ("parents", "like") instead of the link.

**Dated questions first.** Absolute priority returned every dated question that shared generic vocabulary before any on-topic bank question.

**Stem-only gate without option weighting.** Options alone (shared complications and management) placed other poisons' questions in the lecture; weighting options at half and requiring a stem or title match removed them in the synthetic regression.

## Consequences

Measured on the toxo test library with the regex-judged share of on-topic entries in the top 50: Salycylates 27 → 39, Addiction 28 → 31; Corrosive returns 6 dated corrosive questions; Food poisoning returns its 3 food-poisoning questions instead of every "poisoning" question. "As regarding aspirin toxicity" (2025) now reaches the Salycylates list; "Cause of death in aspirin" still ranks outside the top 50 because its options are generic. The transcript writer still selects among the returned entries. When other lectures have no evidence yet, the lecture-based generic test has nothing to compare and only the bank-frequency test applies.

## Verification

Synthetic regressions cover a realistic mixed bank where the two dated aspirin questions rank first and off-topic dated questions are excluded, a generic "Animal poisoning" title, options and printed answers supplying title hits, an all-common title, explicit search terms, the 50-entry cap with long stems, and slide-only evidence. Engine unittest discovery passes 843 tests.
