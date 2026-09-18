#!/usr/bin/env python3
"""Gently soften Fish MP3s, optionally reducing background hiss.

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
# At the fixed 44.1 kHz processing rate, afftdn delays audio by two 551-sample
# hops. Pad and compensate that delay so it cannot discard word endings.
DENOISE_DELAY_SAMPLES = 1102
DENOISE = "afftdn=nr=6:nf=-50:tn=0:gs=12"
CARD_FILENAME = re.compile(r"[a-f0-9]{20}\.mp3")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--denoise", action="store_true",
                        help="Apply the conservative clean-1 hiss reduction after the accepted EQ.")
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
        audio_input = None
        input_args = ["-i", str(recording)]
        audio_filter = FILTER
        if args.denoise:
            audio_input = subprocess.run(
                [ffmpeg, "-v", "error", "-nostdin", "-i", str(recording),
                 "-map", "0:a:0", "-ac", "1", "-ar", "44100", "-f", "f32le", "pipe:1"],
                check=True, stdout=subprocess.PIPE,
            ).stdout
            if not audio_input or len(audio_input) % 4:
                raise RuntimeError(f"Invalid decoded audio: {recording.name}")
            sample_count = len(audio_input) // 4
            input_args = ["-f", "f32le", "-ar", "44100", "-ac", "1", "-i", "pipe:0"]
            audio_filter = (
                f"{FILTER},apad=pad_dur=0.1,{DENOISE},"
                f"atrim=start_sample={DENOISE_DELAY_SAMPLES}:"
                f"end_sample={sample_count + DENOISE_DELAY_SAMPLES},asetpts=PTS-STARTPTS"
            )
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{recording.stem}-", suffix=".mp3", dir=output
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            subprocess.run(
                [
                    ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    *input_args, "-map", "0:a:0", "-vn", "-map_metadata", "-1",
                    "-af", audio_filter, "-c:a", "libmp3lame", "-b:a", "192k",
                    "-ac", "1", "-ar", "44100", str(temporary),
                ],
                input=audio_input,
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
