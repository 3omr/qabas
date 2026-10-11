"""Rank complete indexed questions against the lecture's local evidence.

The lecture's evidence (slides, verbatim text, material text) acts as a query:
each question word scores its lecture frequency (sublinear) times its rarity in
the module's question bank, normalized by sqrt(question length). The lecture
title and material names match with small spelling tolerance and add a title
weight. Words present in at least half of the module's lectures are generic and
score nothing. A verified exam year multiplies the score by DATED_BONUS instead
of taking absolute priority, so an off-topic dated question cannot displace
on-topic ones. Question text is the stem, options and printed answers.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Iterable
from functools import lru_cache
from math import log, sqrt
from typing import Any

from exam_years import extract_exam_years

MAX_QUESTIONS = 50
COMMON_TERM_RATIO = 0.15
# Share of the module's lectures above which a word is generic for that module.
GENERIC_LECTURE_RATIO = 0.5
DATED_BONUS = 1.5
TITLE_WEIGHT = 3.0
OPTION_WEIGHT = 0.5
# Score is stored as an integer; this keeps fractional weights distinguishable.
SCORE_SCALE = 10
STOP_WORDS = frozenset(
    [
        "a",
        "about",
        "above",
        "after",
        "again",
        "all",
        "also",
        "an",
        "and",
        "any",
        "are",
        "as",
        "at",
        "be",
        "because",
        "been",
        "before",
        "being",
        "below",
        "between",
        "both",
        "by",
        "can",
        "cause",
        "causes",
        "clinical",
        "could",
        "did",
        "do",
        "doctor",
        "does",
        "done",
        "down",
        "during",
        "each",
        "else",
        "few",
        "following",
        "for",
        "from",
        "further",
        "had",
        "has",
        "have",
        "having",
        "he",
        "her",
        "here",
        "his",
        "how",
        "if",
        "important",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "lecture",
        "may",
        "medical",
        "might",
        "more",
        "most",
        "must",
        "no",
        "nor",
        "not",
        "now",
        "of",
        "off",
        "on",
        "once",
        "only",
        "or",
        "other",
        "our",
        "out",
        "over",
        "own",
        "patient",
        "patients",
        "per",
        "question",
        "same",
        "shall",
        "she",
        "should",
        "so",
        "some",
        "such",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "through",
        "to",
        "too",
        "treatment",
        "treatments",
        "under",
        "until",
        "up",
        "very",
        "via",
        "vs",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
        "الحالة",
        "الدكتور",
        "العلاج",
        "المحاضرة",
        "شرح",
        "عشان",
        "عندنا",
        "كده",
        "لازم",
        "ممكن",
        "يعني",
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


def _topic_spelling(word: str) -> str:
    decomposed = unicodedata.normalize("NFKD", word).casefold()
    plain = "".join(letter for letter in decomposed if not unicodedata.combining(letter))
    return re.sub(r"(.)\1+", r"\1", plain.replace("y", "i"))


@lru_cache(maxsize=4096)
def _topic_match(left: str, right: str) -> bool:
    """Allow one spelling edit for 6-8 normalized letters and two from 9 letters."""
    left, right = _topic_spelling(left), _topic_spelling(right)
    if left == right:
        return True
    shorter = min(len(left), len(right))
    allowed = 2 if shorter >= 9 else 1
    if shorter < 6 or abs(len(left) - len(right)) > allowed:
        return False
    previous = list(range(len(right) + 1))
    for row, letter in enumerate(left, 1):
        current = [row]
        for column, other in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[column] + 1,
                               previous[column - 1] + (letter != other)))
        if min(current) > allowed:
            return False
        previous = current
    return previous[-1] <= allowed


def _generic_terms(texts: list[str], other_lectures: list[list[str]]) -> set[str]:
    """Words present in at least GENERIC_LECTURE_RATIO of the module's lectures."""
    lectures = [_tokens(" ".join(texts)), *(_tokens(" ".join(other)) for other in other_lectures)]
    if len(lectures) < 3:
        return set()
    counts = Counter(word for words in lectures for word in words)
    return {word for word, count in counts.items() if count >= len(lectures) * GENERIC_LECTURE_RATIO}


def _topic_terms(title: str, vocabulary: set[str], generic: set[str]) -> set[str]:
    anchors = _tokens(title) - generic
    return {word for word in vocabulary - generic if any(_topic_match(word, anchor) for anchor in anchors)}


def _question_text(question: dict[str, Any]) -> str:
    """Use full question wording and paper-verified printed answers, never explanations."""
    answers = [occurrence.get("answer_text") or occurrence.get("source_answer") or ""
               for occurrence in question.get("occurrences", [])
               if occurrence.get("answer_status") == "printed"]
    return " ".join([question["stem"], *question.get("options", {}).values(), *answers])


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
    index: dict[str, Any], title: str, texts: Iterable[str], terms: list[str],
    other_lectures: Iterable[Iterable[str]] = (),
) -> list[dict[str, Any]]:
    """Rank questions for one lecture; ``other_lectures`` holds the evidence texts of the module's other lectures."""
    texts = list(texts)
    others = [list(other) for other in other_lectures]
    question_words = {key: _tokens(_question_text(question)) - STOP_WORDS
                      for key, question in index["questions"].items()}
    frequencies = Counter(word for words in question_words.values() for word in words)
    total = max(1, len(question_words))
    rarity = {word: log(1 + total / count) for word, count in frequencies.items()}
    # Words in more than COMMON_TERM_RATIO of the bank (at least three) are generic
    # for this module too; tiny test banks keep their few words.
    common_terms = {word for word, count in frequencies.items()
                    if count >= 3 and count > total * COMMON_TERM_RATIO}
    generic = _generic_terms(texts, others) | common_terms
    title_terms = _topic_terms(title, set(frequencies), generic | STOP_WORDS)
    # A common title word ("poisoning" in "Food poisoning") is dropped when the title
    # has a distinctive word; a title made only of common words still names the topic.
    lecture_generic = _generic_terms(texts, others)
    title_words = _tokens(title) - STOP_WORDS - lecture_generic
    if not title_terms and title_words and all(
            any(_topic_match(word, term) for term in common_terms) for word in title_words):
        title_terms = _topic_terms(title, set(frequencies), lecture_generic | STOP_WORDS)
    supplied_terms = _tokens(" ".join(terms)) - STOP_WORDS - generic
    lecture_counts = Counter(word for text in texts for word in _words(text)
                             if word in frequencies and word not in STOP_WORDS and word not in generic)
    # A word the lecture mentions once is incidental; repeated words carry its topic.
    evidence = {word: (1 + log(count)) * rarity[word] for word, count in lecture_counts.items() if count >= 2}
    ranked: list[dict[str, Any]] = []
    for key, question in index["questions"].items():
        words = question_words[key]
        stem_words = _tokens(question["stem"]) - STOP_WORDS
        title_hits = words & title_terms
        supplied_hits = words & supplied_terms
        stem_evidence = (stem_words & set(evidence)) - title_hits - supplied_hits
        option_evidence = (words & set(evidence)) - stem_evidence - title_hits - supplied_hits
        # The stem says what a question is about; options alone (shared management
        # or complications) cannot place another poison's question in this lecture.
        # Explicit searches supplement untitled topics, but cannot override a named lecture.
        if not (title_hits or stem_evidence or (supplied_hits and not title_terms)):
            continue
        score = (sum(TITLE_WEIGHT * rarity[word] for word in title_hits | supplied_hits)
                 + sum(evidence[word] for word in stem_evidence)
                 + OPTION_WEIGHT * sum(evidence[word] for word in option_evidence)) / sqrt(max(4, len(words)))
        ranked.append(_allowed_entry(key, question, round(SCORE_SCALE * score)))
    # A verified exam year earns a bonus, not absolute priority: an on-topic bank
    # question still outranks a dated question that only shares generic words.
    return sorted(ranked, key=lambda entry: (-entry["score"] * (DATED_BONUS if entry["years"] else 1), entry["id"]))
