"""Temporary picture-only slides exercise real OCR and a fake multimodal reader."""
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
import reportlab
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))

import figure_descriptions
import mcp_server
import slide_figures
from test_figure_cache import deck


def page_image(path, text=''):
    image = Image.new('RGB', (1600, 900), 'white')
    draw = ImageDraw.Draw(image)
    if text:
        font = ImageFont.truetype(str(Path(reportlab.__file__).parent / 'fonts/Vera.ttf'), 52)
        draw.multiline_text((80, 120), text, fill='black', font=font, spacing=25)
    else:
        draw.ellipse((400, 100, 1200, 800), fill='red')
    image.save(path)


@pytest.fixture
def vision_agy(tmp_path, monkeypatch):
    binary = tmp_path / 'bin/agy'
    binary.parent.mkdir()
    log = tmp_path / 'vision-calls.jsonl'
    binary.write_text(f'#!{sys.executable}\n' + r'''
import json, os, pathlib, sys
prompt = sys.argv[sys.argv.index('-p') + 1]
assert 'Use your multimodal file-reading tool to READ figure.png' in prompt
assert 'No other files, tools, writes or commands' in prompt
assert [p.name for p in pathlib.Path.cwd().iterdir()] == ['figure.png']
assert pathlib.Path('figure.png').read_bytes().startswith(b'\x89PNG')
with open(os.environ['VISION_LOG'], 'a') as log:
    log.write(json.dumps({'cwd': str(pathlib.Path.cwd()), 'prompt': prompt}) + '\n')
answer = json.loads(os.environ['VISION_RESPONSE']) if os.environ.get('VISION_RESPONSE') else {'inspected': True, 'caption': 'Red circular diagram illustrating a clinical skin lesion.'}
print(json.dumps({'status': 'SUCCESS', 'response': json.dumps(answer)}))
''')
    binary.chmod(0o755)
    monkeypatch.setenv('PATH', str(binary.parent) + os.pathsep + os.environ['PATH'])
    monkeypatch.delenv('TRANSCRIBER_AGY', raising=False)
    monkeypatch.setenv('VISION_LOG', str(log))
    return log


def test_picture_only_extraction_gives_writer_ocr_and_cached_vision_descriptions(tmp_path, vision_agy):
    if not shutil.which('tesseract'):
        pytest.skip('real local OCR requires tesseract')
    source = tmp_path / 'deck.pptx'
    inputs = {}
    for page in (2, 3):
        image = tmp_path / f'input-{page}.png'
        page_image(image, 'HYPERTHYROIDISM\nClinical signs include exophthalmos\nand increased thyroid hormone.' if page == 2 else '')
        inputs[page] = image.read_bytes()
    deck(source, True, image_payloads=inputs)
    def render(_pdf, pages, directory, _resolution):
        directory.mkdir(parents=True, exist_ok=True)
        result = {}
        for page in pages:
            result[page] = directory / f'page-{page:03d}.png'
            result[page].write_bytes(inputs[page])
        return result
    with patch.object(slide_figures, 'slides_to_pdf', return_value=tmp_path / 'render.pdf'), \
         patch.object(slide_figures, 'page_texts', return_value=['Lecture title with typed text', '', '']), \
         patch.object(slide_figures, '_render_pages', side_effect=render):
        first = slide_figures.extract_figures(source, tmp_path / 'Transcripts', 'Deck')
        payload = json.loads(first.manifest_path.read_text())
        assert payload['figures'][0]['reading']['method'] == 'ocr'
        assert 'exophthalmos' in payload['figures'][0]['reading']['text'].lower()
        assert payload['figures'][1]['reading']['method'] == 'vision'
        assert 'skin lesion' in payload['figures'][1]['reading']['text']
        assert payload['figures'][1]['reading']['image_sha256'] == hashlib.sha256(first.figures[1].image_path.read_bytes()).hexdigest()
        context = type('Context', (), {'figure_directories': (first.output_dir,), 'slides_path': source, 'title': 'Deck', 'path': tmp_path / 'Transcripts/Deck.draft.md'})()
        cached = mcp_server._cached_figures(context)
        supplied = mcp_server._agy_segment_figures(context, 1, cached['figures'], (first.output_dir / 'slides.txt').read_text())
        assert all(figure['slide_text'] and 'Machine-read' in figure['slide_text'] for figure in supplied)
        assert all("not doctor's words" in figure['slide_text'] for figure in supplied)
        slide_figures.extract_figures(source, tmp_path / 'Transcripts', 'Deck')
    calls = [json.loads(line) for line in vision_agy.read_text().splitlines()]
    assert len(calls) == 1
    assert all(not Path(call['cwd']).exists() for call in calls)
    assert int(slide_figures.SELECTION_VERSION) > 5
    payload['figures'][0]['reading']['text'] = 'tampered description'
    first.manifest_path.write_text(json.dumps(payload))
    assert mcp_server._cached_figures(context) is None


@pytest.mark.parametrize('failure', ['missing-reading', 'changed-image'])
def test_legacy_description_fields_or_changed_raster_invalidate_cache(tmp_path, failure):
    from types import SimpleNamespace

    from figure_fixtures import figure_manifest

    source = tmp_path / 'deck.pdf'
    source.write_bytes(b'fake deck')
    directory = tmp_path / 'Figures/Deck'
    directory.mkdir(parents=True)
    image = directory / 'page-001.png'
    page_image(image, 'Thyroid hormone')
    figure_manifest(source, directory, (1,))
    payload = json.loads((directory / 'figures.json').read_text())
    if failure == 'missing-reading':
        payload['figures'][0].pop('reading')
        payload['figures_fingerprint'] = slide_figures.selection_fingerprint(payload['figures'])
        (directory / 'figures.json').write_text(json.dumps(payload))
    else:
        page_image(image, 'Changed thyroid hormone')
    context = SimpleNamespace(figure_directories=(directory,), slides_path=source, title='Deck')
    assert mcp_server._cached_figures(context) is None


@pytest.mark.parametrize('limit', ['count', 'time'])
def test_description_budget_refuses_unread_pages_without_caching_empty_readings(tmp_path, vision_agy, monkeypatch, limit):
    images = {}
    for page in (1, 2):
        path = tmp_path / f'page-{page}.png'
        page_image(path)
        with Image.open(path) as image:
            image.putpixel((page, page), (0, 0, 0))
            image.save(path)
        images[page] = path
    monkeypatch.setattr(figure_descriptions, '_local_ocr', lambda *_: '')
    if limit == 'count':
        monkeypatch.setattr(figure_descriptions, 'MAX_CAPTIONS', 1)
    else:
        monkeypatch.setattr(figure_descriptions, 'DESCRIPTION_TIMEOUT_SECONDS', 0)
    with pytest.raises(figure_descriptions.DescriptionError, match='limit|budget'):
        figure_descriptions.describe_figures(images, ['', ''], tmp_path)
    calls = vision_agy.read_text().splitlines() if vision_agy.exists() else []
    assert len(calls) == (1 if limit == 'count' else 0)
    caches = list((tmp_path / '.descriptions').glob('*.json'))
    assert len(caches) == len(calls)
    assert all(json.loads(path.read_text())['reading']['text'] for path in caches)


@pytest.mark.parametrize('answer', [
    {'inspected': False, 'caption': 'Could not inspect the slide.'},
    {'inspected': True, 'caption': ''},
    {'inspected': True, 'caption': 'A skin lesion.', 'invented': 'doctor said cancer'},
])
def test_uninspected_or_malformed_captions_never_become_cached_evidence(tmp_path, vision_agy, monkeypatch, answer):
    image = tmp_path / 'page.png'
    page_image(image)
    monkeypatch.setattr(figure_descriptions, '_local_ocr', lambda *_: '')
    monkeypatch.setenv('VISION_RESPONSE', json.dumps(answer))
    with pytest.raises(figure_descriptions.DescriptionError, match='caption'):
        figure_descriptions.describe_figures({1: image}, [''], tmp_path)
    assert not list((tmp_path / '.descriptions').glob('*.json'))
