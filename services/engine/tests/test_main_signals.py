"""The engine stops gracefully on Ctrl+C / Ctrl+Break (Windows) and SIGINT / SIGTERM (POSIX).

The child is main.main() with run() replaced by a fake that waits for the stop event, so the real signal handling of
main() runs in a real process; it writes "graceful" once the stop event is set and run() returns.
"""

import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
WINDOWS = sys.platform == "win32"

CHILD = textwrap.dedent("""
    import sys
    import time
    from pathlib import Path

    sys.path.insert(0, sys.argv[2])
    import main

    out = Path(sys.argv[1])


    def fake_run(env, stop, **kwargs):
        out.with_suffix(".ready").write_text("ready")
        deadline = time.monotonic() + 60
        while not stop.is_set() and time.monotonic() < deadline:
            stop.wait(0.1)  # like Supervisor.run: the main thread wakes every STOP_POLL_S, so the handler can run
        out.write_text("graceful" if stop.is_set() else "not stopped")


    main.run = fake_run
    sys.exit(main.main([]))
""")

# Attaches to the child's console and sends it a console control event (0 Ctrl+C, 1 Ctrl+Break), ignoring it itself
SENDER = textwrap.dedent("""
    import ctypes
    import sys

    k = ctypes.windll.kernel32
    ignore = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_uint)(lambda event: 1)  # handled: the sender lives on
    k.FreeConsole()
    if not k.AttachConsole(int(sys.argv[1])):
        sys.exit(2)
    k.SetConsoleCtrlHandler(ignore, True)
    sys.exit(0 if k.GenerateConsoleCtrlEvent(int(sys.argv[2]), 0) else 3)
""")


def start_child(tmp_path: Path, **popen):
    script = tmp_path / "child.py"
    script.write_text(CHILD, encoding="utf-8")
    out = tmp_path / "result.txt"
    env = {**os.environ, "REDIS_URL": "redis://127.0.0.1:1/0", "ENGINE_TOKEN": "t" * 40}
    child = subprocess.Popen([sys.executable, str(script), str(out), str(ENGINE_DIR)], cwd=ENGINE_DIR, env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **popen)
    deadline = time.monotonic() + 60
    while not out.with_suffix(".ready").exists():
        if child.poll() is not None or time.monotonic() > deadline:
            child.kill()
            pytest.fail(f"the child did not start (exit code {child.poll()})")
        time.sleep(0.05)
    return child, out


def assert_graceful(child, out: Path):
    try:
        code = child.wait(15)
    except subprocess.TimeoutExpired:
        child.kill()
        pytest.fail("the engine did not stop on the signal")
    assert out.read_text() == "graceful" and code == 0


@pytest.mark.parametrize("key", ["ctrl_c", "second_key"])
def test_the_stop_keys_stop_the_engine(tmp_path, key):
    """Windows: Ctrl+C and Ctrl+Break, sent to the child's console. POSIX: SIGINT and SIGTERM."""
    if not WINDOWS:
        child, out = start_child(tmp_path, start_new_session=True)
        child.send_signal(signal.SIGINT if key == "ctrl_c" else signal.SIGTERM)
        assert_graceful(child, out)
        return
    # Its own hidden console, and its own process group: a new process group starts with Ctrl+C ignored, as a
    # process does that inherits "ignore Ctrl+C" from what started it (seen under `Start-Process uv run ...`)
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0  # SW_HIDE
    child, out = start_child(tmp_path, startupinfo=startup,
                             creationflags=subprocess.CREATE_NEW_CONSOLE | subprocess.CREATE_NEW_PROCESS_GROUP)
    sender = tmp_path / "sender.py"
    sender.write_text(SENDER, encoding="utf-8")
    event = 0 if key == "ctrl_c" else 1  # CTRL_C_EVENT, CTRL_BREAK_EVENT
    sent = subprocess.run([sys.executable, str(sender), str(child.pid), str(event)], timeout=30,
                          creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW)
    assert sent.returncode == 0, f"could not send the event (exit code {sent.returncode})"
    assert_graceful(child, out)
