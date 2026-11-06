from __future__ import annotations

import logging
import sys

from . import config
from .omr import OmrStatus, recognize
from .storage import Cancelled, JOB_ID, read_json


def main() -> None:
    if len(sys.argv) != 2 or not JOB_ID.fullmatch(sys.argv[1]):
        raise SystemExit("Invalid OMR job ID")
    directory = config.DATA_DIR / "omr" / sys.argv[1]
    try:
        recognize(directory, read_json(directory / "request.json"))
    except Cancelled:
        pass
    except ValueError as error:
        logging.exception("OMR validation or recognition failed")
        OmrStatus(directory).fail(str(error))
    except Exception:
        logging.exception("Unexpected local OMR failure")
        OmrStatus(directory).fail("光学识谱失败。请提供更清晰的印刷谱或减少页数；诊断日志保存在本机。")


if __name__ == "__main__":
    main()
