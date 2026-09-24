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
    save_output: str = None,
    infer_fps: float = None,
    frame_skip: int = 1,
    hide_boxes: bool = False,
    show_boxes: bool = False,
    no_gui: bool = False,
    no_anpr: bool = False
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

    # Compute frame cadence (how many frames to advance per inference step)
    if infer_fps is not None and infer_fps > 0:
        step_frames = max(1, int(round(fps / infer_fps)))
        effective_infer_fps = fps / step_frames
        logger.info(f"[CADENCE] Target inference: {infer_fps:.1f} FPS -> Inferencing 1 frame every {step_frames} frames ({effective_infer_fps:.1f} FPS)")
    elif frame_skip and frame_skip > 1:
        step_frames = int(frame_skip)
        effective_infer_fps = fps / step_frames
        logger.info(f"[CADENCE] Frame skip: {step_frames} -> Inferencing 1 frame every {step_frames} frames ({effective_infer_fps:.1f} FPS)")
    else:
        step_frames = 1
        effective_infer_fps = fps

    # 1. Initialize Mock Nx Client
    nx_client = NxClient(mock_mode=True)

    # 2. Select Pipeline
    if pipeline_type == "gate":
        rule_cfg = rule_path or "configs/rules/vehicle_gate.yaml"
        c_name = camera_name or "Main Vehicle Gate 1"
        gate_rules = {"anpr": {"enabled": False}} if no_anpr else None
        pipeline = VehicleGatePipeline(
            camera_id="cam_gate_test",
            camera_name=c_name,
            nx_camera_id="00000000-0000-0000-0000-000000000003",
            rule_config_path=rule_cfg,
            nx_client=nx_client,
            device="cpu",
            rules=gate_rules
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

    # Apply display overrides if requested
    if hide_boxes and hasattr(pipeline, "show_boxes"):
        pipeline.show_boxes = False
        pipeline.show_labels = False
        logger.info("[DISPLAY] Clean Client Demo Mode: Bounding boxes hidden (HUD only).")
    elif show_boxes and hasattr(pipeline, "show_boxes"):
        pipeline.show_boxes = True
        pipeline.show_labels = True
        logger.info("[DISPLAY] Debug Mode: Bounding boxes and confidence labels visible.")

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
        # Write at effective FPS so saved demo plays back at natural real-time speed
        writer_fps = min(effective_infer_fps, 30.0)
        writer = cv2.VideoWriter(save_output, fourcc, writer_fps, (width, height))
        logger.info(f"[RECORDING] Output will be saved to: {save_output} (@ {writer_fps:.1f} FPS)")

    gui_enabled = not no_gui
    window_name = f"Zoo Vision - {pipeline.camera_name}"
    clicked_points = []

    if gui_enabled:
        try:
            cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
            cv2.resizeWindow(window_name, 1280, 720)

            # Mouse callback for tripwire adjustment (if in tripwire mode)
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
        except Exception as e:
            logger.warning(f"Could not open GUI window ({e}). Running in headless mode.")
            gui_enabled = False

    logger.info("=" * 60)
    logger.info(f"Starting playback for [{pipeline.camera_name}]")
    if gui_enabled:
        controls_hint = "Controls: SPACE=Pause | 'd'=+10s | 'a'=-10s | 'q'=Quit"
        if hasattr(pipeline, "anpr_enabled"):
            controls_hint += " | 'p'=Toggle ANPR"
        logger.info(controls_hint)
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
            cadence_str = f" | Step: {step_frames}f ({effective_infer_fps:.1f} FPS)" if step_frames > 1 else ""
            time_str = f"Time: {mins:02d}:{secs:02d} | Frame: {current_frame}/{total_frames}{cadence_str} | SPACE: Pause | 'd': +10s | 'a': -10s | 'q': Quit"
            cv2.putText(annotated_frame, time_str, (20, height - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (220, 220, 220), 1)

            if gui_enabled:
                cv2.imshow(window_name, annotated_frame)

            # Advance / skip intermediate frames between inferences
            if step_frames > 1 and not paused:
                for _ in range(step_frames - 1):
                    if not cap.grab():
                        break

        if gui_enabled:
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
            elif key in [ord('p'), ord('P')] and hasattr(pipeline, "anpr_enabled"):
                pipeline.anpr_enabled = not pipeline.anpr_enabled
                state_str = "ACTIVE" if pipeline.anpr_enabled else "OFF"
                logger.info(f"[ANPR TOGGLE] ANPR is now {state_str}")

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
    parser.add_argument("--infer-fps", type=float, default=None, help="Target inference rate in FPS (e.g. 2 for 2 inferences/sec). Skips intermediate frames.")
    parser.add_argument("--frame-skip", type=int, default=1, help="Process every N-th frame (e.g. 5 to evaluate 1 frame every 5 frames)")
    parser.add_argument("--hide-boxes", action="store_true", help="Hide bounding boxes (clean executive HUD view for client demos)")
    parser.add_argument("--show-boxes", action="store_true", help="Force show bounding boxes and tracking IDs")
    parser.add_argument("--no-gui", action="store_true", help="Run without opening GUI window (ideal for headless or background execution)")
    parser.add_argument("--no-anpr", action="store_true", help="Disable License Plate Recognition (ANPR) for gate pipeline")
    args = parser.parse_args()

    test_video(
        video_path=args.video,
        pipeline_type=args.pipeline,
        rule_path=args.rule_config,
        start_time=args.start_time,
        camera_name=args.camera_name,
        save_output=args.save_output,
        infer_fps=args.infer_fps,
        frame_skip=args.frame_skip,
        hide_boxes=args.hide_boxes,
        show_boxes=args.show_boxes,
        no_gui=args.no_gui,
        no_anpr=args.no_anpr
    )
