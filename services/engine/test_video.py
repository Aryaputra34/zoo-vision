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
import typing
import uuid
import argparse
import logging
import cv2
import yaml
from pydantic import BaseModel

from contracts.registry import REGISTRY
from core.base_pipeline import CameraInfo
from core.event_stream import EventStream
from core.messages import event_message
from core.api_server import create_app, start_api_server
from core.model_pool import ModelPool
from core.settings import SettingsError, parse_settings
from core.snapshot_store import SnapshotStore
from nx_integration.nx_client import NxClient
from usecases import create_pipeline

ENGINE_GROUP = "test_video"  # never the real engine's ENGINE_GROUP

# --pipeline name -> use case
PIPELINES = {
    "gate": "vehicle_gate", "vehicle_gate": "vehicle_gate",
    "cashier": "cashier_presence", "cashier_presence": "cashier_presence",
    "restaurant": "restaurant_counter", "restaurant_counter": "restaurant_counter",
    "horse": "horse_riding", "horse_riding": "horse_riding",
    "restaurant_table": "restaurant_table", "table": "restaurant_table", "tables": "restaurant_table",
}
# use case -> (default rule file, default camera name, camera id, Nx camera id)
DEFAULTS = {
    "vehicle_gate": ("vehicle_gate", "Main Vehicle Gate 1", "cam_gate_test", "00000000-0000-0000-0000-000000000003"),
    "cashier_presence": ("cashier_presence", "Loket Mini Train Cashier", "cam_cashier_test",
                         "00000000-0000-0000-0000-000000000001"),
    "restaurant_counter": ("restaurant_counter", "Safari Cafe Dining Hall", "cam_restaurant_test",
                           "00000000-0000-0000-0000-000000000002"),
    "horse_riding": ("horse_riding", "Pony Riding Attraction", "cam_horse_test",
                     "00000000-0000-0000-0000-000000000005"),
    "restaurant_table": ("restaurant_table", "Safari Cafe Table Monitor", "cam_table_test",
                         "00000000-0000-0000-0000-000000000002"),
}

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


def _model_types(annotation) -> list:
    """The Pydantic models inside a field annotation (through unions, lists and tuples)."""
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return [annotation]
    found = []
    for arg in typing.get_args(annotation):
        found += _model_types(arg)
    return found


def prune_unknown(model: type[BaseModel], value):
    """Drops what the settings model does not define (prototype rule files carry `rule_name`, `target_class`,
    ...), and empty polygons, the way tools/import_yaml_config.py does."""
    if not isinstance(value, dict):
        return value
    out = {}
    for key, item in value.items():
        field = model.model_fields.get(key)
        if field is None:
            logger.info(f"[RULES] Ignoring '{key}': not a setting of this use case.")
            continue
        if item == []:
            continue
        nested = _model_types(field.annotation)
        if nested and isinstance(item, dict):
            item = prune_unknown(nested[0], item)
        elif nested and isinstance(item, list):
            item = [prune_unknown(nested[0], x) for x in item]
        out[key] = item
    return out


def load_settings(use_case: str, rule_path: str, no_anpr: bool, hide_boxes: bool, show_boxes: bool) -> BaseModel:
    """Rule YAML -> typed settings. The display flags are set in the settings, before parsing."""
    model = REGISTRY[use_case].settings
    with open(rule_path, "r") as f:
        rules = prune_unknown(model, yaml.safe_load(f) or {})
    if no_anpr and "anpr" in model.model_fields:
        rules["anpr"] = {**rules.get("anpr", {}), "enabled": False}
    if hide_boxes or show_boxes:
        # the table pipeline's person boxes are show_person_boxes
        flag = hide_boxes is False
        for boxes, labels in (("show_boxes", "show_labels"), ("show_person_boxes", "show_person_labels")):
            if boxes in model.model_fields:
                rules[boxes] = rules[labels] = flag
                logger.info("[DISPLAY] " + ("Debug Mode: Bounding boxes and confidence labels visible." if flag else
                                            "Clean Client Demo Mode: Bounding boxes hidden (HUD only)."))
    try:
        return parse_settings(use_case, rules, strict=False)
    except SettingsError as e:
        raise SystemExit(f"Rule file {rule_path} does not satisfy the {use_case} settings: {e}")


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
    no_anpr: bool = False,
    duration: str = None,
    analytics: bool = False,
    device: str = "cpu"
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

    # 2. Select Pipeline: rule YAML -> typed settings, shared model from the pool
    use_case = PIPELINES.get(pipeline_type)
    if use_case is None:
        logger.error(f"Unknown pipeline: {pipeline_type}")
        return
    rule_name, default_name, camera_id, nx_camera_id = DEFAULTS[use_case]
    settings = load_settings(
        use_case, rule_path or f"configs/rules/{rule_name}.yaml", no_anpr, hide_boxes, show_boxes
    )
    pool = ModelPool(device)
    model = pool.acquire(settings.model_name, settings.imgsz)
    pipeline = create_pipeline(
        CameraInfo(camera_id, camera_name or default_name, nx_camera_id), use_case, settings, model,
        device=device, nx_client=nx_client,
    )

    # Optionally send events, intervals and metrics to the Redis stream (REDIS_URL), with event snapshots
    # and the live preview API, so the run looks like a real camera
    events = snapshots = api_server = None
    if analytics:
        app_cfg = {}
        if os.path.exists("configs/app_config.yaml"):
            with open("configs/app_config.yaml", "r") as f:
                app_cfg = yaml.safe_load(f) or {}
        redis_url = os.environ.get("REDIS_URL")
        if redis_url:
            events = EventStream(redis_url, engine_group=ENGINE_GROUP)
            events.send(event_message(None, "system", "engine_started",
                                      {"bootId": uuid.uuid4().hex, "engineGroup": ENGINE_GROUP}))
            pipeline.events = events
        else:
            logger.warning("REDIS_URL is not set: events, intervals and metrics are not sent.")
        snap_cfg = app_cfg.get("snapshots", {})
        if snap_cfg.get("enabled", True):
            snapshots = SnapshotStore(root=snap_cfg.get("dir", "snapshots"), retention_days=snap_cfg.get("retention_days", 30))
            pipeline.snapshots = snapshots
        api_cfg = app_cfg.get("api_server", {})
        if api_cfg.get("enabled", True):
            api_server = start_api_server(
                create_app({pipeline.camera_id: pipeline}, snapshots, api_cfg.get("api_key") or None),
                host=api_cfg.get("host", "127.0.0.1"),
                port=api_cfg.get("port", 8000),
            )

    # Seek to start time if provided
    start_sec = parse_time_str(start_time)
    if start_sec > 0:
        start_frame = int(start_sec * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, min(start_frame, total_frames - 1))
        logger.info(f"Jumped to start time: {start_time} (Frame #{start_frame})")

    # Optional stop time, so a short window can be rendered out of a long recording
    end_sec = None
    if duration:
        end_sec = start_sec + parse_time_str(duration)
        logger.info(
            f"[WINDOW] Stopping at {int(end_sec // 60):02d}:{int(end_sec % 60):02d} "
            f"({parse_time_str(duration):.0f}s after start)"
        )

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
                # Only loop for interactive preview. Headless runs have no 'q' key to break out
                # with, so looping there would spin forever.
                if not gui_enabled:
                    logger.info("Video ended. Stopping.")
                    break
                logger.info("Video ended. Looping back to start...")
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(start_sec * fps))
                continue

            current_frame = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
            current_sec = current_frame / fps

            if end_sec is not None and current_sec >= end_sec:
                logger.info(f"Reached end of requested window at {int(current_sec // 60):02d}:"
                            f"{int(current_sec % 60):02d}. Stopping.")
                break
            mins = int(current_sec // 60)
            secs = int(current_sec % 60)
            timestamp_ms = int(current_sec * 1000)

            # Process frame through the active pipeline
            annotated_frame = pipeline.run(frame, timestamp_ms)

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
    if api_server:
        api_server.should_exit = True
    pipeline.shutdown()
    pool.release(model)
    pool.close()
    if snapshots:
        snapshots.stop()
    if events:
        events.stop()
    if writer:
        writer.release()
        logger.info(f"[SAVED] Client demo video saved to {save_output}")
    cv2.destroyAllWindows()
    logger.info("Test video playback ended.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test Zoo Vision Pipelines on an MP4 video file")
    parser.add_argument("--video", required=True, help="Path to .mp4 video file")
    parser.add_argument(
        "--pipeline",
        choices=list(PIPELINES),
        default="horse",
        help="Pipeline type (default: horse)"
    )
    parser.add_argument("--start-time", default="00:00", help="Start time e.g. '26:50' or '1610'")
    parser.add_argument("--camera-name", default=None, help="Custom camera name to display on HUD")
    parser.add_argument("--save-output", default=None, help="Optional output .mp4 file path to save demo video")
    parser.add_argument("--rule-config", default=None, help="Custom rule YAML path (optional)")
    parser.add_argument("--infer-fps", type=float, default=None, help="Target inference rate in FPS (e.g. 2 for 2 inferences/sec). Skips intermediate frames.")
    parser.add_argument("--frame-skip", type=int, default=1, help="Process every N-th frame (e.g. 5 to evaluate 1 frame every 5 frames)")
    parser.add_argument("--hide-boxes", action="store_true", help="Hide bounding boxes (clean executive HUD view for client demos)")
    parser.add_argument("--show-boxes", action="store_true", help="Force show bounding boxes and tracking IDs")
    parser.add_argument("--no-gui", action="store_true", help="Run without opening GUI window (ideal for headless or background execution)")
    parser.add_argument("--preview", action="store_true", help="Optional/compatibility flag; GUI is shown by default unless --no-gui is passed")
    parser.add_argument("--no-anpr", action="store_true", help="Disable License Plate Recognition (ANPR) for gate pipeline")
    parser.add_argument("--duration", default=None, help="Stop after this much video, e.g. '60' or '1:30'. Renders a window out of a long recording.")
    parser.add_argument("--device", default="cpu", help="Inference device, e.g. cpu or cuda:0 (default: cpu)")
    parser.add_argument("--analytics", action="store_true", help="Send events, intervals and metrics to the Redis stream (REDIS_URL) with snapshots, and serve the live preview (configs/app_config.yaml)")
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
        no_anpr=args.no_anpr,
        duration=args.duration,
        analytics=args.analytics,
        device=args.device
    )
