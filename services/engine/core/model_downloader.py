"""
Automated Model Downloader & Asset Manager for Zoo Vision Pipelines.
Handles self-healing downloads for pre-trained models (ANPR License Plate Detector, YOLO, etc.)
when running on fresh clones, new edge devices, or cloud containers.
"""

import os
import sys
import logging
import requests
from typing import Optional

logger = logging.getLogger("ModelDownloader")

# Official repository raw link for Indonesian ANPR YOLO11n ONNX detector (10.4 MB)
OFFICIAL_PLATE_MODEL_URL = "https://raw.githubusercontent.com/Aryaputra34/zoo-vision/main/models/license_plate_detector.onnx"
OFFICIAL_PLATE_MODEL_MIRROR = "https://github.com/Aryaputra34/zoo-vision/raw/main/models/license_plate_detector.onnx"
DEFAULT_PLATE_MODEL_PATH = "models/license_plate_detector.onnx"
EXPECTED_MIN_SIZE = 5 * 1024 * 1024  # At least 5MB for valid ONNX model


def download_with_progress(url: str, dest_path: str, chunk_size: int = 65536) -> bool:
    """
    Downloads a file with streaming chunks and a console progress bar.
    Writes to a temporary file first, then atomically renames to prevent corruptions.
    """
    dest_dir = os.path.dirname(dest_path)
    if dest_dir:
        os.makedirs(dest_dir, exist_ok=True)

    tmp_path = dest_path + ".tmp"

    try:
        headers = {
            "User-Agent": "ZooVision-ModelDownloader/1.0"
        }
        response = requests.get(url, headers=headers, stream=True, timeout=(10, 60))
        response.raise_for_status()

        total_bytes = int(response.headers.get("content-length", 0))
        downloaded = 0

        # Try tqdm if available for clean terminal progress
        try:
            from tqdm import tqdm
            progress_bar = tqdm(
                total=total_bytes,
                unit="B",
                unit_scale=True,
                unit_divisor=1024,
                desc=f"[DOWNLOAD] {os.path.basename(dest_path)}"
            )
        except ImportError:
            progress_bar = None

        print(f"[*] Downloading: {url}")
        print(f"    Destination: {dest_path}")
        if total_bytes > 0:
            print(f"    Total Size:  {total_bytes / (1024 * 1024):.2f} MB")

        with open(tmp_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=chunk_size):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_bar:
                        progress_bar.update(len(chunk))

        if progress_bar:
            progress_bar.close()

        # Atomic replacement
        if os.path.exists(dest_path):
            os.remove(dest_path)
        os.replace(tmp_path, dest_path)

        final_size = os.path.getsize(dest_path)
        print(f"[OK] Download complete: {dest_path} ({final_size / (1024 * 1024):.2f} MB)\n")
        return True

    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        logger.error(f"Download failed from {url}: {e}")
        return False


def ensure_license_plate_detector(
    dest_path: str = DEFAULT_PLATE_MODEL_PATH,
    force: bool = False
) -> str:
    """
    Ensures that the License Plate Detector ONNX model is available locally.
    If missing or forced, automatically downloads it from the project repository.
    Returns the resolved absolute or normalized local path.
    """
    normalized_path = os.path.normpath(dest_path)

    # Check if already present and valid
    if os.path.exists(normalized_path) and not force:
        file_size = os.path.getsize(normalized_path)
        if file_size >= EXPECTED_MIN_SIZE:
            logger.debug(f"Plate detector model verified at '{normalized_path}' ({file_size / (1024 * 1024):.1f} MB).")
            return normalized_path
        else:
            logger.warning(f"Plate detector model at '{normalized_path}' is suspiciously small ({file_size} bytes). Re-downloading...")

    print("\n" + "=" * 65)
    print("[*] LICENSE PLATE DETECTOR SETUP (AUTO-HEALING)")
    print("=" * 65)
    print(f"Model file not found or corrupted at: {normalized_path}")
    print("Fetching pre-trained Indonesian TNKB License Plate Detector (YOLO11n ONNX)...")

    # Attempt primary URL
    success = download_with_progress(OFFICIAL_PLATE_MODEL_URL, normalized_path)

    # Attempt mirror if primary fails
    if not success:
        print("[!] Primary URL failed. Attempting mirror repository URL...")
        success = download_with_progress(OFFICIAL_PLATE_MODEL_MIRROR, normalized_path)

    if not success or not os.path.exists(normalized_path):
        raise RuntimeError(
            f"Failed to automatically obtain License Plate Detector model for '{normalized_path}'. "
            f"Please verify your network connection or manually copy the file to {normalized_path}."
        )

    return normalized_path


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("Testing ensure_license_plate_detector()...")
    path = ensure_license_plate_detector()
    print(f"Model ready at: {path}")
