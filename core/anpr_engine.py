"""
Indonesian License Plate Recognition (ANPR / LPR) Engine.
Combines a YOLO ONNX License Plate Detector with EasyOCR and an Indonesian TNKB Syntax Parser.
"""

import re
import os
import logging
from typing import Optional, Dict, Any, List, Tuple
import cv2
import numpy as np
from ultralytics import YOLO
# pyrefly: ignore [missing-import]
import easyocr

logger = logging.getLogger("AnprEngine")

# Standard Indonesian Traffic Police Regional Area Codes
INDONESIAN_AREA_CODES = {
    "A", "B", "D", "E", "F", "G", "H", "K", "L", "M", "N", "P", "R", "S", "T", "W",
    "AA", "AB", "AD", "AE", "AG", "BA", "BB", "BD", "BE", "BG", "BH", "BK", "BL", "BM",
    "BN", "BP", "DA", "DB", "DC", "DD", "DE", "DG", "DH", "DK", "DL", "DM", "DN", "DP",
    "DR", "DT", "DW", "EA", "EB", "ED", "KB", "KH", "KT", "KU"
}

# Common OCR confusion mapping for prefix/suffix (where characters MUST be letters)
DIGIT_TO_LETTER = {
    '0': 'D',
    '1': 'I',
    '2': 'Z',
    '4': 'A',
    '5': 'S',
    '6': 'G',
    '8': 'B',
}

# Common OCR confusion mapping for numbers (where characters MUST be digits)
LETTER_TO_DIGIT = {
    'D': '0',
    'O': '0',
    'Q': '0',
    'I': '1',
    'L': '1',
    'Z': '2',
    'A': '4',
    'S': '5',
    'G': '6',
    'B': '8',
}


class AnprEngine:
    def __init__(
        self,
        detector_model_path: str = "models/license_plate_detector.onnx",
        conf_threshold: float = 0.25,
        min_plate_width: int = 30,
        min_plate_height: int = 10,
        gpu: bool = False
    ):
        self.conf_threshold = conf_threshold
        self.min_plate_width = min_plate_width
        self.min_plate_height = min_plate_height
        self.gpu = gpu

        if not os.path.exists(detector_model_path):
            logger.warning(f"Plate detector model not found at '{detector_model_path}'.")

        logger.info(f"Loading YOLO License Plate Detector from '{detector_model_path}'...")
        self.detector = YOLO(detector_model_path, task="detect")

        logger.info(f"Initializing OCR Engine (GPU={gpu})...")
        self.ocr_reader = easyocr.Reader(['en'], gpu=gpu, verbose=False)
        logger.info("ANPR Engine successfully initialized.")

    def detect_plates(self, image: np.ndarray) -> List[Tuple[int, int, int, int, float]]:
        """
        Detects license plates in an image (frame or cropped vehicle).
        Returns list of (x1, y1, x2, y2, confidence).
        """
        if image is None or image.size == 0:
            return []

        results = self.detector(image, conf=self.conf_threshold, verbose=False)[0]
        plates = []
        if len(results.boxes) > 0:
            boxes = results.boxes.xyxy.cpu().numpy()
            confs = results.boxes.conf.cpu().numpy()
            for box, conf in zip(boxes, confs):
                x1, y1, x2, y2 = map(int, box)
                w = x2 - x1
                h = y2 - y1
                if w >= self.min_plate_width and h >= self.min_plate_height:
                    plates.append((x1, y1, x2, y2, float(conf)))

        return plates

    def read_plate(self, plate_crop: np.ndarray) -> Tuple[str, float, bool]:
        """
        Runs OCR on cropped plate image, filters out the tax stamp,
        and applies Indonesian syntax error correction.
        Returns: (formatted_text, confidence, is_valid_syntax)
        """
        if plate_crop is None or plate_crop.size == 0:
            return "", 0.0, False

        h, w = plate_crop.shape[:2]
        gray = cv2.cvtColor(plate_crop, cv2.COLOR_BGR2GRAY)

        # Upscale if small to ensure character stroke clarity
        if h < 64:
            scale = 64.0 / max(h, 1)
            new_w = int(w * scale)
            gray = cv2.resize(gray, (new_w, 64), interpolation=cv2.INTER_CUBIC)

        # Contrast enhancement via CLAHE
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)

        ocr_results = self.ocr_reader.readtext(
            enhanced,
            allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        )
        if not ocr_results:
            return "", 0.0, False

        return self._parse_indonesian_tnkb(ocr_results, gray.shape[0])

    def _parse_indonesian_tnkb(
        self,
        ocr_results: List[Any],
        plate_height: int
    ) -> Tuple[str, float, bool]:
        """
        Parses OCR chunks:
        1. Excludes bottom 25% of the bounding box height (Indonesian tax stamp month.year).
        2. Clusters tokens left-to-right.
        3. Corrects common OCR confusion (0 <-> D, 8 <-> B, etc.).
        """
        main_chunks = []
        confidences = []

        for bbox, text, conf in ocr_results:
            if conf < 0.20:
                continue
            # Vertical center of token
            cy = np.mean([pt[1] for pt in bbox])
            # Filter out bottom tax stamp
            if cy > plate_height * 0.75:
                continue

            cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
            if cleaned:
                min_x = min([pt[0] for pt in bbox])
                main_chunks.append((min_x, cleaned, conf))
                confidences.append(conf)

        if not main_chunks:
            return "", 0.0, False

        # Sort left to right
        main_chunks.sort(key=lambda c: c[0])
        tokens = [c[1] for c in main_chunks]
        full_str = "".join(tokens)
        avg_conf = float(np.mean(confidences)) if confidences else 0.0

        # Pattern 1: Exact direct match on full string
        m = re.match(r'^([A-Z]{1,2})(\d{1,4})([A-Z]{1,3})$', full_str)
        if m:
            area, nums, suffix = m.groups()
            if area in INDONESIAN_AREA_CODES:
                return f"{area} {nums} {suffix}", avg_conf, True

        # Pattern 2: 3 detected tokens [Area, Registration, Suffix]
        if len(tokens) == 3:
            pfx = "".join([DIGIT_TO_LETTER.get(c, c) for c in tokens[0]])
            num = "".join([LETTER_TO_DIGIT.get(c, c) for c in tokens[1]])
            sfx = "".join([DIGIT_TO_LETTER.get(c, c) for c in tokens[2]])
            if pfx in INDONESIAN_AREA_CODES and num.isdigit() and sfx.isalpha():
                return f"{pfx} {num} {sfx}", avg_conf, True

        # Pattern 3: Fallback parsing with error correction
        for pfx_len in [2, 1]:
            if len(full_str) < pfx_len + 2:
                continue
            raw_pfx = full_str[:pfx_len]
            pfx = "".join([DIGIT_TO_LETTER.get(c, c) for c in raw_pfx])
            if pfx in INDONESIAN_AREA_CODES:
                rem = full_str[pfx_len:]
                # Scan for up to 4 digits
                digits = []
                idx = 0
                while idx < len(rem) and (rem[idx].isdigit() or rem[idx] in LETTER_TO_DIGIT) and len(digits) < 4:
                    digits.append(LETTER_TO_DIGIT.get(rem[idx], rem[idx]))
                    idx += 1
                num_str = "".join(digits)
                sfx_raw = rem[idx:]
                sfx = "".join([DIGIT_TO_LETTER.get(c, c) for c in sfx_raw if c.isalpha() or c in DIGIT_TO_LETTER])[:3]
                if num_str.isdigit() and len(num_str) >= 1 and sfx.isalpha() and len(sfx) >= 1:
                    return f"{pfx} {num_str} {sfx}", avg_conf, True

        # Unverified text
        return full_str, avg_conf, False

    def process_vehicle(
        self,
        frame: np.ndarray,
        vehicle_bbox: Tuple[int, int, int, int]
    ) -> Optional[Dict[str, Any]]:
        """
        Given a full frame and a vehicle bounding box [vx1, vy1, vx2, vy2],
        crops vehicle, detects plate, reads text, and returns results.
        """
        vx1, vy1, vx2, vy2 = vehicle_bbox
        h, w = frame.shape[:2]

        # Clamp vehicle box
        vx1, vy1 = max(0, vx1), max(0, vy1)
        vx2, vy2 = min(w, vx2), min(h, vy2)

        v_crop = frame[vy1:vy2, vx1:vx2]
        if v_crop.size == 0:
            return None

        # 1. Detect plates in vehicle crop
        plates = self.detect_plates(v_crop)
        if not plates:
            return None

        # Pick plate with highest confidence
        best_plate = max(plates, key=lambda p: p[4])
        px1, py1, px2, py2, p_conf = best_plate

        # Absolute coordinates in frame
        abs_px1 = vx1 + px1
        abs_py1 = vy1 + py1
        abs_px2 = vx1 + px2
        abs_py2 = vy1 + py2

        # Extract plate crop with slight margin
        pad_x = int((px2 - px1) * 0.05)
        pad_y = int((py2 - py1) * 0.05)
        cx1 = max(0, px1 - pad_x)
        cy1 = max(0, py1 - pad_y)
        cx2 = min(v_crop.shape[1], px2 + pad_x)
        cy2 = min(v_crop.shape[0], py2 + pad_y)

        plate_img = v_crop[cy1:cy2, cx1:cx2]

        # 2. Read plate text
        plate_text, ocr_conf, is_valid = self.read_plate(plate_img)

        return {
            "plate_text": plate_text,
            "plate_confidence": p_conf,
            "ocr_confidence": ocr_conf,
            "is_valid": is_valid,
            "plate_bbox": (abs_px1, abs_py1, abs_px2, abs_py2)
        }
