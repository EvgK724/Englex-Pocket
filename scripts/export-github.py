"""Export the complete runnable app and Pages workflow, without hosting credentials."""
import argparse
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

parser = argparse.ArgumentParser()
parser.add_argument('output', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
output = args.output.resolve()
if output.is_relative_to(root):
    parser.error('Choose an export path outside the source repository.')
output.parent.mkdir(parents=True, exist_ok=True)
files = sorted(p for p in (root / 'dist').rglob('*') if p.is_file())
files.extend(root / p for p in [
    '.github/workflows/pages.yml', 'scripts/check-static.mjs',
    'scripts/test-recorded-speech.mjs', 'scripts/export-github.py',
    'assets/app-icon-source.png', 'GITHUB-PAGES.md',
])
with ZipFile(output, 'w', compression=ZIP_DEFLATED, compresslevel=6) as archive:
    for path in files:
        archive.write(path, str(Path('Englex-Pocket') / path.relative_to(root)))
    archive.writestr('Englex-Pocket/README.md', (root / 'GITHUB-PAGES.md').read_bytes())
with ZipFile(output) as archive:
    assert archive.testzip() is None, 'ZIP integrity check failed'
    assert sum(name.endswith('.mp3') for name in archive.namelist()) == 8132
print(f'{output}: {output.stat().st_size} bytes, 8,132 recordings, Pages workflow and instructions included.')
