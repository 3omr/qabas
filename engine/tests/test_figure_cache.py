"""Deck-byte identity and selection provenance on temporary synthetic slides."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import mcp_server
import pytest
import slide_figures
from transcript_contract import current_slide_figures


def deck(path, pictures, image_label='picture', image_payloads=None, page_count=3):
    relationship = slide_figures.RELATIONSHIP_NAMESPACE
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('ppt/presentation.xml', f'<presentation xmlns:r="{relationship}"><sldIdLst>'
                         + ''.join(f'<sldId r:id="r{page}"/>' for page in range(1, page_count + 1)) + '</sldIdLst></presentation>')
        archive.writestr('ppt/_rels/presentation.xml.rels', '<Relationships>'
                         + ''.join(f'<Relationship Id="r{page}" Target="slides/slide{page}.xml"/>' for page in range(1, page_count + 1)) + '</Relationships>')
        for page in range(1, page_count + 1):
            picture = '<a:blip r:embed="image"/>' if pictures and page > 1 else ''
            text = '<a:t>Lecture title with typed text</a:t>' if page == 1 else ('<a:t>Typed lecture prose on this slide</a:t>' if not pictures else '')
            archive.writestr(f'ppt/slides/slide{page}.xml', f'<slide xmlns:a="{slide_figures.DRAWING_NAMESPACE}" xmlns:r="{relationship}">{text}{picture}</slide>')
            archive.writestr(f'ppt/slides/_rels/slide{page}.xml.rels', f'<Relationships><Relationship Id="image" Type="{relationship}/image" Target="../media/{page}.png"/></Relationships>')
            archive.writestr(f'ppt/media/{page}.png', image_payloads[page] if image_payloads and page in image_payloads else f'{image_label} {page}')


def extract(source, root, pictures):
    def render(_pdf, pages, directory, _resolution):
        directory.mkdir(parents=True, exist_ok=True)
        result = {}
        for page in pages:
            result[page] = directory / f'page-{page:03d}.png'
            result[page].write_bytes(b'fake raster')
        return result

    texts = ['Lecture title with typed text', '', ''] if pictures else ['Typed lecture prose on this slide'] * 3
    def readings(images, texts, directory):
        return {page: {'text': texts[page - 1] or 'Synthetic picture', 'method': 'typed' if texts[page - 1] else 'vision',
                       'image_sha256': hashlib.sha256(image.read_bytes()).hexdigest()} for page, image in images.items()}

    with patch.object(slide_figures, 'slides_to_pdf', return_value=root / 'rendered.pdf'), \
         patch.object(slide_figures, 'page_texts', return_value=texts), \
         patch.object(slide_figures, '_render_pages', side_effect=render), \
         patch.object(slide_figures, 'describe_figures', side_effect=readings):
        return slide_figures.extract_figures(source, root / 'Transcripts', 'Deck')


@pytest.mark.parametrize('pictures', [True, False])
def test_synthetic_decks_record_the_source_and_selection_inputs(tmp_path, pictures):
    source = tmp_path / 'deck.pptx'
    deck(source, pictures)
    figures = extract(source, tmp_path, pictures)
    payload = json.loads(figures.manifest_path.read_text())
    assert payload['source_fingerprint'] == {'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'size': source.stat().st_size}
    assert payload['selection_inputs']['page_image_counts'] == ([0, 1, 1] if pictures else [0, 0, 0])
    assert payload['selection_fingerprint'] == hashlib.sha256(json.dumps(payload['selection_inputs'], sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    expected = [2, 3] if pictures else []
    assert [entry['page'] for entry in payload['figures']] == expected
    context = SimpleNamespace(figure_directories=(figures.output_dir,), slides_path=source, title='Deck')
    assert mcp_server._cached_figures(context)['status'] == 'ready'
    assert current_slide_figures(figures.output_dir, source) == tuple(figure.image_path for figure in figures.figures)


@pytest.mark.parametrize('change', ['deck', 'same-size', 'legacy', 'legacy-inputs', 'options', 'signals', 'selection', 'malformed'])
def test_begin_and_review_reextract_when_cache_identity_disagrees(tmp_path, monkeypatch, change):
    source = tmp_path / 'deck.pptx'
    deck(source, False)
    figures = extract(source, tmp_path, False)
    payload = json.loads(figures.manifest_path.read_text())
    if change == 'deck':
        deck(source, True)
    elif change == 'same-size':
        original_size = source.stat().st_size
        deck(source, False, 'changed')
        assert source.stat().st_size == original_size
    elif change == 'legacy':
        payload.pop('source_fingerprint')
    elif change == 'legacy-inputs':
        payload.pop('selection_inputs')
    elif change == 'options':
        payload['selection_inputs']['include_text_pages'] = True
        payload['selection_fingerprint'] = slide_figures.selection_fingerprint(payload['selection_inputs'])
    elif change == 'signals':
        payload['selection_inputs']['page_image_counts'][1] = 1
    elif change == 'selection':
        payload['figures'] = [{'page': 2, 'file': 'page-002.png', 'text_characters': 0, 'embedded_images': 1}]
    figures.manifest_path.write_text('{' if change == 'malformed' else json.dumps(payload))
    context = SimpleNamespace(figure_directories=(figures.output_dir,), slides_path=source, title='Deck')
    assert mcp_server._cached_figures(context) is None
    assert current_slide_figures(figures.output_dir, source) is None
    monkeypatch.setattr(mcp_server, '_resolve_draft_context', lambda *_: context)
    monkeypatch.setattr(mcp_server, '_extraction_layout_state', lambda *_: None)
    monkeypatch.setattr(mcp_server, '_refresh_extracted_layout', lambda *_: None)
    def refresh(*_):
        extract(source, tmp_path, change == 'deck')
        return 'extracted'
    monkeypatch.setattr(mcp_server, '_extract_figures', refresh)
    assert mcp_server._begin_figures({'module': 'test'}, tmp_path)['status'] == 'ready'
    figures.manifest_path.write_text(json.dumps(payload))
    assert mcp_server._ensure_review_figures(context, {'module': 'test'}, tmp_path) == []
    assert mcp_server._cached_figures(context)['status'] == 'ready'


def test_deck_changed_during_extraction_does_not_publish_a_manifest(tmp_path):
    source = tmp_path / 'deck.pptx'
    deck(source, False)

    def change_deck(*_):
        deck(source, True)
        return {}

    with patch.object(slide_figures, 'slides_to_pdf', return_value=tmp_path / 'rendered.pdf'), \
         patch.object(slide_figures, 'page_texts', return_value=['Lecture text'] * 3), \
         patch.object(slide_figures, '_render_pages', side_effect=change_deck), \
         pytest.raises(slide_figures.FigureExtractionError, match='changed during extraction'):
        slide_figures.extract_figures(source, tmp_path / 'Transcripts', 'Deck')
    assert not (tmp_path / 'Transcripts/Figures/Deck/figures.json').exists()
