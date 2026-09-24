"""
Standalone Video File Tester for Zoo Vision Pipelines.
Play any .mp4 video file, visualize detections, area headcount, or tripwires in real time.

Usage Examples:
    # Test restaurant with YOLO26 starting at peak crowd (26:50):
    python test_video.py --video "C:/Users/Magnet Busdev-2/Downloads/restoran.mp4" --pipeline restaurant --start-time 26:50

    # Save an annotated MP4 demo video for client:
    python test_video.py --video "C:/Users/Magnet Busdev-2/Downloads/restoran.mp4" --pipeline restaurant --start-time 26:50 --save-output demo_restaurant.mp4
"""

import os
import sys
import time
import argparse
import logging
import cv2

from nx_integration.nx_client import NxClient
from pipelines.vehicle_gate_pipeline import VehicleGatePipeline
from pipelines.cashier_presence_pipeline import CashierPresencePipeline
from pipelines.restaurant_pipeline import RestaurantCounterPipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] (%(name)s) %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("VideoTester")


def parse_time_str(val: str) -> float:
    """Converts 'MM:SS' or 'HH:MM:SS' or seconds string into float seconds."""
    if not val:
        return 0.0
    val = str(val).strip()
    if ":" in val:
        parts = val.split(":")
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        elif len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
    return float(val)


def test_video(
    video_path: str,
    pipeline_type: str = "restaurant",
    rule_path: str = None,
    start_time: str = "00:00",
    camera_name: str = None,
    save_output: str = None
):
    if not os.path.exists(video_path):
        logger.error(f"Video file not found: '{video_path}'")
        return

    logger.info(f"Opening video: {video_path}")
    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        logger.error(f"Could not open video file: {video_path}")
        return

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    total_duration_sec = total_frames / fps
    logger.info(f"Video Specs: {width}x{height} @ {fps:.1f} FPS (Duration: {total_duration_sec/60:.1f} min, {total_frames} frames)")

    # 1. Initialize Mock Nx Client
    nx_client = NxClient(mock_mode=True)

    # 2. Select Pipeline
    if pipeline_type == "gate":
        rule_cfg = rule_path or "configs/rules/vehicle_gate.yaml"
        c_name = camera_name or "Main Vehicle Gate 1"
        pipeline = VehicleGatePipeline(
            camera_id="cam_gate_test",
            camera_name=c_name,
            nx_camera_id="00000000-0000-0000-0000-000000000003",
            rule_config_path=rule_cfg,
            nx_client=nx_client,
            device="cpu"
        )
    elif pipeline_type == "cashier":
        rule_cfg = rule_path or "configs/rules/cashier_presence.yaml"
        c_name = camera_name or "Loket Mini Train Cashier"
        pipeline = CashierPresencePipeline(
            camera_id="cam_cashier_test",
            camera_name=c_name,
            nx_camera_id="00000000-0000-0000-0000-000000000001",
            rule_config_path=rule_cfg,
            nx_client=nx_client,
            device="cpu"
        )
    elif pipeline_type == "restaurant":
        rule_cfg = rule_path or "configs/rules/restaurant_counter.yaml"
        c_name = camera_name or "Safari Cafe Dining Hall"
        pipeline = RestaurantCounterPipeline(
            camera_id="cam_restaurant_test",
            camera_name=c_name,
            nx_camera_id="00000000-0000-0000-0000-000000000002",
            rule_config_path=rule_cfg,
            nx_client=nx_client,
            device="cpu"
        )
    else:
        logger.error(f"Unknown pipeline: {pipeline_type}")
        return

    # Seek to start time if provided
    start_sec = parse_time_str(start_time)
    if start_sec > 0:
        start_frame = int(start_sec * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, min(start_frame, total_frames - 1))
        logger.info(f"Jumped to start time: {start_time} (Frame #{start_frame})")

    # Setup VideoWriter if recording output
    writer = None
    if save_output:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(save_output, fourcc, min(10.0, fps), (width, height))
        logger.info(f"[RECORDING] Output will be saved to: {save_output}")

    window_name = f"Zoo Vision - {pipeline.camera_name}"
    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(window_name, 1280, 720)

    # Mouse callback for tripwire adjustment (if in tripwire mode)
    clicked_points = []
    def on_mouse_click(event, x, y, flags, param):
        nonlocal clicked_points
        if event == cv2.EVENT_LBUTTONDOWN and hasattr(pipeline, "set_tripwire"):
            norm_x = round(x / width, 3)
            norm_y = round(y / height, 3)
            clicked_points.append((norm_x, norm_y))
            if len(clicked_points) == 1:
                logger.info(f"[COORDINATE PICKER] Point 1 (START): [{norm_x}, {norm_y}]")
            elif len(clicked_points) >= 2:
                p1 = clicked_points[-2]
                p2 = clicked_points[-1]
                logger.info(f"[COORDINATE PICKER] Point 2 (END): [{norm_x}, {norm_y}]")
                pipeline.set_tripwire(p1, p2, (height, width))
                logger.info("[LIVE UPDATE] Tripwire updated on the video in real-time!")

    cv2.setMouseCallback(window_name, on_mouse_click)

    logger.info("=" * 60)
    logger.info(f"Starting playback for [{pipeline.camera_name}]")
    logger.info("Controls: SPACE=Pause | 'd'=Forward 10s | 'a'=Back 10s | 'q'=Quit")
    logger.info("=" * 60)

    frame_delay = max(1, int(1000 / fps))
    paused = False

    while True:
        if not paused:
            ret, frame = cap.read()
            if not ret:
                logger.info("Video ended. Looping back to start...")
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(start_sec * fps))
                continue

            current_frame = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
            current_sec = current_frame / fps
            mins = int(current_sec // 60)
            secs = int(current_sec % 60)
            timestamp_ms = int(current_sec * 1000)

            # Process frame through the active pipeline
            annotated_frame = pipeline.process_frame(frame, timestamp_ms)

            # Write to output video file if enabled
            if writer:
                writer.write(annotated_frame)

            # Clean playback status footer
            time_str = f"Time: {mins:02d}:{secs:02d} | Frame: {current_frame}/{total_frames} | SPACE: Pause | 'd': +10s | 'a': -10s | 'q': Quit"
            cv2.putText(annotated_frame, time_str, (20, height - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (220, 220, 220), 1)

            cv2.imshow(window_name, annotated_frame)

        key = cv2.waitKey(frame_delay if not paused else 50) & 0xFF
        if key == ord('q'):
            break
        elif key == ord(' '):
            paused = not paused
            logger.info("PAUSED" if paused else "RESUMED")
        elif key in [ord('d'), 83]: # 'd' or right arrow
            # Fast-forward 10 seconds
            curr = cap.get(cv2.CAP_PROP_POS_FRAMES)
            cap.set(cv2.CAP_PROP_POS_FRAMES, min(curr + int(10 * fps), total_frames - 1))
            logger.info(">> Fast-forwarded 10s")
        elif key in [ord('a'), 81]: # 'a' or left arrow
            # Rewind 10 seconds
            curr = cap.get(cv2.CAP_PROP_POS_FRAMES)
            cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, curr - int(10 * fps)))
            logger.info("<< Rewound 10s")

    cap.release()
    if writer:
        writer.release()
        logger.info(f"[SAVED] Client demo video saved to {save_output}")
    cv2.destroyAllWindows()
    logger.info("Test video playback ended.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test Zoo Vision Pipelines on an MP4 video file")
    parser.add_argument("--video", required=True, help="Path to .mp4 video file")
    parser.add_argument("--pipeline", choices=["gate", "cashier", "restaurant"], default="restaurant", help="Pipeline type (default: restaurant)")
    parser.add_argument("--start-time", default="00:00", help="Start time e.g. '26:50' or '1610'")
    parser.add_argument("--camera-name", default=None, help="Custom camera name to display on HUD")
    parser.add_argument("--save-output", default=None, help="Optional output .mp4 file path to save demo video")
    parser.add_argument("--rule-config", default=None, help="Custom rule YAML path (optional)")
    args = parser.parse_args()

    test_video(
        video_path=args.video,
        pipeline_type=args.pipeline,
        rule_path=args.rule_config,
        start_time=args.start_time,
        camera_name=args.camera_name,
        save_output=args.save_output
    )
