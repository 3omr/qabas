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
from reportlab.pdfgen import canvas

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
if os.environ.get('VISION_RESPONSES'):
    answer = json.loads(os.environ['VISION_RESPONSES'])[len(pathlib.Path(os.environ['VISION_LOG']).read_text().splitlines()) - 1]
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
def test_description_budget_keeps_unread_pages_without_caching_neutral_readings(tmp_path, vision_agy, monkeypatch, limit):
    images = {}
    for page in (1, 2):
        path = tmp_path / f'page-{page}.png'
        page_image(path)
        with Image.open(path) as image:
            image.putpixel((page, page), (0, 0, 0))
            image.save(path)
        images[page] = path
    monkeypatch.setattr(figure_descriptions, '_local_ocr', lambda *_: figure_descriptions._OcrReading('', False))
    if limit == 'count':
        monkeypatch.setattr(figure_descriptions, 'MAX_CAPTIONS', 1)
    else:
        monkeypatch.setattr(figure_descriptions, 'DESCRIPTION_TIMEOUT_SECONDS', 0)
    readings = figure_descriptions.describe_figures(images, ['', ''], tmp_path)
    assert set(readings) == {1, 2}
    assert readings[2]['method'] == 'neutral'
    assert 'limit' in readings[2]['error'] or 'budget' in readings[2]['error']
    assert readings[2]['text'] == 'Slide 2: picture slide; no machine-readable description'
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
    monkeypatch.setattr(figure_descriptions, '_local_ocr', lambda *_: figure_descriptions._OcrReading('', False))
    monkeypatch.setenv('VISION_RESPONSE', json.dumps(answer))
    reading = figure_descriptions.describe_figures({1: image}, [''], tmp_path)[1]
    assert reading['method'] == 'neutral'
    assert 'caption' in reading['error']
    assert figure_descriptions.valid_reading(reading)
    assert not list((tmp_path / '.descriptions').glob('*.json'))


@pytest.mark.parametrize('response', [
    '```json\n{"inspected":true,"caption":"A red circular diagram.","toolAction":"read","toolSummary":"done"}\n```',
    '{"inspected":true,"caption":"```text\\nA red\\ncircular diagram.\\n```"}\n{"toolAction":"read","toolSummary":"done"}',
    json.dumps({'inspected': True, 'caption': 'A red circular diagram.\n{"toolAction":"read","toolSummary":"done"}'}),
    json.dumps({'inspected': True, 'caption': '```A red circular diagram.```\ntoolAction: read\ntoolSummary: done'}),
])
def test_inspected_caption_formatting_and_metadata_leave_only_visual_text(response):
    assert figure_descriptions._caption_text(response) == 'A red circular diagram.'


def test_long_inspected_caption_is_shortened_instead_of_losing_its_picture():
    caption = figure_descriptions._caption_text(json.dumps({'inspected': True, 'caption': 'Visible labelled circular diagram. ' * 100}))
    assert caption.startswith('Visible labelled circular diagram.')
    assert len(caption) <= 600 and len(caption.split()) <= 80


def test_refused_picture_keeps_manifest_and_later_extraction_retries_only_failures(tmp_path, vision_agy, monkeypatch):
    # Hyperthyroidism lost all twenty pictures when its last caption was refused.
    if not all(shutil.which(binary) for binary in ('pdftotext', 'pdfimages', 'pdftoppm', 'tesseract')):
        pytest.skip('synthetic PDF extraction requires poppler and tesseract')
    source = tmp_path / 'deck.pdf'
    pdf = canvas.Canvas(str(source), pagesize=(800, 450))
    for page in range(1, 4):
        image = tmp_path / f'input-{page}.png'
        page_image(image, 'HYPERTHYROIDISM\nClinical signs include exophthalmos\nand increased thyroid hormone.' if page == 1 else '')
        with Image.open(image) as raster:
            raster.putpixel((page, page), (0, 0, 0))
            raster.save(image)
        pdf.drawImage(str(image), 0, 0, width=800, height=450)
        pdf.showPage()
    pdf.save()
    monkeypatch.setenv('VISION_RESPONSES', json.dumps([
        {'inspected': True, 'caption': 'A red circular diagram.'},
        {'inspected': False, 'caption': ''},
    ]))
    first = slide_figures.extract_figures(source, tmp_path / 'Transcripts', 'Deck')
    readings = [figure.reading for figure in first.figures]
    assert [reading['method'] for reading in readings] == ['ocr', 'vision', 'neutral']
    assert readings[2]['error']
    assert slide_figures.current_manifest(first.output_dir, source) is not None
    payload = json.loads(first.manifest_path.read_text())
    neutral = payload['figures'][2]['reading'].copy()
    for corrupt in ({key: value for key, value in neutral.items() if key != 'error'},
                    {**neutral, 'error': ''}, {**neutral, 'text': 'Invented visual evidence'}):
        payload['figures'][2]['reading'] = corrupt
        payload['figures_fingerprint'] = slide_figures.selection_fingerprint(payload['figures'])
        first.manifest_path.write_text(json.dumps(payload))
        assert slide_figures.current_manifest(first.output_dir, source) is None
    from types import SimpleNamespace

    # Restore the valid partial manifest before supplying it to the writer.
    slide_figures.write_manifest(first)
    context = SimpleNamespace(figure_directories=(first.output_dir,), slides_path=source, title='Deck')
    supplied = mcp_server._cached_figures(context)
    assert len(supplied['figures']) == 3
    assert supplied['figures'][2]['description_method'] == 'neutral'
    assert "not doctor's words" in supplied['figures'][2]['slide_text']
    outline = first.text_path.read_text()
    assert "not doctor's words" in outline and 'Slide 3: picture slide' in outline
    monkeypatch.delenv('VISION_RESPONSES')
    monkeypatch.setenv('VISION_RESPONSE', json.dumps({'inspected': True, 'caption': 'A red circular diagram.'}))
    second = slide_figures.extract_figures(source, tmp_path / 'Transcripts', 'Deck')
    assert [figure.reading['method'] for figure in second.figures] == ['ocr', 'vision', 'vision']
    assert all('error' not in figure.reading for figure in second.figures)
    assert len(vision_agy.read_text().splitlines()) == 3


@pytest.mark.parametrize('failure', ['ocr-error', 'page-timeout', 'weak-ocr', 'partial-ocr-error'])
def test_failed_page_keeps_available_text_and_next_page_is_described(tmp_path, monkeypatch, failure):
    import subprocess

    images = {}
    for page in (1, 2):
        images[page] = tmp_path / f'page-{page}.png'
        page_image(images[page], f'Page {page}')
    weak = 'Visible thyroid label'
    def ocr(command, **kwargs):
        second = command[1] == str(images[2])
        if not second and failure == 'page-timeout':
            raise subprocess.TimeoutExpired('tesseract', kwargs['timeout'])
        text = 'Thyroid hormone clinical features' if second else ('' if failure == 'ocr-error' else weak)
        confidence = 95 if second else 20
        tsv = f'page_num\tblock_num\tpar_num\tline_num\tconf\ttext\n1\t1\t1\t1\t{confidence}\t{text}\n'
        return subprocess.CompletedProcess(command, int(not second and failure in {'ocr-error', 'partial-ocr-error'}), tsv, '')
    monkeypatch.setattr(figure_descriptions.cancellation, 'run', ocr)
    def vision(*_):
        raise figure_descriptions.DescriptionError('Could not inspect the slide')
    monkeypatch.setattr(figure_descriptions, '_vision_caption', vision)
    readings = figure_descriptions.describe_figures(images, ['', ''], tmp_path)
    assert readings[1]['method'] == ('ocr' if failure in {'weak-ocr', 'partial-ocr-error'} else 'neutral')
    assert readings[1]['error']
    if failure in {'weak-ocr', 'partial-ocr-error'}:
        assert readings[1]['text'] == weak
    assert readings[2]['method'] == 'ocr' and 'error' not in readings[2]
    assert len(list((tmp_path / '.descriptions').glob('*.json'))) == 1
