"""Rank complete indexed questions against the lecture's local evidence.

Terms in >15% of questions (at least three) earn only one title/search point
and no evidence points. Other evidence terms weigh lecture occurrences divided
by question document frequency, normalized by sqrt(question token count), so
long OCR passages cannot win just by accumulating incidental matches.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Iterable
from math import sqrt
from typing import Any

from exam_years import extract_exam_years

MAX_QUESTIONS = 50
COMMON_TERM_RATIO = 0.15
STOP_WORDS = frozenset(
    [
        "about",
        "after",
        "also",
        "before",
        "cause",
        "causes",
        "clinical",
        "doctor",
        "during",
        "following",
        "from",
        "have",
        "important",
        "lecture",
        "medical",
        "most",
        "patient",
        "patients",
        "question",
        "should",
        "that",
        "their",
        "them",
        "there",
        "these",
        "they",
        "this",
        "treatment",
        "treatments",
        "what",
        "when",
        "which",
        "with",
        "would",
        "شرح",
        "الدكتور",
        "المحاضرة",
        "العلاج",
        "الحالة",
        "يعني",
        "عشان",
        "كده",
        "عندنا",
        "لازم",
        "ممكن",
    ]
)


def _words(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return [
        word
        for word in re.findall(r"[^\W\d_]+", normalized)
        if len(word) >= 3 and word not in STOP_WORDS
    ]


def _tokens(text: str) -> set[str]:
    return set(_words(text))


def _evidence_terms(texts: Iterable[str], frequencies: Counter[str], common_terms: set[str]) -> dict[str, float]:
    counts: Counter[str] = Counter()
    for text in texts:
        counts.update(word for word in _words(text) if word in frequencies and word not in common_terms)
    weights = {word: count / frequencies[word] for word, count in counts.items()}
    return {word: weights[word] for word in sorted(weights, key=lambda word: (-weights[word], word))[:100]}


def _allowed_entry(key: str, question: dict[str, Any], score: int) -> dict[str, Any]:
    # Only the index's years can become badges; query terms never supply provenance.
    years = list(
        extract_exam_years(" ".join(str(year) for year in question.get("years", [])))
    )
    badges = [f"**[Past Exams - {year}]**" for year in years] or ["**[Question Bank]**"]
    return {
        **question,
        "id": key,
        "score": score,
        "years": years,
        "source": question.get("sources", []),
        "source_papers": [
            {**occurrence, "path": f"Questions/{occurrence['source']}"}
            for occurrence in question.get("occurrences", [])
        ],
        "source_lines": [f"**Source:** Questions/{name}" for name in question.get("sources", [])],
        "badges": badges,
        "badge": " ".join(badges),
    }


def ranked_questions(
    index: dict[str, Any], title: str, texts: Iterable[str], terms: list[str]
) -> list[dict[str, Any]]:
    question_words = {key: _tokens(question["stem"] + " " + " ".join(question.get("options", {}).values()))
                      for key, question in index["questions"].items()}
    frequencies = Counter(word for words in question_words.values() for word in words)
    # Common title/search words still match at one point; common evidence cannot
    # flood the shortlist. Three occurrences avoid penalizing tiny test banks.
    common_terms = {word for word, count in frequencies.items()
                    if count >= 3 and count > len(question_words) * COMMON_TERM_RATIO}
    title_terms = _tokens(title)
    supplied_terms = _tokens(" ".join(terms))
    evidence_weights = _evidence_terms(texts, frequencies, common_terms)
    evidence_terms = set(evidence_weights) - title_terms - supplied_terms
    ranked: list[dict[str, Any]] = []
    for key, question in index["questions"].items():
        words = question_words[key]
        title_hits = len(words & title_terms)
        supplied_hits = len(words & supplied_terms)
        evidence_hits = len(words & evidence_terms)
        strong_evidence = any(evidence_weights[word] >= 1 for word in words & evidence_terms)
        if title_hits or supplied_hits or evidence_hits >= 2 or strong_evidence:
            ranked.append(
                _allowed_entry(
                    key,
                    question,
                    sum(1 if word in common_terms else 10 for word in words & title_terms)
                    + sum(1 if word in common_terms else 6 for word in words & supplied_terms)
                    + round(10 * sum(evidence_weights[word] for word in words & evidence_terms) / sqrt(max(1, len(words)))),
                )
            )
    return sorted(ranked, key=lambda entry: (-entry["score"], entry["id"]))
