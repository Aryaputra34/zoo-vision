"""
Zoo & Safari Computer Vision engine entrypoint.

The engine reads its settings from the environment (core/env.py) and its cameras from the API, and refetches them
on every `cfg:changed` notice. It publishes each camera's status and latest frame to Redis for the API.

    uv run python main.py [--preview]     # --preview shows an OpenCV window per camera

Ctrl+C (or SIGTERM) stops it gracefully; on Windows Ctrl+Break does too.
"""

import argparse
import logging
import signal
import sys
import threading
import uuid
from pathlib import Path

import redis
from dotenv import load_dotenv

from core.api_client import EngineApi
from core.api_server import create_app, start_api_server
from core.boxes import BoxPublisher
from core.config_listener import ConfigListener
from core.debug_frames import DebugPublisher
from core.env import EngineEnv, EnvError, load_env
from core.event_stream import EventStream
from core.messages import event_message
from core.model_jobs import ModelJobs
from core.model_pool import ModelPool
from core.snapshot_store import SnapshotStore
from core.status import StatusPublisher
from core.supervisor import Supervisor
from core.worker import WorkerDeps
from nx_integration.nx_client import NxClient

logger = logging.getLogger("MainOrchestrator")

THREAD_JOIN_S = 7.0  # above the 5 s BRPOP of the model jobs thread


def run(env: EngineEnv, stop: threading.Event, *, loader=None, preview: bool = False) -> None:
    """Runs the engine until `stop` is set. `loader` replaces ultralytics' YOLO in the model pool (tests)."""
    boot_id = uuid.uuid4().hex
    client = redis.Redis.from_url(env.redis_url, socket_timeout=5, socket_connect_timeout=5)
    events = pool = snapshots = supervisor = listener = publisher = server = jobs = jobs_client = boxes_pub = debug_pub = boxes_client = debug_client = None
    try:
        events = EventStream(env.redis_url, engine_group=env.engine_group)
        events.send(event_message(None, "system", "engine_started",
                                  {"bootId": boot_id, "engineGroup": env.engine_group}))
        snapshots = SnapshotStore(root=env.snapshot_dir, retention_days=env.snapshot_retention_days)
        pool = ModelPool(env.device, env.models_dir, max_batch=env.max_batch, loader=loader)
        nx_client = NxClient(mock_mode=True)  # bookmarks are only logged until the API's nx output module exists

        boxes_client = redis.Redis.from_url(env.redis_url, socket_timeout=2, socket_connect_timeout=2)
        boxes_pub = BoxPublisher(boxes_client)
        boxes_pub.start()

        api = EngineApi(env.api_url, env.engine_token, env.engine_group)
        deps = WorkerDeps(pool=pool, events=events, snapshots=snapshots, nx_client=nx_client, device=env.device, boxes=boxes_pub)
        publisher = StatusPublisher(client, lambda: list(supervisor.workers.values()),
                                    engine_group=env.engine_group, boot_id=boot_id)
        supervisor = Supervisor(api, deps, on_stop=publisher.forget)
        listener = ConfigListener(client, supervisor.request_sync)
        debug_client = redis.Redis.from_url(env.redis_url, socket_timeout=2, socket_connect_timeout=2)
        debug_pub = DebugPublisher(debug_client, supervisor.pipelines)
        publisher.start()
        listener.start()
        debug_pub.start()
        if env.model_jobs:
            # BRPOP blocks for 5 s, so this connection's read timeout must be longer than the shared client's
            jobs_client = redis.Redis.from_url(env.redis_url, socket_timeout=10, socket_connect_timeout=5)
            jobs = ModelJobs(jobs_client, api, env.models_dir, env.device)
            jobs.start()
        if env.preview_port:
            app = create_app(supervisor.pipelines, snapshots, env.preview_api_key or None)
            server = start_api_server(app, host=env.preview_host, port=env.preview_port)
        logger.info("Engine %s (group %s) is running", boot_id[:8], env.engine_group)

        if preview:
            _run_with_windows(supervisor, stop)
        else:
            supervisor.run(stop)
    finally:
        logger.info("Engine stopping")
        if supervisor is not None:
            supervisor.shutdown()  # supervisor.run has returned
        threads = (listener, publisher, jobs, boxes_pub, debug_pub)
        for thread in threads:
            if thread is not None:
                thread.stop()
        for thread in threads:
            if thread is not None and thread.is_alive():
                thread.join(THREAD_JOIN_S)
        if server is not None:
            server.should_exit = True
        if pool is not None:
            pool.close()
        if snapshots is not None:
            snapshots.stop()
        if events is not None:
            events.stop()
        client.close()
        if jobs_client is not None:
            jobs_client.close()
        if boxes_client is not None:
            boxes_client.close()
        if debug_client is not None:
            debug_client.close()


def _run_with_windows(supervisor: Supervisor, stop: threading.Event) -> None:
    """The supervisor runs in a thread; this thread shows the annotated frames (cv2 windows) until 'q' or stop."""
    import cv2

    def supervise():
        try:
            supervisor.run(stop)
        finally:
            stop.set()  # also ends the window loop if the supervisor ever dies

    thread = threading.Thread(target=supervise, name="supervisor", daemon=True)
    thread.start()
    try:
        while not stop.is_set():
            for camera_id, pipeline in supervisor.pipelines().items():
                frame = pipeline.latest_frame()
                if frame is not None:
                    cv2.imshow(f"Zoo Vision - {pipeline.camera_name}", frame)
            if cv2.waitKey(30) & 0xFF == ord("q"):
                stop.set()
    finally:
        stop.set()
        thread.join()
        cv2.destroyAllWindows()


def _stop_on_signals(stop: threading.Event) -> None:
    """Ctrl+C (SIGINT) and SIGTERM set `stop`; on Windows Ctrl+Break (SIGBREAK) does too.

    On Windows a process can start with Ctrl+C ignored: a process created in a new process group ignores it, and
    every child inherits that (seen with `Start-Process uv run python ...`: uv, the venv launcher and the engine all
    ignored it, so Ctrl+C did nothing). SetConsoleCtrlHandler(NULL, FALSE) turns Ctrl+C handling back on.
    """
    signals = [signal.SIGINT, signal.SIGTERM]
    if sys.platform == "win32":
        signals.append(signal.SIGBREAK)
        import ctypes

        if not ctypes.windll.kernel32.SetConsoleCtrlHandler(None, False):
            logger.warning("Could not turn Ctrl+C handling on; Ctrl+Break stops the engine")
    for sig in signals:
        signal.signal(sig, lambda *_: stop.set())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Zoo Vision engine")
    parser.add_argument("--preview", action="store_true", help="show an OpenCV window per camera")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] (%(name)s) %(message)s",
                        datefmt="%H:%M:%S")
    # A local-dev convenience: services/engine/.env fills variables that are not already set. The real
    # environment always wins (override=False), so Docker and production behave as before.
    load_dotenv(Path(__file__).resolve().parent / ".env", override=False)
    try:
        env = load_env()
    except EnvError as e:
        print(e, file=sys.stderr)  # names the variables, never their values
        return 2
    stop = threading.Event()
    _stop_on_signals(stop)
    run(env, stop, preview=args.preview)
    return 0


if __name__ == "__main__":
    sys.exit(main())
