import argparse
import json
import os
from pathlib import Path
import random
import signal
import socket
import threading

from .client import APIError, WorkerClient
from .runtime import MageRuntime
from .worker import run_one_job


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="afterimage-mage-worker")
    parser.add_argument(
        "--api-base-url",
        default=os.environ.get("AFTERIMAGE_API_BASE_URL"),
        required=os.environ.get("AFTERIMAGE_API_BASE_URL") is None,
    )
    parser.add_argument(
        "--token-file",
        type=Path,
        default=os.environ.get("AFTERIMAGE_TOKEN_FILE"),
        required=os.environ.get("AFTERIMAGE_TOKEN_FILE") is None,
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=Path(os.environ.get("AFTERIMAGE_WORK_DIR", "/work")),
    )
    parser.add_argument(
        "--worker-id",
        default=os.environ.get("AFTERIMAGE_WORKER_ID", socket.gethostname()),
    )
    parser.add_argument("--idle-min", type=float, default=15)
    parser.add_argument("--idle-max", type=float, default=30)
    parser.add_argument("--once", action="store_true")
    return parser


def main() -> int:
    args = _parser().parse_args()
    if args.idle_min <= 0 or args.idle_max < args.idle_min:
        raise SystemExit("idle_delay_invalid")
    stopping = threading.Event()
    runtime = MageRuntime()

    def stop(_signal: int, _frame: object) -> None:
        stopping.set()
        runtime.cancel()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    client = WorkerClient(args.api_base_url, args.token_file)
    print(json.dumps({"event": "worker_started", "backend": "frames"}), flush=True)
    while not stopping.is_set():
        try:
            lease = client.lease(args.worker_id)
        except APIError as error:
            print(json.dumps({"event": "lease_failed", "code": error.code}), flush=True)
            if args.once:
                return 1
            stopping.wait(random.uniform(args.idle_min, args.idle_max))
            continue
        if lease is None:
            if args.once:
                return 0
            stopping.wait(random.uniform(args.idle_min, args.idle_max))
            continue
        run_one_job(client, runtime, lease, args.work_dir)
        print(json.dumps({"event": "job_finished", "kind": lease.kind}), flush=True)
        if args.once:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
