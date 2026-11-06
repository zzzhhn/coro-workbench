from __future__ import annotations

import logging
import sys

from .config import DATA_DIR
from .storage import JOB_ID, Cancelled, JobStatus, read_json


def main() -> int:
    if len(sys.argv) != 2 or not JOB_ID.fullmatch(sys.argv[1]):
        return 2
    directory = DATA_DIR / sys.argv[1]
    status = JobStatus(directory)
    try:
        status.check_cancelled()
        request = read_json(directory / "request.json")
        if request.get("action") == "vocal-rebuild":
            from .vocal_rebuild import rebuild_vocals
            project = rebuild_vocals(directory, request, status)
        else:
            from .pipeline import analyze_audio
            project = analyze_audio(directory, request, status)
        status.finish(project)
        return 0
    except Cancelled:
        return 0
    except ValueError as error:
        logging.exception("Audio analysis rejected")
        status.fail(str(error))
    except Exception:
        logging.exception("Local audio analysis failed")
        status.fail("本地分析失败。请尝试更短、更清晰的音频；错误详情保存在 data 目录的 worker.log。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
