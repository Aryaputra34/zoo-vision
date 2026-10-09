"""
Fetches the engine's model weights listed in services/engine/models/manifest.json and checks each
file's sha256. Standard library only, so it runs with a bare server's python3.

    python tools/fetch_models.py                          # download missing models from the release
    python tools/fetch_models.py --dest /data/models      # into the deployment's model folder
    python tools/fetch_models.py --from /media/usb/models # offline: copy from a folder instead
    python tools/fetch_models.py --only yolo26s.onnx      # just one (repeatable)
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

DEFAULT_MANIFEST = Path(__file__).resolve().parent.parent / "services" / "engine" / "models" / "manifest.json"
CHUNK = 1 << 20


@dataclass(frozen=True)
class ModelEntry:
    file: str
    sha256: str
    size: int
    url: str


class FetchError(Exception):
    pass


def load_manifest(path: Path) -> list[ModelEntry]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return [ModelEntry(**m) for m in data["models"]]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def fetch(entry: ModelEntry, dest: Path, source_dir: Optional[Path] = None) -> str:
    """Makes dest/<file> match the manifest. Returns "present" or "fetched"; raises FetchError."""
    dest = Path(dest)
    target = dest / entry.file
    if target.exists() and sha256_of(target) == entry.sha256:
        return "present"

    if source_dir is not None:
        src_file = Path(source_dir) / entry.file
        if not src_file.is_file():
            raise FetchError(f"{entry.file} not found in {source_dir}")
        opener = lambda: open(src_file, "rb")  # noqa: E731
    else:
        opener = lambda: urllib.request.urlopen(entry.url, timeout=60)  # noqa: E731

    dest.mkdir(parents=True, exist_ok=True)
    part = dest / f".{entry.file}.part"
    try:
        h = hashlib.sha256()
        with opener() as src, open(part, "wb") as out:
            while chunk := src.read(CHUNK):
                h.update(chunk)
                out.write(chunk)
        if h.hexdigest() != entry.sha256:
            raise FetchError(f"checksum mismatch for {entry.file}: got {h.hexdigest()}, expected {entry.sha256}")
        os.replace(part, target)
    except FetchError:
        raise
    except Exception as e:
        raise FetchError(f"{entry.file}: {e}") from e
    finally:
        part.unlink(missing_ok=True)
    return "fetched"


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch and verify the engine's model weights")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST, help="manifest.json path")
    parser.add_argument("--dest", type=Path, default=None, help="target folder (default: the manifest's folder)")
    parser.add_argument("--from", dest="source_dir", type=Path, default=None,
                        help="copy from this folder instead of downloading (offline sites)")
    parser.add_argument("--only", action="append", default=[], metavar="FILE", help="fetch only this model")
    args = parser.parse_args(argv)

    entries = load_manifest(args.manifest)
    dest = args.dest or args.manifest.parent
    unknown = sorted(set(args.only) - {e.file for e in entries})
    if unknown:
        print(f"not in {args.manifest}: {', '.join(unknown)}", file=sys.stderr)
        return 2
    if args.only:
        entries = [e for e in entries if e.file in args.only]

    failed = 0
    for e in entries:
        try:
            print(f"ok      {e.file} ({fetch(e, dest, args.source_dir)})", flush=True)
        except FetchError as err:
            failed += 1
            print(f"FAILED  {e.file}: {err}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
