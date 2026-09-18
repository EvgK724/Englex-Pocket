#!/usr/bin/env python3
"""Gently soften Fish MP3s using FFmpeg, without changing speed or normalizing.

Always use preserved original recordings as --source. Do not repeatedly process
the softened output: the EQ and lossy encoding would accumulate with each pass.
"""

import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


FILTER = (
    "equalizer=f=250:t=q:w=0.7:g=0.5,"
    "equalizer=f=3200:t=q:w=0.8:g=-1.5,"
    "highshelf=f=6000:t=q:w=0.707:g=-1.5"
)
CARD_FILENAME = re.compile(r"[a-f0-9]{20}\.mp3")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if source == output:
        parser.error("Source and output directories must differ; preserve originals.")
    if not source.is_dir():
        parser.error("Source must be an existing directory.")
    recordings = sorted(
        path for path in source.iterdir()
        if path.is_file() and path.suffix.lower() == ".mp3"
    )
    if not recordings:
        parser.error("Source contains no MP3 recordings.")
    if any(not CARD_FILENAME.fullmatch(path.name) for path in recordings):
        parser.error("Every MP3 filename must be 20 lowercase hexadecimal characters + .mp3.")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        parser.error("FFmpeg is required.")
    output.mkdir(parents=True, exist_ok=True)

    for recording in recordings:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{recording.stem}-", suffix=".mp3", dir=output
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            subprocess.run(
                [
                    ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    "-i", str(recording), "-map", "0:a:0", "-vn", "-map_metadata", "-1",
                    "-af", FILTER, "-c:a", "libmp3lame", "-b:a", "192k",
                    "-ac", "1", "-ar", "44100", str(temporary),
                ],
                check=True,
            )
            if temporary.stat().st_size == 0:
                raise RuntimeError(f"FFmpeg produced an empty recording: {recording.name}")
            temporary.chmod(0o644)
            os.replace(temporary, output / recording.name)
            print(f"Softened {recording.name}")
        finally:
            temporary.unlink(missing_ok=True)
    print(f"Done: {len(recordings)} recordings. Original recordings preserved.")


if __name__ == "__main__":
    main()
