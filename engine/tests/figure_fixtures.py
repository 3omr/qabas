"""Self-validating extraction manifests for fake slide tools."""
import hashlib
from pathlib import Path

from slide_figures import (
    Figure,
    FigureSet,
    selection_options,
    source_fingerprint,
    write_manifest,
)


def figure_manifest(source: Path, directory: Path, pages: tuple[int, ...] = ()) -> None:
    """Record synthetic text/image observations for selected fixture pages."""
    total = max(pages, default=1)
    texts = ['x' if page in pages else 'Typed prose that exceeds the selection floor' for page in range(1, total + 1)]
    images = [int(page in pages) for page in range(1, total + 1)]
    write_manifest(FigureSet(
        lecture=directory.name, source_name=source.name, output_dir=directory,
        figures=tuple(Figure(page, directory / f'page-{page:03d}.png', 1, 1, {
            'text': 'x', 'method': 'typed',
            'image_sha256': hashlib.sha256((directory / f'page-{page:03d}.png').read_bytes()
                                         if (directory / f'page-{page:03d}.png').exists() else b'fake figure').hexdigest(),
        }) for page in pages),
        total_pages=total, skipped_text_pages=total - len(pages),
        source_fingerprint=source_fingerprint(source),
        selection_inputs={**selection_options(), 'page_texts': texts, 'page_image_counts': images},
    ))
