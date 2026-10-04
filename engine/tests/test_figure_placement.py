"""Placement plans may insert known links, never replace guide prose or assessments."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))

import agy_writer
import figure_placement
from phase_validation import SECTION_HEADINGS

FIGURE = {'page': 2, 'markdown': '![slide](<./Figures/Deck/page-002.png>)',
          'slide_text': "[Machine-read slide OCR; not doctor's words]\nExophthalmos and thyroid hormone"}


def test_placement_uses_bounded_guide_windows_preserves_all_prose_and_existing_links(monkeypatch):
    separator = '\nPART_SEPARATOR\n'
    guide = SECTION_HEADINGS[0] + '\n\nThe doctor described exophthalmos.\n\n'
    questions = '\n\n' + SECTION_HEADINGS[1] + '\nExophthalmos assessment text.\n'
    original = guide + separator + 'Another spoken paragraph.\n' + questions
    prompts = []
    def plan(prompt, schema, **_):
        prompts.append(prompt)
        assert 'assessment text' not in prompt
        assert 'Machine-read' in prompt
        return {'placements': [{'page': 2, 'after_paragraph': 1}]}
    monkeypatch.setattr(agy_writer, 'request_json', plan)
    result = figure_placement.place_missing_figures(original, separator, [FIGURE])
    inserted = '\n\n' + FIGURE['markdown'] + '\n'
    assert result.replace(inserted, '', 1) == original
    assert result.index('page-002.png') < result.index(separator)
    assert len(prompts) == 1
    assert figure_placement.place_missing_figures(result, separator, [FIGURE]) == result
    assert len(prompts) == 1


@pytest.mark.parametrize('entry', [
    {'page': 99, 'after_paragraph': 1}, {'page': 2, 'after_paragraph': 0},
    {'page': 2, 'after_paragraph': 100}, {'page': True, 'after_paragraph': 1},
    {'page': 2, 'after_paragraph': 1, 'replacement_text': 'invented narration'},
])
def test_invalid_model_placements_are_refused_without_rewriting(entry, monkeypatch):
    original = SECTION_HEADINGS[0] + '\n\nSpoken explanation.\n\n' + SECTION_HEADINGS[1]
    monkeypatch.setattr(agy_writer, 'request_json', lambda *_args, **_kwargs: {'placements': [entry]})
    with pytest.raises(figure_placement.FigurePlacementError):
        figure_placement.place_missing_figures(original, '', [FIGURE])


def test_placement_call_cap_leaves_unmatched_figures_for_review_findings(monkeypatch):
    monkeypatch.setattr(figure_placement, 'MAX_REQUESTS', 2)
    monkeypatch.setattr(figure_placement, 'MAX_PARAGRAPH_BYTES', 20)
    prompts = []
    def plan(prompt, *_args, **_kwargs):
        prompts.append(prompt)
        return {'placements': []}
    monkeypatch.setattr(agy_writer, 'request_json', plan)
    original = SECTION_HEADINGS[0] + '\n\n' + '\n\n'.join('spoken paragraph' for _ in range(10)) + '\n\n' + SECTION_HEADINGS[1]
    assert figure_placement.place_missing_figures(original, '', [FIGURE]) == original
    assert len(prompts) == 2
    assert all(len(json.loads(prompt.split('\n', 1)[1])['paragraphs']) == 1 for prompt in prompts)


def test_retained_assessment_parts_after_the_guide_never_enter_placement_requests(monkeypatch):
    separator = '\nPART_SEPARATOR\n'
    original = separator.join([
        SECTION_HEADINGS[0] + '\n\nA spoken explanation.\n',
        SECTION_HEADINGS[1] + '\n\nSupporting points.\n',
        SECTION_HEADINGS[2] + '\n\nExophthalmos assessment text.\n',
        SECTION_HEADINGS[3] + '\n\n' + 'More assessment text. ' * 50 + '\n',
    ])
    paragraphs = []
    def plan(prompt, *_args, **_kwargs):
        paragraphs.extend(row['text'] for row in json.loads(prompt.split('\n', 1)[1])['paragraphs'])
        return {'placements': []}
    monkeypatch.setattr(agy_writer, 'request_json', plan)
    assert figure_placement.place_missing_figures(original, separator, [FIGURE]) == original
    assert paragraphs == ['A spoken explanation.']
