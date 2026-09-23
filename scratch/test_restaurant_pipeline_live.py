"""
Verification script for upgraded YOLO26 Restaurant Area Occupancy Pipeline.
Processes consecutive frames from restoran.mp4 through RestaurantCounterPipeline.
"""

import os
import sys
import cv2
import time
import logging

sys.path.insert(0, os.path.abspath("."))

from nx_integration.nx_client import NxClient
from pipelines.restaurant_pipeline import RestaurantCounterPipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("TestRestaurantPipeline")

def main():
    video_path = r"C:\Users\Magnet Busdev-2\Downloads\restoran.mp4"
    rule_path = "configs/rules/restaurant_counter.yaml"
    out_dir = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch"
    os.makedirs(out_dir, exist_ok=True)
    
    mock_nx = NxClient(host="127.0.0.1", mock_mode=True)
    pipeline = RestaurantCounterPipeline(
        camera_id="cam_restaurant_01",
        camera_name="Safari Cafe Dining Hall",
        nx_camera_id="00000000-0000-0000-0000-000000000002",
        rule_config_path=rule_path,
        nx_client=mock_nx,
        device="cpu"
    )
    
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 15.5
    # Start around 26:50 (Frame #24900)
    start_frame = int((26 * 60 + 50) * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    
    print(f"\nProcessing 10 frames from {video_path} starting at frame {start_frame}...")
    
    saved_samples = 0
    for i in range(10):
        ret, frame = cap.read()
        if not ret or frame is None:
            break
            
        timestamp_ms = int(time.time() * 1000)
        t0 = time.time()
        annotated = pipeline.process_frame(frame, timestamp_ms)
        elapsed = (time.time() - t0) * 1000
        
        print(
            f"Frame {i+1:02d} | Raw Detected: {pipeline.raw_occupancy:2d} | "
            f"Smoothed Occupancy: {pipeline.current_occupancy:2d}/{pipeline.max_capacity} | "
            f"Time: {elapsed:.0f} ms"
        )
        
        # Save first and last frame for inspection
        if i in [0, 5, 9]:
            out_path = os.path.join(out_dir, f"verified_restaurant_frame_{i+1}.jpg")
            cv2.imwrite(out_path, annotated)
            print(f"  -> Saved preview: {out_path}")
            
    cap.release()
    print("\nVerification completed successfully!")

if __name__ == "__main__":
    main()
