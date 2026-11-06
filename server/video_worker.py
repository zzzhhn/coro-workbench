from pathlib import Path
import logging
import sys

from .storage import Cancelled, JobStatus
from .video import encode

if __name__ == "__main__":
    directory = Path(sys.argv[1])
    try:
        encode(directory)
    except Cancelled:
        pass
    except Exception as error:
        logging.exception("Video export failed")
        JobStatus(directory).fail(str(error) if isinstance(error, ValueError) else "视频导出失败，请检查本地日志。")
