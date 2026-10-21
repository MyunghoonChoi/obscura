"""Runs one kohya training command detached from the dashboard and records how it ended.

Usage: python run_training.py <run_dir>

Reads <run_dir>/command.json  {"cwd": str, "args": [str, ...]}
Writes <run_dir>/train.log    combined stdout/stderr of the trainer (tqdm progress included)
       <run_dir>/exit.json    {"exitCode": int, "finishedAt": ms} once the trainer exits

The dashboard spawns this wrapper instead of the trainer itself so the exit code survives
a dashboard restart: Next.js only has to read files to know what happened.
"""

import json
import os
import subprocess
import sys
import time


def main() -> int:
    run_dir = sys.argv[1]
    with open(os.path.join(run_dir, "command.json"), encoding="utf-8") as f:
        cmd = json.load(f)

    # UTF-8 everywhere: kohya logs Japanese text, which crashes on non-UTF-8 Windows code pages (e.g. cp949).
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    with open(os.path.join(run_dir, "train.log"), "wb", buffering=0) as log:
        try:
            proc = subprocess.Popen(cmd["args"], cwd=cmd["cwd"], stdout=log, stderr=subprocess.STDOUT, env=env)
            code = proc.wait()
        except Exception as e:  # e.g. the trainer's python is missing
            log.write(f"\nFailed to start trainer: {e}\n".encode())
            code = -1

    with open(os.path.join(run_dir, "exit.json"), "w", encoding="utf-8") as f:
        json.dump({"exitCode": code, "finishedAt": int(time.time() * 1000)}, f)
    return code


if __name__ == "__main__":
    sys.exit(main())
