"""2026-10-04 finish-always regressions use synthetic slides and exam papers."""

import base64
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))

import mcp_server
from exam_index import build_index, write_index
from phase_validation import _correct_answer_errors, _option_shape_errors
from question_provenance import (
    assessment_catalog,
    final_provenance_errors,
    repair_provenance_badges,
)
from slide_figures import (
    Figure,
    FigureSet,
    selection_options,
    source_fingerprint,
    write_manifest,
)
from test_figure_cache import deck as synthetic_deck
from test_lecture_pipeline import execute
from test_lecture_pipeline import fake_agy as fake_agy
from test_lecture_pipeline import lecture as lecture
from test_lecture_pipeline import pipeline as pipeline
from transcript_parser import parse_transcript


@pytest.mark.parametrize("closing_raster", [True, False])
def test_picture_only_content_survives_old_omission_and_writer_that_links_nothing(pipeline, fake_agy, closing_raster):
    workspace, root, _ = pipeline
    deck = root / 'Lecture/Clinical Slides.pptx'
    synthetic_deck(deck, True, page_count=4)
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
    metadata = root / 'module.json'
    metadata.write_text(json.dumps({**json.loads(metadata.read_text()), 'lecture_slides': {'Corrosives': 'Lecture/Clinical Slides.pptx'}}))
    directory = root / 'Transcripts/Figures/Corrosives'
    directory.mkdir(parents=True)
    readings = ['Corrosives cause burns', 'Explain clinical treatment fully', 'Thank You']
    figures = []
    for page, reading in enumerate(readings, 2):
        image = directory / f'page-{page:03d}.png'
        image.write_bytes(png)
        figures.append(Figure(page, image, 0, 1, {'text': reading, 'method': 'ocr', 'image_sha256': hashlib.sha256(png).hexdigest()}))
    write_manifest(FigureSet('Corrosives', deck.name, directory, tuple(figures), 4, 1,
                            source_fingerprint=source_fingerprint(deck), selection_inputs={**selection_options(), 'page_texts': ['Corrosives', '', '', ''], 'page_image_counts': [0, 1, 1, 1]}))
    if not closing_raster:
        (directory / 'page-004.png').unlink()
    manifest = root / '.transcriber-cache/test-manifest.json'
    payload = json.loads(manifest.read_text())
    payload['pipeline_omissions'] = {'figures': 'Optional figures could not be validated'}
    manifest.write_text(json.dumps(payload))
    context = mcp_server._resolve_draft_context({'module': 'toxo', 'manifest_path': str(manifest)}, workspace)
    assert context.slides_path == deck
    cached = mcp_server._cached_figures(context)
    assert [figure['page'] for figure in cached['figures']] == [2, 3]
    job = mcp_server.AgyDraftContext(context, 'Toxicology', ['Spoken segment', 'Next segment'], [], {}, workspace)
    prompt = mcp_server._agy_part_prompt(job, 1)
    received = json.loads(prompt.split('Reported figures (link only where this segment discusses them):\n', 1)[1].split('\n\nFigure placement:', 1)[0])
    assert [figure['page'] for figure in received] == [2, 3]
    assert all('Machine-read' in figure['slide_text'] for figure in received)
    result = execute(pipeline)
    assert result['status'] == 'finalized', result
    saved = Path(result['paths']['transcript']).read_text()
    assert saved.count('page-002.png') == saved.count('page-003.png') == 1
    assert 'page-001.png' not in saved and 'page-004.png' not in saved
    assert saved.index('page-003.png') < saved.index('## 🌟 IMP Points')
    assert not any('SLIDE FIGURE PLACEMENT' in json.loads(line)['prompt'] for line in fake_agy.read_text().splitlines())


@pytest.mark.parametrize('count', range(2, 7))
def test_sourced_option_count_survives_index_parser_and_validation(tmp_path, count):
    root = tmp_path / 'module'
    questions = root / 'Questions'
    questions.mkdir(parents=True)
    options = '\n'.join(f'{letter}. Choice {letter}' for letter in 'abcdef'[:count])
    paper = questions / 'Formative_2024.txt'
    paper.write_text('1. Which clinical finding identifies a synthetic disorder?\n' + options)
    write_index(build_index(questions, 'synthetic'), questions)
    block = ('### MCQ 1 **[Past Exams - 2024]**\n**Question:** Which clinical finding identifies a synthetic disorder?\n'
             + '**Options:**\n' + options + f'\n**Correct Answer:** {"abcdef"[count - 1]}. Choice {"abcdef"[count - 1]}\n'
             + '**Clinical Explanation:** شرح للمعلومة\n**Source:** Formative_2024.txt\n')
    catalog = assessment_catalog(root, {'assessment_sources': [{'path': 'Questions/Formative_2024.txt', 'type': 'past_exam', 'years': [2024]}]})
    assert len(next(iter(build_index(questions, 'synthetic')['questions'].values()))['options']) == count
    assert len(parse_transcript('## ❓ MCQs\n' + block).mcqs[0].options) == count
    assert _option_shape_errors(block, 1, {}) == _correct_answer_errors(block, 1, options) == final_provenance_errors(block, catalog) == []
    generated = block.replace('**[Past Exams - 2024]**', '**[IMP]**')
    assert bool(_option_shape_errors(generated, 1, {'mcq': {'options': {'count': count}}})) == (count != 4)


@pytest.mark.parametrize('options', ['a. First\nc. Third', 'a. First\na. Again\nb. Second', 'b. Second\na. First', 'a. Only'])
def test_invalid_sourced_option_letters_are_still_rejected(options):
    assert _option_shape_errors('### MCQ 1 **[Question Bank]**\n**Options:**\n' + options, 1, {})


@pytest.mark.parametrize('located', [True, False])
def test_uncertain_five_option_question_keeps_wording_and_evidenced_badge(tmp_path, located):
    questions = tmp_path / 'Questions'
    questions.mkdir()
    stem = 'Which unusual clinical finding distinguishes synthetic disease from other syndromes?'
    options = '\n'.join(f'{letter}. Choice {letter}' for letter in 'abcde')
    (questions / 'End_2025.txt').write_text('1. ' + (stem if located else 'An unrelated assessment stem that cannot locate this question?') + '\n' + options)
    (questions / 'Bank.txt').write_text('1. Which unusual clinical finding differs entirely from the reference?\n' + options)
    write_index(build_index(questions, 'synthetic'), questions)
    catalog = assessment_catalog(tmp_path, {'assessment_sources': [{'path': 'Questions/End_2025.txt', 'type': 'past_exam', 'years': [2025]}, {'path': 'Questions/Bank.txt', 'type': 'question_bank'}]})
    block = '### MCQ 5 **[Past Exams - 2025]**\n**Question:** ' + stem + '\n**Options:**\n' + options + '\n**Correct Answer:** e. Choice e\n**Clinical Explanation:** شرح للمعلومة\n**Source:** End_2025.txt\n**Source:** Bank.txt\n'
    revised, corrections = repair_provenance_badges(block, catalog)
    assert stem in revised and options in revised
    assert '**[Past Exams - 2025]**' in revised if located else '**[IMP]**' in revised
    receipts = {repair["retained_fingerprint"] for repair in corrections if "retained_fingerprint" in repair}
    assert final_provenance_errors(revised, catalog) == _option_shape_errors(revised, 5, {}, receipts) == []
    if not located:
        assert corrections[0]['note'] == 'Unlocated question retained as IMP'
    assert repair_provenance_badges(revised, catalog) == (revised, [])
