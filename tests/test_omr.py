from __future__ import annotations

import io
import hashlib
import uuid
from pathlib import Path
from zipfile import ZipFile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfWriter

from server import omr
from server.omr import OmrStatus, _check_page_selection, create_omr_router, low_interline_pages, prepare_pages, read_musicxml, recognize, resample_low_interline_pages, retry_dimensions, summarize_musicxml
from server.storage import Cancelled, atomic_json


@pytest.fixture
def client(tmp_path, monkeypatch):
    app = FastAPI()
    router = create_omr_router(tmp_path)
    app.include_router(router)
    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": True})
    monkeypatch.setattr(router.omr_manager, "submit", lambda job_id: None)
    with TestClient(app) as transport:
        yield transport, router.omr_manager, tmp_path


def image_bytes(format="PNG", size=(800, 600)):
    output = io.BytesIO()
    Image.new("RGB", size, "white").save(output, format=format)
    return output.getvalue()


def make_job(directory: Path, data: bytes, suffix=".png", **options):
    job_id = uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"source{suffix}").write_bytes(data)
    atomic_json(directory / "status.json", {"id": job_id, "status": "queued", "progress": 0})
    return {"id": job_id, "input": f"source{suffix}", "filename": f"score{suffix}", "first_page": 1, "last_page": None, **options}


def test_upload_uses_generated_safe_path(client):
    transport, manager, _ = client
    result = transport.post("/api/omr", files={"file": ("../../score.png", image_bytes(), "image/png")})
    assert result.status_code == 202
    job_id = result.json()["id"]
    assert (manager.directory / job_id / "source.png").is_file()
    assert transport.get(f"/api/omr/jobs/{job_id}").json()["status"] == "queued"
    assert transport.get(f"/api/omr/jobs/{job_id}/musicxml").status_code == 404


@pytest.mark.parametrize("name", ["score.svg", "script.py", "score.html", "score.omr"])
def test_rejects_unsupported_or_active_formats(client, name):
    transport, _, _ = client
    assert transport.post("/api/omr", files={"file": (name, image_bytes())}).status_code == 415


@pytest.mark.parametrize("data", [{"first_page": "0"}, {"first_page": "5", "last_page": "4"}, {"first_page": "1", "last_page": "13"}])
def test_page_ranges_rejected_before_work(client, data):
    transport, _, _ = client
    assert transport.post("/api/omr", data=data, files={"file": ("score.png", image_bytes())}).status_code == 422


def test_missing_engine_does_not_substitute_fake_notes(client, monkeypatch):
    transport, _, _ = client
    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": False})
    response = transport.post("/api/omr", files={"file": ("score.png", image_bytes())})
    assert response.status_code == 503
    assert "musicxml" not in response.json()


def test_queue_backpressure(client, monkeypatch):
    transport, manager, _ = client
    monkeypatch.setattr(manager, "reserve", lambda: False)
    assert transport.post("/api/omr", files={"file": ("score.png", image_bytes())}).status_code == 429


def test_cancel_removes_result_even_after_racing_write(client):
    transport, manager, _ = client
    job_id = transport.post("/api/omr", files={"file": ("score.png", image_bytes())}).json()["id"]
    response = transport.delete(f"/api/omr/jobs/{job_id}")
    assert response.json()["status"] == "cancelled"
    atomic_json(manager.directory / job_id / "status.json", {"id": job_id, "status": "complete", "musicxml": "fake", "downloadUrl": "/fake"})
    response = transport.get(f"/api/omr/jobs/{job_id}").json()
    assert response["status"] == "cancelled"
    assert "musicxml" not in response
    assert "downloadUrl" not in response


def test_normalizes_image_formats_and_exif_safely(tmp_path):
    for index, format in enumerate(("PNG", "JPEG", "TIFF", "WEBP", "BMP")):
        directory = tmp_path / str(index)
        request = make_job(directory, image_bytes(format), suffix="." + format.lower())
        pages, count, warnings = prepare_pages(directory, request, OmrStatus(directory))
        assert len(pages) == count == 1
        assert (directory / "score.tiff").is_file()
        with Image.open(pages[0]) as image:
            assert image.size == (800, 600)
            assert image.mode == "L"


def test_rejects_tiny_or_corrupted_image(tmp_path):
    request = make_job(tmp_path, image_bytes(size=(50, 50)))
    with pytest.raises(ValueError, match="过小"):
        prepare_pages(tmp_path, request, OmrStatus(tmp_path))
    (tmp_path / "source.png").write_bytes(b"not a real image")
    with pytest.raises(ValueError, match="损坏"):
        prepare_pages(tmp_path, request, OmrStatus(tmp_path))


def test_rejects_encrypted_pdf_and_large_page_selection(tmp_path):
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=595, height=842)
    writer.encrypt("password")
    writer.write(output)
    request = make_job(tmp_path, output.getvalue(), suffix=".pdf")
    with pytest.raises(ValueError, match="密码"):
        prepare_pages(tmp_path, request, OmrStatus(tmp_path))
    with pytest.raises(ValueError, match="12"):
        _check_page_selection(1, 13, 13)


MINIMAL_XML = '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note></measure></part></score-partwise>'


def test_safe_mxl_decode_and_no_notes_failure(tmp_path):
    path = tmp_path / "score.mxl"
    with ZipFile(path, "w") as archive:
        archive.writestr("score.xml", MINIMAL_XML)
        archive.writestr("META-INF/container.xml", "<container/>")
    assert read_musicxml(path) == MINIMAL_XML
    xml = tmp_path / "empty.xml"
    xml.write_text('<score-partwise><part id="P1"/></score-partwise>')
    with pytest.raises(ValueError, match="音符"):
        read_musicxml(xml)


def test_mxl_rejects_traversal_and_custom_entities(tmp_path):
    path = tmp_path / "score.mxl"
    with ZipFile(path, "w") as archive:
        archive.writestr("../outside.xml", MINIMAL_XML)
    with pytest.raises(ValueError, match="不安全"):
        read_musicxml(path)
    xml = tmp_path / "bad.xml"
    xml.write_text('<!DOCTYPE score-partwise [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + MINIMAL_XML)
    with pytest.raises(ValueError, match="实体"):
        read_musicxml(xml)


def test_quality_warnings_are_not_accuracy_claims():
    stats, notices = summarize_musicxml(MINIMAL_XML, 1, "WARN No target duration", False)
    assert stats["pitchedNotes"] == 1
    assert stats["parts"] == 1
    assert any("默认不启用" in notice for notice in notices)
    assert any("校准准确率" in notice for notice in notices)
    assert any("速度" in notice for notice in notices)


def test_missing_job_and_page_do_not_expose_files(client):
    transport, _, _ = client
    assert transport.get("/api/omr/jobs/invalid").status_code == 404
    assert transport.get(f"/api/omr/jobs/{uuid.uuid4().hex}/pages/1").status_code == 404


def test_retry_requires_explicit_engine_interline_rejection():
    assert low_interline_pages("WARN score failed; low DPI suggested", 1) == {}
    assert low_interline_pages("WARN [score] With a too low interline value of 8 pixels", 1) == {1: 8}
    assert low_interline_pages("INFO [score#1] LOAD\nWARN [score#2] With a too low interline value of 7 pixels", 3) == {2: 7}
    with pytest.raises(ValueError, match="页码"):
        low_interline_pages("WARN With a too low interline value of 8 pixels", 3)


def test_retry_dimensions_are_bounded_and_low_detail_rejected():
    assert retry_dimensions(990, 1400, 8) == (2475, 3500, 2.5)
    width, height, scale = retry_dimensions(800, 1000, 4)
    assert scale == 3 and (width, height) == (2400, 3000)
    assert width * height <= omr.MAX_IMAGE_PIXELS
    assert retry_dimensions(990, 1400, 11)[2] == pytest.approx(20 / 11)
    with pytest.raises(ValueError, match="细节不足"):
        retry_dimensions(800, 1000, 3)
    with pytest.raises(ValueError, match="安全尺寸"):
        retry_dimensions(3000, 3500, 8)


def test_retry_keeps_preview_bytes_and_resamples_only_rejected_pages(tmp_path):
    from PIL import ImageDraw

    status = OmrStatus(tmp_path)
    atomic_json(tmp_path / "status.json", {"id": uuid.uuid4().hex, "status": "running", "progress": 18})
    pages = []
    for index in range(2):
        page = tmp_path / f"page-{index + 1:03d}.png"
        image = Image.new("L", (990, 1400), 255)
        draw = ImageDraw.Draw(image)
        for line in range(5):
            draw.line((100, 300 + line * 8, 890, 300 + line * 8), fill=0)
        image.save(page)
        pages.append(page)
    before = [hashlib.sha256(page.read_bytes()).hexdigest() for page in pages]
    retry, plan = resample_low_interline_pages(tmp_path, pages, {2: 8}, status)
    assert before == [hashlib.sha256(page.read_bytes()).hexdigest() for page in pages]
    assert [item["resampled"] for item in plan] == [False, True]
    with Image.open(retry) as image:
        assert image.n_frames == 2 and image.size == (990, 1400)
        image.seek(1)
        assert image.size == (2475, 3500)
    assert not (tmp_path / "resampled-pages" / pages[0].name).exists()


def test_retry_cancelled_before_resizing_has_no_new_result(tmp_path):
    page = tmp_path / "page-001.png"
    page.write_bytes(image_bytes())
    (tmp_path / "cancelled").touch()
    with pytest.raises(Cancelled):
        resample_low_interline_pages(tmp_path, [page], {1: 8}, OmrStatus(tmp_path))
    assert not (tmp_path / "score-retry.tiff").exists()


def test_retry_total_pixel_budget_is_checked_before_allocating_resized_pages(tmp_path, monkeypatch):
    page = tmp_path / "page-001.png"
    page.write_bytes(image_bytes(size=(990, 1400)))
    monkeypatch.setattr(omr, "MAX_RETRY_TOTAL_PIXELS", 2_000_000)
    with pytest.raises(ValueError, match="内存上限"):
        resample_low_interline_pages(tmp_path, [page], {1: 8}, OmrStatus(tmp_path))
    assert not list((tmp_path / "resampled-pages").glob("*.png"))
    assert not (tmp_path / "score-retry.tiff").exists()


def test_recognition_no_low_interline_means_no_retry(tmp_path, monkeypatch):
    request = make_job(tmp_path, image_bytes())
    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": True})
    calls = []

    def fail_once(directory, input_path, output, log_path, page_count, read_text, status, **kwargs):
        calls.append(input_path)
        output.mkdir(exist_ok=True)
        return 1, "WARN generic recognition failure"

    monkeypatch.setattr(omr, "_recognition_attempt", fail_once)
    with pytest.raises(ValueError, match="未能识别"):
        recognize(tmp_path, request)
    assert len(calls) == 1
    assert not (tmp_path / "resampling-evidence.json").exists()


def test_recognition_stops_after_one_evidence_based_retry(tmp_path, monkeypatch):
    request = make_job(tmp_path, image_bytes(size=(990, 1400)))
    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": True})
    calls = []

    def low_resolution(directory, input_path, output, log_path, page_count, read_text, status, **kwargs):
        calls.append(input_path)
        output.mkdir(exist_ok=True)
        return 1, "WARN [score] With a too low interline value of 8 pixels"

    monkeypatch.setattr(omr, "_recognition_attempt", low_resolution)
    with pytest.raises(ValueError, match="未继续重复重试"):
        recognize(tmp_path, request)
    assert [path.name for path in calls] == ["score.tiff", "score-retry.tiff"]
    assert (tmp_path / "resampling-evidence.json").is_file()


TWO_PART_XML = MINIMAL_XML.replace("</part-list>", '<score-part id="P2"><part-name>B</part-name></score-part></part-list>').replace("</score-partwise>", '<part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note></measure></part></score-partwise>')


def test_auto_engine_prefers_verified_homr(monkeypatch):
    monkeypatch.setattr(omr, "homr_manifest", lambda: {"version": "x", "weights": {}})
    assert omr.resolve_engine("auto") == "homr"
    monkeypatch.setattr(omr, "homr_manifest", lambda: None)
    assert omr.resolve_engine("auto") == "audiveris"
    with pytest.raises(ValueError):
        omr.resolve_engine("oemer")


def test_upload_rejects_unknown_or_missing_engine(client, monkeypatch):
    transport, _, _ = client
    assert transport.post("/api/omr", data={"engine": "oemer"}, files={"file": ("score.png", image_bytes())}).status_code == 422
    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": True, "engines": {"homr": {"ready": False}, "audiveris": {"ready": True}}})
    assert transport.post("/api/omr", data={"engine": "homr"}, files={"file": ("score.png", image_bytes())}).status_code == 503


def test_legacy_request_without_engine_stays_on_audiveris(tmp_path, monkeypatch):
    request = make_job(tmp_path, image_bytes())
    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": True})
    monkeypatch.setattr(omr, "audiveris_ready", lambda: True)
    monkeypatch.setattr(omr, "homr_manifest", lambda: {"version": "x"})
    monkeypatch.setattr(omr, "_homr_attempt", lambda *args: pytest.fail("homr must not run for a legacy request"))
    monkeypatch.setattr(omr, "_audiveris_attempt", lambda *args: (_ for _ in ()).throw(ValueError("audiveris ran")))
    with pytest.raises(ValueError, match="audiveris ran"):
        recognize(tmp_path, request)


def test_homr_result_keeps_engine_label_and_no_text_notice(tmp_path, monkeypatch):
    request = make_job(tmp_path, image_bytes(), engine="homr")
    result = tmp_path / "homr.musicxml"
    result.write_text(MINIMAL_XML)
    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": True})
    monkeypatch.setattr(omr, "homr_manifest", lambda: {"version": "0.7.1"})
    monkeypatch.setattr(omr, "_homr_attempt", lambda directory, pages, status, *extra: (result, ["各页识别出的声部数不一致"], {"engineExit": 0, "partsPerPage": [1]}))
    monkeypatch.setattr(omr, "_audiveris_attempt", lambda *args: pytest.fail("no fallback when homr succeeded"))
    recognize(tmp_path, request)
    state = OmrStatus(tmp_path).read()
    assert state["source"]["engineId"] == "homr" and state["source"]["engine"].startswith("homr 0.7.1")
    assert any("不读取歌词" in notice for notice in state["warnings"])
    assert any("声部数不一致" in notice for notice in state["warnings"])
    assert state["statistics"]["partsPerPage"] == "1"


def test_auto_falls_back_to_audiveris_only_when_homr_produced_nothing(tmp_path, monkeypatch):
    request = make_job(tmp_path, image_bytes(), engine="auto")
    result = tmp_path / "audiveris.musicxml"
    result.write_text(MINIMAL_XML)
    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": True})
    monkeypatch.setattr(omr, "homr_manifest", lambda: {"version": "0.7.1"})
    monkeypatch.setattr(omr, "audiveris_ready", lambda: True)
    monkeypatch.setattr(omr, "_homr_attempt", lambda directory, pages, status, *extra: (None, [], {"engineExit": 1, "pagesMissing": [1]}))
    monkeypatch.setattr(omr, "_audiveris_attempt", lambda directory, pages, read_text, status, notices: (result, "", 0, []))
    recognize(tmp_path, request)
    state = OmrStatus(tmp_path).read()
    assert state["source"]["engineId"] == "audiveris" and state["source"]["requestedEngine"] == "auto"
    assert any("已改用 Audiveris" in notice for notice in state["warnings"])


def test_explicit_homr_failure_does_not_silently_switch_engine(tmp_path, monkeypatch):
    request = make_job(tmp_path, image_bytes(), engine="homr")
    monkeypatch.setattr(omr, "omr_health", lambda: {"ready": True})
    monkeypatch.setattr(omr, "homr_manifest", lambda: {"version": "0.7.1"})
    monkeypatch.setattr(omr, "audiveris_ready", lambda: True)
    monkeypatch.setattr(omr, "_homr_attempt", lambda directory, pages, status, *extra: (None, [], {"engineExit": 1, "pagesMissing": [1]}))
    monkeypatch.setattr(omr, "_audiveris_attempt", lambda *args: pytest.fail("explicit engine must not fall back"))
    with pytest.raises(ValueError, match="homr 未能识别"):
        recognize(tmp_path, request)


def test_homr_page_part_mismatch_is_reported_not_hidden(tmp_path, monkeypatch):
    pages = []
    for index, xml in enumerate([MINIMAL_XML, TWO_PART_XML], 1):
        page = tmp_path / "pages" / f"page-{index:03d}.png"
        page.parent.mkdir(exist_ok=True)
        page.write_bytes(image_bytes())
        pages.append(page)
    source = tmp_path / "models" / "omr" / "homr" / "src"

    def fake_run(command, cwd, env, log_path, deadline, status, on_log=None):
        if "--no-title" in command:
            assert env["HTTPS_PROXY"].startswith("http://127.0.0.1")
            for index, xml in enumerate([MINIMAL_XML, TWO_PART_XML], 1):
                (tmp_path / "recognized-homr" / f"page-{index:03d}.musicxml").write_text(xml)
        else:
            Path(command[3]).write_text(MINIMAL_XML)
        return 0

    monkeypatch.setattr(omr, "homr_home", lambda: source.parent)
    monkeypatch.setattr(omr, "_run_logged", fake_run)
    status = OmrStatus(tmp_path)
    atomic_json(tmp_path / "status.json", {"id": "x", "status": "running", "progress": 0})
    merged, notices, stats = omr._homr_attempt(tmp_path, pages, status)
    assert merged.name == "merged.musicxml"
    assert stats["partsPerPage"] == [1, 2]
    assert any("第 1 页 1 个" in notice and "第 2 页 2 个" in notice for notice in notices)
    # Raw per-page output stays next to the merged result.
    assert (tmp_path / "recognized-homr" / "page-002.musicxml").is_file()


def test_homr_text_layer_notices_do_not_repeat_audiveris_ocr_advice():
    _, with_text = summarize_musicxml(MINIMAL_XML, 1, "", False, "homr", True)
    _, without_text = summarize_musicxml(MINIMAL_XML, 1, "", False, "homr", False)
    assert not any("歌词/标题 OCR" in notice for notice in with_text + without_text)
    assert any("未启用文字层" in notice for notice in without_text)
    assert not any("未启用文字层" in notice for notice in with_text)
