from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import hashlib
import importlib.util
import json
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
import warnings as python_warnings
from contextlib import asynccontextmanager
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from . import config
from .storage import Cancelled, JOB_ID, JobStatus, atomic_json, read_json, utc_now

VERSION = "5.11.0"
SUPPORTED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_PAGES = 12
MAX_INPUT_PAGES = 200
MAX_IMAGE_PIXELS = 35_000_000
MAX_PAGE_EDGE = 3500
MAX_XML_BYTES = 20 * 1024 * 1024
MAX_PENDING = 3
RETRY_TARGET_INTERLINE = 20
MAX_RETRY_SCALE = 3.0
MAX_RETRY_TOTAL_PIXELS = 100_000_000


def omr_home() -> Path:
    return config.MODELS_DIR / "omr"


def homr_home() -> Path:
    return omr_home() / "homr"


ENGINES = ("auto", "homr", "audiveris")


def audiveris_ready() -> bool:
    home = omr_home()
    app = home / "Audiveris.app" / "Contents"
    return all(path.is_file() for path in (
        app / "runtime" / "Contents" / "Home" / "bin" / "java",
        app / "app" / "audiveris.jar",
        home / "tessdata" / "eng.traineddata",
        home / "verified-install.json",
    ))


def homr_manifest() -> dict | None:
    path = homr_home() / "verified-install.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    source = homr_home() / "src"
    if not (source / ".venv" / "bin" / "homr").is_file():
        return None
    if not all((source / relative).is_file() for relative in manifest.get("weights", {})):
        return None
    return manifest


def resolve_engine(requested: str) -> str:
    if requested not in ENGINES:
        raise ValueError("未知识谱引擎。")
    if requested == "auto":
        return "homr" if homr_manifest() else "audiveris"
    return requested


def omr_health() -> dict:
    dependencies = all(importlib.util.find_spec(name) is not None for name in ("PIL", "pypdf"))
    pdf = bool(config.binary("pdftoppm"))
    homr = homr_manifest()
    engines = {
        "homr": {"ready": bool(homr), "version": homr and homr.get("version"), "license": "AGPL-3.0"},
        "audiveris": {"ready": audiveris_ready(), "version": VERSION, "license": "AGPL-3.0"},
    }
    ready = dependencies and pdf and any(engine["ready"] for engine in engines.values())
    default = "homr" if homr else "audiveris"
    return {
        "ready": ready,
        "version": engines[default]["version"],
        "engine": "homr" if default == "homr" else "Audiveris",
        "defaultEngine": default,
        "engines": engines,
        "runtime": "separate local CPU process",
        "license": "AGPL-3.0",
        "formats": sorted(extension[1:] for extension in SUPPORTED_EXTENSIONS),
        "maxPages": MAX_PAGES,
        "maxUploadMB": MAX_UPLOAD_BYTES // 1024 // 1024,
        "note": "Optical music recognition is fallible. Review pitches, rhythm, meter and parts before rehearsal.",
    }


class OmrStatus(JobStatus):
    def read(self) -> dict:
        current = super().read()
        if current["status"] == "cancelled":
            current["message"] = "识谱已取消，原始谱页仍保留在本机。"
            for key in ("musicxml", "downloadUrl", "pages", "pageUrls"):
                current.pop(key, None)
        return current


def _run(command: list[str], timeout: int = 90) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(command, capture_output=True, timeout=timeout, check=True)
    except subprocess.TimeoutExpired as error:
        raise ValueError("谱页预处理超时，请裁剪页面或降低图片分辨率后重试。") from error
    except subprocess.CalledProcessError as error:
        raise ValueError("无法读取这份谱页。请确认文件未损坏、无密码且没有外部引用。") from error


def _save_page(image, path: Path) -> None:
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(image)
    if image.width * image.height > MAX_IMAGE_PIXELS:
        raise ValueError("单页图片超过 3500 万像素，请降低分辨率。")
    if min(image.size) < 160 or max(image.size) < 400:
        raise ValueError("图片过小，无法稳定识别五线谱；建议整页至少 1200 像素宽。")
    if image.mode in {"RGBA", "LA", "P"}:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        background.alpha_composite(rgba)
        image = background.convert("RGB")
    image = ImageOps.grayscale(image)
    if max(image.size) > MAX_PAGE_EDGE:
        image.thumbnail((MAX_PAGE_EDGE, MAX_PAGE_EDGE), Image.Resampling.LANCZOS)
    # DPI metadata does not add detail. Low interline recovery, if needed, is a
    # separate evidence-triggered retry that never overwrites this source preview.
    image.save(path, format="PNG", dpi=(300, 300))


def prepare_pages(directory: Path, request: dict, status: OmrStatus) -> tuple[list[Path], int, list[str]]:
    from PIL import Image

    source = directory / request["input"]
    first_page, last_page = request.get("first_page", 1), request.get("last_page")
    notices = []
    page_dir = directory / "pages"
    page_dir.mkdir(exist_ok=True)
    status.update(4, "preparing", "正在本机读取谱页并检查尺寸。")
    if source.suffix.lower() == ".pdf":
        from pypdf import PdfReader

        try:
            reader = PdfReader(source, strict=True)
            if reader.is_encrypted:
                raise ValueError("PDF 有密码保护，请提供已解密且有权使用的谱页。")
            count = len(reader.pages)
        except (ValueError, Cancelled):
            raise
        except Exception as error:
            raise ValueError("PDF 已损坏或无法解析，请重新导出 PDF。") from error
        if count < 1 or count > MAX_INPUT_PAGES:
            raise ValueError("PDF 需包含 1–200 页；每次最多识别 12 页。")
        end = count if last_page is None else last_page
        _check_page_selection(first_page, end, count)
        for index, page in enumerate(reader.pages):
            if index + 1 < first_page or index + 1 > end:
                continue
            width, height = float(page.mediabox.width), float(page.mediabox.height)
            if not (36 <= width <= 14400 and 36 <= height <= 14400):
                raise ValueError("PDF 页面尺寸异常，请重新导出标准纸张大小。")
            status.check_cancelled()
            prefix = page_dir / f"page-{index + 1:03d}"
            binary = config.binary("pdftoppm")
            if not binary:
                raise ValueError("PDF 渲染器未安装，请运行 scripts/setup-omr.sh。")
            _run([binary, "-f", str(index + 1), "-l", str(index + 1), "-singlefile", "-scale-to", str(MAX_PAGE_EDGE), "-gray", "-png", str(source), str(prefix)])
            with Image.open(prefix.with_suffix(".png")) as image:
                normalized = image.copy()
            _save_page(normalized, prefix.with_suffix(".png"))
        if first_page != 1 or end != count:
            notices.append(f"本次仅识别第 {first_page}–{end} 页，原文件共有 {count} 页；其余页面未被自动加入乐谱。")
    else:
        try:
            with python_warnings.catch_warnings():
                python_warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(source) as image:
                    count = getattr(image, "n_frames", 1)
                    if count < 1 or count > MAX_INPUT_PAGES:
                        raise ValueError("图片容器最多支持 200 页，每次识别最多 12 页。")
                    end = count if last_page is None else last_page
                    _check_page_selection(first_page, end, count)
                    for page in range(first_page, end + 1):
                        status.check_cancelled()
                        image.seek(page - 1)
                        if image.width * image.height > MAX_IMAGE_PIXELS:
                            raise ValueError("单页图片超过 3500 万像素，请降低分辨率。")
                        _save_page(image.copy(), page_dir / f"page-{page:03d}.png")
        except (ValueError, Cancelled):
            raise
        except Exception as error:
            raise ValueError("图片损坏、分辨率过大或格式不受支持，请使用清晰的 PNG / JPEG / TIFF 谱页。") from error
        if first_page != 1 or end != count:
            notices.append(f"本次仅识别第 {first_page}–{end} 页，原图片容器共有 {count} 页。")
    pages = sorted(page_dir.glob("page-*.png"))
    if not pages:
        raise ValueError("未读取到任何谱页。")
    _write_tiff(pages, directory / "score.tiff", status)
    return pages, count, notices


def _write_tiff(pages: list[Path], destination: Path, status: OmrStatus) -> None:
    from PIL import Image

    images = []
    try:
        for path in pages:
            status.check_cancelled()
            with Image.open(path) as image:
                images.append(image.copy())
        status.check_cancelled()
        images[0].save(destination, format="TIFF", save_all=True, append_images=images[1:], compression="tiff_deflate", dpi=(300, 300))
    finally:
        for image in images:
            image.close()


def low_interline_pages(logs: str, page_count: int) -> dict[int, int]:
    """Read the engine's rejection, not guessed DPI or a filename heuristic."""
    current_page = 1 if page_count == 1 else None
    values = {}
    for line in logs.splitlines():
        page = re.search(r"\[[^\]\s]+#(\d+)\]", line)
        if page:
            current_page = int(page.group(1))
        rejected = re.search(r"With a too low interline value of (\d+) pixels", line)
        if rejected:
            if current_page is None or not 1 <= current_page <= page_count:
                raise ValueError("识谱检测到谱线像素过低，但无法确定页码。请分页面导入或提供 300 DPI 原谱。")
            values[current_page] = int(rejected.group(1))
    return values


def retry_dimensions(width: int, height: int, interline: int) -> tuple[int, int, float]:
    if interline < 4 or interline > 11:
        raise ValueError(f"谱线间距仅 {interline} 像素，细节不足以安全恢复；请使用 300 DPI 扫描或原始 PDF，而不是继续放大缩略图。")
    scale = min(RETRY_TARGET_INTERLINE / interline, MAX_RETRY_SCALE, MAX_PAGE_EDGE / max(width, height), math.sqrt(MAX_IMAGE_PIXELS / (width * height)))
    # Audiveris needs actual pixel spacing, not a higher number in the DPI tag.
    if scale < 1.25 or interline * scale < 12:
        raise ValueError(f"谱线间距仅 {interline} 像素，受安全尺寸限制无法充分放大。请裁剪空白边缘、分页面导入或使用更清晰的 300 DPI 原谱。")
    return max(1, math.floor(width * scale)), max(1, math.floor(height * scale)), scale


def resample_low_interline_pages(directory: Path, pages: list[Path], interlines: dict[int, int], status: OmrStatus) -> tuple[Path, list[dict]]:
    from PIL import Image

    retry_dir = directory / "resampled-pages"
    retry_dir.mkdir(exist_ok=True)
    planned = []
    total_pixels = 0
    for index, path in enumerate(pages, 1):
        status.check_cancelled()
        with Image.open(path) as image:
            width, height = image.size
        if index in interlines:
            target_width, target_height, scale = retry_dimensions(width, height, interlines[index])
        else:
            target_width, target_height, scale = width, height, 1.0
        total_pixels += target_width * target_height
        planned.append({"page": index, "interlinePixels": interlines.get(index), "sourceSize": [width, height], "targetSize": [target_width, target_height], "scale": round(scale, 4), "resampled": index in interlines})
    if total_pixels > MAX_RETRY_TOTAL_PIXELS:
        raise ValueError("低分辨率重试将超过像素内存上限，请减少一次导入的页数。")
    inputs = []
    for path, item in zip(pages, planned):
        status.check_cancelled()
        if not item["resampled"]:
            inputs.append(path)
            continue
        with Image.open(path) as image:
            resized = image.convert("L").resize(tuple(item["targetSize"]), Image.Resampling.LANCZOS)
            target = retry_dir / path.name
            resized.save(target, format="PNG", dpi=(300, 300))
            resized.close()
        inputs.append(target)
    status.check_cancelled()
    retry_input = directory / "score-retry.tiff"
    _write_tiff(inputs, retry_input, status)
    atomic_json(directory / "resampling-evidence.json", {"trigger": "Audiveris too-low-interline rejection", "algorithm": "Pillow LANCZOS grayscale resize", "attemptsAllowed": 1, "sourcePreviewsPreserved": True, "totalPixels": total_pixels, "pages": planned})
    return retry_input, planned


def _check_page_selection(first: int, last: int, count: int) -> None:
    if not 1 <= first <= last <= count:
        raise ValueError(f"页码范围无效，这份文件共有 {count} 页。")
    if last - first + 1 > MAX_PAGES:
        raise ValueError("每次最多识别 12 页，请选择较小的页码范围。")


def read_musicxml(path: Path) -> str:
    if path.stat().st_size > MAX_XML_BYTES:
        raise ValueError("识别结果过大，请减少页数后重试。")
    if path.suffix.lower() != ".mxl":
        data = path.read_bytes()
    else:
        try:
            with ZipFile(path) as archive:
                items = archive.infolist()
                if len(items) > 100 or sum(item.file_size for item in items) > MAX_XML_BYTES:
                    raise ValueError("识别生成的压缩谱超过安全大小限制。")
                for item in items:
                    if item.filename.startswith(("/", "\\")) or ".." in Path(item.filename).parts:
                        raise ValueError("识别结果包含不安全路径。")
                candidates = [item.filename for item in items if item.filename.lower().endswith((".xml", ".musicxml")) and not item.filename.startswith("META-INF/")]
                if len(candidates) != 1:
                    raise ValueError("识谱结果含多个独立乐章，暂不自动拼接。请逐页或逐乐章导入。")
                data = archive.read(candidates[0])
        except BadZipFile as error:
            raise ValueError("识谱引擎生成的 MusicXML 压缩文件损坏。") from error
    if re.search(br"<!ENTITY\b", data, re.I) or re.search(br"<!DOCTYPE[^>]*\[", data, re.I):
        raise ValueError("识别结果包含不安全 XML 实体。")
    try:
        xml = data.decode("utf-8-sig")
        root = ET.fromstring(xml)
    except (UnicodeError, ET.ParseError) as error:
        raise ValueError("识别结果不是有效的 MusicXML。") from error
    if root.tag != "score-partwise":
        raise ValueError("识别结果不是受支持的分声部 MusicXML。")
    if not root.findall(".//note/pitch") and not root.findall(".//note/unpitched"):
        raise ValueError("没有识别到可播放的音符。请裁剪到乐谱区域、提高分辨率或使用更清晰的印刷谱。")
    return xml


def summarize_musicxml(xml: str, pages: int, logs: str, read_text: bool, engine: str = "audiveris", text_layer: bool = False) -> tuple[dict, list[str]]:
    root = ET.fromstring(xml)
    pitched = len(root.findall(".//note/pitch"))
    percussion = len(root.findall(".//note/unpitched"))
    parts = root.findall("part")
    notices = [
        "此结果来自本地光学识谱，可能误读音高、时值、连线、调号与声部。请逐页对照原谱校对后再排练。",
        "图片只提供印刷记号；识谱模型没有提供校准准确率，不能把成功导入当成识别无误。",
    ]
    if engine == "homr":
        if not text_layer:
            notices.append("未启用文字层：homr 本身不读取歌词、和弦符号和声部名称，这些需要手动补填。")
    elif not read_text:
        notices.append("为避免文字误识别造成声部串接，默认不启用歌词/标题 OCR；声部名称和歌词可能需要手动填写。")
    else:
        notices.append("文字 OCR 为实验选项，复杂歌词和中文标题可能错读；错误的声部文字也可能影响跨系统合并。")
    if not root.findall(".//time"):
        notices.append("未识别到明确拍号，导入器暂以 4/4 建谱；请先核对原谱拍号，避免节拍误读。")
    if not any(direction.get("tempo") for direction in root.findall(".//sound")):
        notices.append("未识别到明确速度，播放使用导入默认 BPM；请按原谱指定速度。")
    if root.findall(".//unpitched"):
        notices.append("无固定音高打击乐的鼓件映射可能不完整，需要对照原谱检查。")
    rhythm = len(re.findall(r"(?i)(?:no target duration|not enough time|excessive time|voice.*?too long|unmatched|rhythm.*?error)", logs))
    warning_count = len(re.findall(r"(?m)^WARN\s", logs))
    if rhythm:
        notices.append(f"识谱引擎记录了 {rhythm} 条节奏/连接警告，请重点校对小节时值和跨页长音。")
    if len(parts) > 16:
        notices.append("识别出的声部数较多，可能存在 OCR 拆分或跨系统连接问题；请尝试关闭文字 OCR 或分页面导入。")
    return {"pages": pages, "parts": len(parts), "pitchedNotes": pitched, "unpitchedNotes": percussion, "noteElements": len(root.findall(".//note")), "measures": max((len(part.findall("measure")) for part in parts), default=0), "engineWarnings": warning_count, "rhythmWarnings": rhythm}, notices


def _recognition_attempt(directory: Path, input_path: Path, output: Path, log_path: Path, page_count: int, read_text: bool, status: OmrStatus, progress_floor: int = 18) -> tuple[int, str]:
    output.mkdir(exist_ok=True)
    local_home = directory / "runtime-home"
    local_home.mkdir(exist_ok=True)
    app = omr_home() / "Audiveris.app" / "Contents"
    java = app / "runtime" / "Contents" / "Home" / "bin" / "java"
    classpath = f"{app / 'app' / 'audiveris.jar'}{os.pathsep}{app / 'app' / '*'}"
    command = [str(java), "-Djava.awt.headless=true", f"-Duser.home={local_home}", "-Dfile.encoding=UTF-8", "-Djava.net.useSystemProxies=false", "-Dhttp.proxyHost=127.0.0.1", "-Dhttp.proxyPort=9", "-Dhttps.proxyHost=127.0.0.1", "-Dhttps.proxyPort=9", "--enable-native-access=ALL-UNNAMED", "--add-exports=java.desktop/sun.awt.image=ALL-UNNAMED", "-XX:ActiveProcessorCount=4", "-Xms256m", "-Xmx4g", "-cp", classpath, "Audiveris", "-batch", "-transcribe", "-export", "-constant", f"org.audiveris.omr.text.tesseract.TesseractOCR.useOCR={str(read_text).lower()}", "-output", str(output), "--", str(input_path)]
    env = dict(os.environ, HOME=str(local_home), TESSDATA_PREFIX=str(omr_home() / "tessdata"), OMP_NUM_THREADS="2")
    status.check_cancelled()
    with log_path.open("wb") as log:
        process = subprocess.Popen(command, cwd=directory, env=env, stdout=log, stderr=log)
        deadline = time.monotonic() + 120 + page_count * 90
        last_stage = ""
        highest_progress = progress_floor
        while process.poll() is None:
            try:
                status.check_cancelled()
                if time.monotonic() > deadline:
                    raise ValueError("光学识谱超时，请缩小页数或裁剪谱页后重试。")
                text = log_path.read_text(encoding="utf-8", errors="replace")[-25000:]
                steps = re.findall(r"StepMonitoring\s+\d+\s+\|\s+(\w+)", text)
                completed_pages = len(re.findall(r"End of Stub#", text))
                sheet_numbers = [int(number) for number in re.findall(r"\[[^\]\s]+#(\d+)\]", text)]
                page_number = min(page_count, max(sheet_numbers, default=completed_pages + 1))
                current_stage = steps[-1] if steps else "LOAD"
                if current_stage != last_stage:
                    progress = min(85, progress_floor + int((page_number - 1) / max(1, page_count) * (85 - progress_floor)))
                    highest_progress = max(highest_progress, progress)
                    label = {"GRID": "识别谱线与声部", "HEADERS": "识别谱号、拍号与调号", "HEADS": "识别音头", "STEMS": "识别符干", "BEAMS": "识别符杠", "TEXTS": "读取谱面文字", "RHYTHMS": "还原小节节奏", "PAGE": "连接系统与页面"}.get(current_stage, "识别音乐符号")
                    status.update(highest_progress, "recognizing", f"{label}（第 {min(page_number, page_count)}/{page_count} 页）。", pages=page_count)
                    last_stage = current_stage
                time.sleep(0.3)
            except BaseException:
                process.kill()
                process.wait(timeout=10)
                raise
        code = process.returncode
    logs = log_path.read_text(encoding="utf-8", errors="replace")
    return code, logs


HOMR_MERGE = """
import sys
import xml.etree.ElementTree as ET
from homr.relieur import process_concat
merged, _, _ = process_concat(sys.argv[2:])
ET.ElementTree(merged).write(sys.argv[1], encoding="UTF-8", xml_declaration=True)
"""


def _homr_env(local_home: Path) -> dict:
    # Same isolation as Audiveris: private HOME, unreachable proxies, so the
    # recognizer cannot fetch models or send page images anywhere at runtime.
    blocked = "http://127.0.0.1:9"
    return dict(os.environ, HOME=str(local_home), HTTP_PROXY=blocked, HTTPS_PROXY=blocked, http_proxy=blocked, https_proxy=blocked, NO_PROXY="", OMP_NUM_THREADS="4", PYTHONUNBUFFERED="1")


def _run_logged(command: list[str], cwd: Path, env: dict, log_path: Path, deadline: float, status: OmrStatus, on_log=None) -> int:
    with log_path.open("ab") as log:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=log)
        while process.poll() is None:
            try:
                status.check_cancelled()
                if time.monotonic() > deadline:
                    raise ValueError("光学识谱超时，请缩小页数或裁剪谱页后重试。")
                if on_log:
                    on_log(log_path.read_text(encoding="utf-8", errors="replace")[-25000:])
                time.sleep(0.3)
            except BaseException:
                process.kill()
                process.wait(timeout=10)
                raise
        return process.returncode


def _homr_attempt(directory: Path, pages: list[Path], status: OmrStatus, text_source: Path | None = None, text_layer: bool = False) -> tuple[Path | None, list[str], dict]:
    """Run homr once over the normalized pages; keep every page's raw MusicXML.

    With text_layer, each page also gets lyrics, chord symbols and part names
    (server/omr_text.py) in a separate *.text.musicxml; raw pages stay as homr wrote them.
    """
    source = homr_home() / "src"
    work = directory / "recognized-homr"
    work.mkdir(exist_ok=True)
    local_home = directory / "runtime-home"
    local_home.mkdir(exist_ok=True)
    inputs = []
    for page in pages:
        target = work / page.name
        target.write_bytes(page.read_bytes())
        inputs.append(target)
    log_path = directory / "omr-homr.log"
    deadline = time.monotonic() + 120 + len(pages) * 90
    count = len(pages)

    def progress(text: str) -> None:
        done = len(re.findall(r"(?m)^Finished ", text))
        status.update(min(85, 18 + int(done / count * 62)), "recognizing", f"识别谱表、音符与节奏（第 {min(done + 1, count)}/{count} 页）。", pages=count)

    # A directory run loads the models once and writes one MusicXML per page;
    # pages are merged afterwards so the per-page raw output stays inspectable.
    code = _run_logged([str(source / ".venv" / "bin" / "homr"), "--no-title", "--write-staff-positions", str(work)], source, _homr_env(local_home), log_path, deadline, status, progress)
    page_xml = [work / (page.stem + ".musicxml") for page in inputs]
    missing = [index + 1 for index, path in enumerate(page_xml) if not path.is_file()]
    stats = {"engineExit": code, "pagesMissing": missing}
    if missing:
        return None, [], stats
    notices = []
    counts = []
    for path in page_xml:
        root = ET.fromstring(path.read_bytes())
        counts.append(len(root.findall("part")))
    stats["partsPerPage"] = counts
    if len(set(counts)) > 1:
        # homr's page merge pairs parts by order; different counts would drop or
        # misplace music, so name the pages instead of merging silently.
        detail = "、".join(f"第 {index + 1} 页 {value} 个" for index, value in enumerate(counts))
        notices.append(f"各页识别出的声部数不一致（{detail}）。跨页合并按声部顺序对应，多出或缺少的声部可能错位或丢失；请逐页核对，必要时分页导入。")
    if text_layer:
        status.update(85, "reading-text", "读取歌词、和弦符号与声部名，并按音符位置对齐。", pages=count)
        page_xml, text_stats, text_notices = _homr_text_layer(directory, work, inputs, page_xml, text_source, status)
        stats["text"] = text_stats
        notices.extend(text_notices)
    if len(page_xml) == 1:
        return page_xml[0], notices, stats
    merged = work / "merged.musicxml"
    status.update(86, "merging", "按页顺序连接各页小节与声部。", pages=count)
    _run_logged([str(source / ".venv" / "bin" / "python"), "-c", HOMR_MERGE, str(merged), *map(str, page_xml)], source, _homr_env(local_home), log_path, time.monotonic() + 120, status)
    return (merged if merged.is_file() else None), notices, stats


def _homr_text_layer(directory: Path, work: Path, inputs: list[Path], page_xml: list[Path], text_source: Path | None, status: OmrStatus) -> tuple[list[Path], dict, list[str]]:
    """Add the text layer page by page. A page that fails keeps its raw homr notes."""
    from PIL import Image

    from .omr_text import TextBox, apply_text_layer, note_signature

    source = homr_home() / "src"
    extractor = Path(__file__).with_name("omr_text_extract.py")
    out_paths, evidence, notices = [], [], []
    totals = {"lyrics": 0, "chords": 0, "sections": 0, "pagesSkipped": [], "sources": []}
    for index, (image, raw_path) in enumerate(zip(inputs, page_xml), 1):
        status.check_cancelled()
        staves = image.with_suffix(".txt")
        args = [str(source / ".venv" / "bin" / "python"), str(extractor), str(image)]
        page_number = int(re.search(r"(\d+)$", image.stem).group(1)) if re.search(r"(\d+)$", image.stem) else index
        if text_source is not None and text_source.suffix.lower() == ".pdf":
            args += [str(text_source), str(page_number)]
        result = subprocess.run(args, cwd=source, env=_homr_env(directory / "runtime-home"), capture_output=True, text=True, timeout=180)
        try:
            data = json.loads(result.stdout) if result.returncode == 0 else None
        except ValueError:
            data = None
        raw = raw_path.read_text(encoding="utf-8")
        if data is None or not staves.is_file():
            totals["pagesSkipped"].append(index)
            evidence.append({"page": index, "skipped": "文字提取失败" if data is None else "缺少谱表坐标"})
            out_paths.append(raw_path)
            continue
        with Image.open(image) as page:
            size = page.size
        boxes = [TextBox(b["text"], tuple(b["box"]), b.get("conf", 1.0), data["source"], b.get("chars")) for b in data["boxes"]]
        new, page_evidence = apply_text_layer(raw, staves.read_text(), size, boxes, crop=tuple(data["crop"]))
        if note_signature(raw) != note_signature(new):
            # The layer may only add text. Never ship a page whose notes moved.
            page_evidence = {"skipped": "文字层改变了音符，已丢弃该页文字"}
            new = raw
        target = raw_path.with_suffix(".text.musicxml")
        target.write_text(new, encoding="utf-8")
        out_paths.append(target)
        page_evidence["page"] = index
        page_evidence["textSource"] = data["source"]
        evidence.append(page_evidence)
        if page_evidence.get("skipped"):
            totals["pagesSkipped"].append(index)
        for key in ("lyrics", "chords", "sections"):
            totals[key] += page_evidence.get(key, 0)
        totals["sources"].append(data["source"])
    atomic_json(directory / "text-evidence.json", {"rules": "PROTOCOL-text v6", "pages": evidence})
    totals["sources"] = sorted(set(totals["sources"]))
    if totals["lyrics"] or totals["chords"]:
        origin = "PDF 自带文字" if totals["sources"] == ["pdf-text"] else "本机文字识别（RapidOCR）"
        notices.append(f"已从{origin}按音符位置贴回 {totals['lyrics']} 个歌词音节、{totals['chords']} 个和弦符号。拍照/扫描的歌词可能读错字、错位或把演奏术语当成歌词，请逐句校对；原始 homr 音符没有被改动。")
    if totals["pagesSkipped"]:
        notices.append(f"第 {'、'.join(map(str, totals['pagesSkipped']))} 页未能贴回文字（版面无法对应到谱表），这些页只有音符。")
    return out_paths, totals, notices

def _audiveris_attempt(directory: Path, pages: list[Path], read_text: bool, status: OmrStatus, notices: list[str]) -> tuple[Path, str, int, list]:
    output = directory / "recognized"
    code, logs = _recognition_attempt(directory, directory / "score.tiff", output, directory / "omr.log", len(pages), read_text, status)
    rejected_pages = low_interline_pages(logs, len(pages))
    resampling = []
    if rejected_pages:
        progress = max(20, min(85, int(status.read().get("progress", 20))))
        status.update(progress, "resampling", "检测到谱线像素间距过低，正在对受影响页执行一次有界重采样；原谱预览保留。")
        retry_input, resampling = resample_low_interline_pages(directory, pages, rejected_pages, status)
        output = directory / "recognized-retry"
        code, logs = _recognition_attempt(directory, retry_input, output, directory / "omr-retry.log", len(pages), read_text, status, progress_floor=progress)
        if low_interline_pages(logs, len(pages)):
            raise ValueError("有界放大后谱线仍无法可靠识别，未继续重复重试。请提供 300 DPI 扫描或原始 PDF；原始图片没有被修改。")
        for item in resampling:
            if item["resampled"]:
                notices.append(f"第 {item['page']} 页原谱线间距仅 {item['interlinePixels']} 像素，已对识谱副本进行一次 {item['scale']:g} 倍 Lanczos 重采样；未生成新符号，原图与预览保持不变。放大不能恢复缺失细节，结果仍需校对。")
    outputs = sorted(output.glob("*.mxl"))
    if not outputs:
        if resampling:
            raise ValueError("低像素谱页已执行一次有界放大，但仍未生成可播放乐谱。请使用原始 PDF 或更清晰的 300 DPI 扫描，原始图片保持不变。")
        raise ValueError("未能识别出完整可播放乐谱。请提供清晰、平整、未裁断谱线的印刷谱；手写谱暂不保证识别。")
    if len(outputs) != 1:
        raise ValueError("识谱结果包含多个独立乐章，请分页面或逐乐章导入，避免错误拼接。")
    return outputs[0], logs, code, resampling


def recognize(directory: Path, request: dict) -> None:
    status = OmrStatus(directory)
    started = time.monotonic()
    if not omr_health()["ready"]:
        raise ValueError("本地光学识谱引擎未就绪，请运行 scripts/setup-omr-homr.sh 或 scripts/setup-omr.sh。")
    requested = request.get("engine", "audiveris")
    engine = resolve_engine(requested)
    if engine == "homr" and not homr_manifest():
        raise ValueError("homr 识谱引擎未安装，请运行 scripts/setup-omr-homr.sh，或改选 Audiveris。")
    if engine == "audiveris" and not audiveris_ready():
        raise ValueError("Audiveris 未安装，请运行 scripts/setup-omr.sh，或改选 homr。")
    pages, total_pages, notices = prepare_pages(directory, request, status)
    read_text = bool(request.get("read_text", False))
    status.update(15, "recognizing", f"正在本机识别 {len(pages)} 页五线谱：谱线、音符、节奏和声部。", pages=len(pages))
    resampling, logs, code, engine_stats = [], "", 0, {}
    result_path = None
    if engine == "homr":
        text_layer = bool(request.get("text_layer", False))
        result_path, homr_notices, engine_stats = _homr_attempt(directory, pages, status, directory / request["input"], text_layer)
        logs = (directory / "omr-homr.log").read_text(encoding="utf-8", errors="replace") if (directory / "omr-homr.log").exists() else ""
        code = engine_stats.get("engineExit", 0)
        if result_path is None and requested == "auto" and audiveris_ready():
            # Only the automatic choice may fall back; both attempts stay on disk.
            missing = engine_stats.get("pagesMissing") or []
            notices.append(f"homr 未能完成{'第 ' + '、'.join(map(str, missing)) + ' 页' if missing else '合并'}，已改用 Audiveris 重新识别整份谱；两次原始输出均保留在本机。")
            engine = "audiveris"
        elif result_path is None:
            raise ValueError("homr 未能识别出完整可播放乐谱。请提供清晰、平整、未裁断谱线的印刷谱，或改选 Audiveris。")
        else:
            notices.extend(homr_notices)
    if engine == "audiveris":
        result_path, logs, code, resampling = _audiveris_attempt(directory, pages, read_text, status, notices)
    xml = read_musicxml(result_path)
    stats, recognition_notices = summarize_musicxml(xml, len(pages), logs, read_text, engine, engine == "homr" and bool(request.get("text_layer", False)))
    if engine == "homr" and engine_stats.get("partsPerPage"):
        stats["partsPerPage"] = "/".join(map(str, engine_stats["partsPerPage"]))
    if engine == "homr" and engine_stats.get("text"):
        stats["textLyrics"] = engine_stats["text"]["lyrics"]
        stats["textChords"] = engine_stats["text"]["chords"]
    notices.extend(recognition_notices)
    if code != 0:
        notices.append("引擎部分处理步骤报错，但生成了可解析音符；当前结果为部分识别，请重点检查缺失页面和声部。")
    if not stats["pitchedNotes"] and not stats["unpitchedNotes"]:
        raise ValueError("未识别到可播放音符。")
    status.check_cancelled()
    (directory / "recognized.musicxml").write_text(xml, encoding="utf-8")
    label = f"homr {homr_manifest()['version']} local CPU OMR" if engine == "homr" else f"Audiveris {VERSION} local CPU OMR"
    source = {"filename": request["filename"], "engine": label, "engineId": engine, "requestedEngine": requested, "sha256": hashlib.sha256((directory / request["input"]).read_bytes()).hexdigest(), "readText": read_text, "originalPages": total_pages}
    if resampling:
        source["resampling"] = resampling
    result = status.read()
    result.update(status="complete", progress=100, stage="complete", message="光学识谱完成，请对照原谱校对。", musicxml=xml, warnings=notices, pages=len(pages), source=source, downloadUrl=f"/api/omr/jobs/{request['id']}/musicxml", pageUrls=[f"/api/omr/jobs/{request['id']}/pages/{index + 1}" for index in range(len(pages))], statistics=stats, wallSeconds=round(time.monotonic() - started, 3), updatedAt=utc_now())
    atomic_json(directory / "result-evidence.json", {key: value for key, value in result.items() if key != "musicxml"})
    status.check_cancelled()
    atomic_json(directory / "status.json", result)


class OmrManager:
    def __init__(self, directory: Path):
        self.directory = directory / "omr"
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="coro-omr")
        self.lock = threading.Lock()
        self.futures = {}
        self.processes: dict[str, subprocess.Popen] = {}
        self.uploads = 0

    def recover(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for path in self.directory.glob("*/status.json"):
            try:
                state = read_json(path)
                if state["status"] in {"queued", "running"}:
                    OmrStatus(path.parent).fail("服务重启中断了识谱，请重新导入。原始谱页仍保留在本机。")
            except (OSError, ValueError, KeyError):
                continue

    def reserve(self) -> bool:
        with self.lock:
            active = self.uploads + sum(not future.done() for future in self.futures.values())
            if active >= MAX_PENDING:
                return False
            self.uploads += 1
            return True

    def release(self) -> None:
        with self.lock:
            self.uploads = max(0, self.uploads - 1)

    def submit(self, job_id: str) -> None:
        with self.lock:
            self.futures = {key: future for key, future in self.futures.items() if not future.done()}
            self.futures[job_id] = self.executor.submit(self._run, job_id)

    def _run(self, job_id: str) -> None:
        path = self.directory / job_id
        status = OmrStatus(path)
        if status.cancel_path.exists():
            return
        env = dict(os.environ, CORO_DATA_DIR=str(self.directory.parent), CORO_MODELS_DIR=str(config.MODELS_DIR))
        try:
            with (path / "worker.log").open("wb") as log:
                process = subprocess.Popen([sys.executable, "-m", "server.omr_worker", job_id], cwd=config.ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
                with self.lock:
                    self.processes[job_id] = process
                if status.cancel_path.exists():
                    self._terminate(process)
                code = process.wait()
            if status.read()["status"] not in {"complete", "error", "cancelled"}:
                status.fail(f"本地识谱进程退出（代码 {code}），请换用较少、较清晰的谱页。")
        except Exception:
            status.fail("无法启动光学识谱进程，请检查本地运行环境。")
        finally:
            with self.lock:
                self.processes.pop(job_id, None)

    @staticmethod
    def _terminate(process: subprocess.Popen) -> None:
        if process.poll() is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)

    def cancel(self, job_id: str) -> None:
        (self.directory / job_id / "cancelled").touch()
        with self.lock:
            future, process = self.futures.get(job_id), self.processes.get(job_id)
        if future:
            future.cancel()
        if process:
            self._terminate(process)

    def close(self) -> None:
        with self.lock:
            processes = list(self.processes.values())
        for process in processes:
            self._terminate(process)
        self.executor.shutdown(wait=False, cancel_futures=True)


def create_omr_router(data_dir: Path | None = None) -> APIRouter:
    manager = OmrManager(data_dir or config.DATA_DIR)

    @asynccontextmanager
    async def lifespan(_):
        manager.recover()
        yield
        manager.close()

    router = APIRouter(prefix="/api/omr", tags=["local-omr"], lifespan=lifespan)
    router.omr_manager = manager

    def job_directory(job_id: str) -> Path:
        if not JOB_ID.fullmatch(job_id):
            raise HTTPException(404, "找不到识谱任务。")
        path = manager.directory / job_id
        if not path.is_dir() or path.is_symlink() or not (path / "status.json").is_file():
            raise HTTPException(404, "找不到识谱任务。")
        return path

    @router.post("", status_code=202)
    async def upload(file: UploadFile = File(...), first_page: int = Form(1), last_page: int | None = Form(None), read_text: bool = Form(False), engine: str = Form("auto"), text_layer: bool = Form(False)):
        if engine not in ENGINES:
            raise HTTPException(422, "未知识谱引擎。")
        if first_page < 1 or first_page > MAX_INPUT_PAGES or last_page is not None and (last_page < first_page or last_page > MAX_INPUT_PAGES or last_page - first_page + 1 > MAX_PAGES):
            raise HTTPException(422, "页码范围无效；每次最多识别 12 页。")
        name = Path((file.filename or "score").replace("\\", "/")).name[:240]
        suffix = Path(name).suffix.lower()
        if suffix not in SUPPORTED_EXTENSIONS:
            raise HTTPException(415, "请选择 PDF、PNG、JPEG、TIFF、WebP 或 BMP 乐谱。")
        health = omr_health()
        if not health["ready"]:
            raise HTTPException(503, "本地光学识谱未安装，请运行 scripts/setup-omr-homr.sh 或 scripts/setup-omr.sh。")
        if engine != "auto" and not health["engines"][engine]["ready"]:
            raise HTTPException(503, f"所选识谱引擎 {engine} 未安装。")
        if not manager.reserve():
            raise HTTPException(429, "本机识谱队列已满，请等待或取消已有识谱任务。")
        job_id = uuid.uuid4().hex
        path = manager.directory / job_id
        try:
            path.mkdir(parents=True, mode=0o700)
        except OSError as error:
            manager.release()
            await file.close()
            raise HTTPException(507, "本机磁盘无法保存谱页，请检查空间与目录权限。") from error
        source = path / f"source{suffix}"
        try:
            size = 0
            with source.open("wb") as handle:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "谱页文件不能超过 50 MB。")
                    handle.write(chunk)
            if size < 32:
                raise HTTPException(422, "谱页文件为空或过短。")
            request = {"id": job_id, "filename": name, "input": source.name, "first_page": first_page, "last_page": last_page, "read_text": read_text, "engine": engine, "text_layer": text_layer}
            result = {"id": job_id, "status": "queued", "progress": 0, "stage": "queued", "message": "等待本地光学识谱。", "createdAt": utc_now(), "updatedAt": utc_now()}
            atomic_json(path / "request.json", request)
            atomic_json(path / "status.json", result)
            manager.submit(job_id)
            return result
        except HTTPException:
            source.unlink(missing_ok=True)
            if not list(path.iterdir()):
                path.rmdir()
            raise
        finally:
            manager.release()
            await file.close()

    @router.get("/health")
    def health():
        return omr_health()

    @router.get("/jobs/{job_id}")
    def job(job_id: str):
        return OmrStatus(job_directory(job_id)).read()

    @router.delete("/jobs/{job_id}")
    async def cancel(job_id: str):
        path = job_directory(job_id)
        if OmrStatus(path).read()["status"] in {"queued", "running"}:
            await asyncio.to_thread(manager.cancel, job_id)
        return OmrStatus(path).read()

    @router.get("/jobs/{job_id}/musicxml")
    def musicxml(job_id: str):
        path = job_directory(job_id)
        if OmrStatus(path).read()["status"] != "complete" or not (path / "recognized.musicxml").is_file():
            raise HTTPException(404, "可播放乐谱尚未生成。")
        return FileResponse(path / "recognized.musicxml", media_type="application/vnd.recordare.musicxml+xml", filename="recognized.musicxml")

    @router.get("/jobs/{job_id}/pages/{page}")
    def page_image(job_id: str, page: int):
        path = job_directory(job_id)
        state = OmrStatus(path).read()
        images = sorted((path / "pages").glob("page-*.png"))
        if state["status"] == "cancelled" or not 1 <= page <= min(len(images), MAX_PAGES):
            raise HTTPException(404, "找不到这张谱页。")
        image = images[page - 1]
        if image.is_symlink():
            raise HTTPException(404, "找不到这张谱页。")
        return FileResponse(image, media_type="image/png")

    return router
