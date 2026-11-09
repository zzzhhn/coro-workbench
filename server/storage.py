from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

JOB_ID = re.compile(r"^[a-f0-9]{32}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, value: dict) -> None:
    temp = path.with_suffix(f".tmp-{os.getpid()}")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, allow_nan=False)
    temp.replace(path)


def read_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


class Cancelled(Exception):
    pass


class JobStatus:
    def __init__(self, directory: Path):
        self.directory = directory
        self.path = directory / "status.json"
        self.cancel_path = directory / "cancelled"

    def check_cancelled(self) -> None:
        if self.cancel_path.exists():
            raise Cancelled()

    def update(self, progress: int, stage: str, message: str, **extra: object) -> None:
        self.check_cancelled()
        current = read_json(self.path)
        current.update(status="running", progress=progress, stage=stage, message=message, updatedAt=utc_now(), **extra)
        atomic_json(self.path, current)

    def waiting(self, message: str) -> None:
        """Keep a queued job queued while it waits for the machine-wide lock."""
        self.check_cancelled()
        current = read_json(self.path)
        current.update(stage="queued", message=message, updatedAt=utc_now())
        atomic_json(self.path, current)

    def finish(self, project: dict) -> None:
        self.check_cancelled()
        current = read_json(self.path)
        current.update(status="complete", progress=100, stage="complete", message="分析完成，请校对节拍、音高和乐器候选。", project=project, updatedAt=utc_now())
        atomic_json(self.path, current)

    def fail(self, message: str) -> None:
        if self.cancel_path.exists():
            return
        current = read_json(self.path)
        current.update(status="error", stage="error", message=message, error=message, updatedAt=utc_now())
        atomic_json(self.path, current)

    def read(self) -> dict:
        current = read_json(self.path)
        if self.cancel_path.exists():
            current.update(status="cancelled", stage="cancelled", message="分析已取消。已上传的原始音频仍保留在本机。")
            current.pop("project", None)
        return current
