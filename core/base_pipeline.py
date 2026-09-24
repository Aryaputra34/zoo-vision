"""
Abstract Base Pipeline for all Zoo Computer Vision attraction monitors.
Standardizes YOLO model loading, frame processing, and Nx Event dispatching.
"""

from abc import ABC, abstractmethod
import logging
from typing import Dict, Any, Optional
import numpy as np
import yaml
from ultralytics import YOLO

from nx_integration.nx_client import NxClient

logger = logging.getLogger("BasePipeline")


class BasePipeline(ABC):
    def __init__(
        self,
        camera_id: str,
        camera_name: str,
        nx_camera_id: str,
        rule_config_path: Optional[str] = None,
        nx_client: Optional[NxClient] = None,
        model_name: str = "yolo11n.pt",
        device: str = "cpu",
        roi: Optional[Any] = None,
        rules: Optional[Dict[str, Any]] = None
    ):
        self.camera_id = camera_id
        self.camera_name = camera_name
        self.nx_camera_id = nx_camera_id
        self.rule_config_path = rule_config_path
        self.nx_client = nx_client
        self.device = device

        # 1. Load base rule parameters from YAML file if available
        self.rules = self._load_rules(rule_config_path) if rule_config_path else {}

        # 2. Merge inline rules overrides if specified
        if rules and isinstance(rules, dict):
            self.rules.update(rules)

        # 3. Merge inline ROI if specified
        if roi is not None:
            self._apply_inline_roi(roi)

        # Load YOLO model
        logger.info(f"[{self.camera_name}] Loading vision model '{model_name}' on device '{device}'...")
        self.model = YOLO(model_name)

    def _apply_inline_roi(self, roi: Any):
        """Applies inline ROI to rules configuration."""
        if isinstance(roi, dict):
            if "clerk_zone" in roi:
                self.rules["clerk_zone"] = roi["clerk_zone"]
            if "visitor_zone" in roi:
                self.rules["visitor_zone"] = roi["visitor_zone"]
            if "tripwire" in roi:
                self.rules["tripwire"] = roi["tripwire"]
            elif "start" in roi and "end" in roi:
                self.rules["tripwire"] = roi
            elif "zone_polygon" in roi:
                self.rules["zone_polygon"] = roi["zone_polygon"]
            elif "dining_zone" in roi:
                self.rules["dining_zone"] = roi["dining_zone"]
            elif "roi_polygon" in roi:
                self.rules["roi_polygon"] = roi["roi_polygon"]
            elif "clerk_zone" not in roi and "visitor_zone" not in roi:
                self.rules["zone_polygon"] = roi
        elif isinstance(roi, list):
            # List of polygon points [[x, y], ...]
            self.rules["zone_polygon"] = roi
            self.rules["dining_zone"] = roi
            self.rules["roi_polygon"] = roi

    def _load_rules(self, config_path: Optional[str]) -> Dict[str, Any]:
        """Loads rule configuration from YAML file."""
        if not config_path:
            return {}
        try:
            with open(config_path, "r") as f:
                return yaml.safe_load(f) or {}
        except Exception as e:
            logger.error(f"Failed to load rule config {config_path}: {e}")
            return {}

    @abstractmethod
    def process_frame(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        """
        Process a single decoded video frame.
        Must return an annotated frame for visualization / debugging.
        """
        pass
