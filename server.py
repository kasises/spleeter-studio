#!/usr/bin/env python3
"""用于 Spleeter Studio 的本地 HTTP 服务器和离线 RoFormer 队列。"""

import argparse
import hashlib
import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, BinaryIO, Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote, unquote, urlparse

from roformer_models import EXPECTED_TRACKS, MODELS, model_for_stems, validate_model


APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "app"
DEFAULT_DATA_ROOT = APP_ROOT / "data"
APP_VERSION = "1.1.0"
SUPPORTED_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".wma"}
TRACK_LABELS = {
    "vocals": "人声",
    "accompaniment": "伴奏",
    "drums": "鼓",
    "bass": "贝斯",
    "piano": "钢琴",
    "guitar": "吉他",
    "other": "其他",
}
MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
PROJECT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,80}$")
MEDIA_METADATA_VERSION = 1


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def atomic_json_write(path: Path, value: Dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(str(temporary), str(path))


def safe_filename(value: str) -> str:
    value = Path(value.replace("\\", "/")).name.strip()
    value = re.sub(r"[\x00-\x1f<>:\"/\\|?*]", "_", value)
    return value[:180] or "audio.wav"


def format_runtime_error(missing: Iterable[str]) -> str:
    names = ", ".join(missing)
    return (
        "当前 Python 无法运行 RoFormer：%s。请选择安装了 PyTorch 和 audio-separator 0.47.0 "
        "的 Python 3.10 及以上环境（本机为 SpleeterRoFormer）。" % names
    )


class RuntimeDetector:
    """查找 RoFormer 解释器并验证本地模型文件。"""

    REQUIRED_MODULES = ("torch", "audio_separator", "numpy", "soundfile", "yaml", "requests")

    def __init__(self, config_path: Optional[Path] = None, model_path: Optional[Path] = None) -> None:
        self._lock = threading.Lock()
        self._cached: Optional[Dict[str, Any]] = None
        self.config_path = config_path
        self.model_path = model_path.resolve() if model_path else None
        self._verified_models = {}

    def environment(self) -> Dict[str, str]:
        env = os.environ.copy()
        env.pop("PYTHONPATH", None)
        env["PYTHONUTF8"] = "1"
        env["PYTHONNOUSERSITE"] = "1"
        env["HF_HUB_OFFLINE"] = "1"
        for variable in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            env.pop(variable, None)
        env["NO_PROXY"] = "*"
        env["no_proxy"] = "*"
        tools = Path("D:/Video_DownloadTools")
        if tools.is_dir():
            env["PATH"] = str(tools) + os.pathsep + env.get("PATH", "")
        if self.model_path:
            env["AUDIO_SEPARATOR_MODEL_DIR"] = str(self.model_path)
        return env

    def prepare_model(self, stem_count: int) -> Dict[str, Any]:
        if not self.model_path:
            raise RuntimeError("未配置本地 RoFormer 模型目录。")
        spec = model_for_stems(stem_count)
        weights, config = validate_model(self.model_path, spec, verify_hash=False)
        signature = (str(weights), weights.stat().st_size, weights.stat().st_mtime_ns,
                     config.stat().st_size, config.stat().st_mtime_ns)
        if self._verified_models.get(spec["id"]) != signature:
            validate_model(self.model_path, spec)
            self._verified_models[spec["id"]] = signature
        return dict(spec)

    def _configured_python(self) -> Optional[str]:
        if not self.config_path or not self.config_path.exists():
            return None
        try:
            value = json.loads(self.config_path.read_text(encoding="utf-8"))
            return value.get("roformerPython") or value.get("python")
        except (OSError, ValueError, AttributeError):
            return None

    def _candidate_paths(self) -> List[Path]:
        values: List[Path] = []
        configured = os.environ.get("ROFORMER_PYTHON") or self._configured_python()
        if configured:
            values.append(Path(configured).expanduser())
        values.extend(
            [
                Path("D:/Anaconda/envs/SpleeterRoFormer/python.exe"),
                Path.home() / "anaconda3/envs/SpleeterRoFormer/python.exe",
                Path.home() / "miniconda3/envs/SpleeterRoFormer/python.exe",
                Path(sys.executable),
            ]
        )
        discovered = shutil.which("python")
        if discovered:
            values.append(Path(discovered))
        result: List[Path] = []
        seen = set()
        for value in values:
            key = os.path.normcase(os.path.abspath(str(value)))
            if key not in seen and value.exists():
                result.append(value)
                seen.add(key)
        return result

    def configure(self, python_path: str) -> Dict[str, Any]:
        candidate = Path(python_path).expanduser().resolve()
        if not candidate.is_file() or candidate.name.lower() not in ("python.exe", "python3.exe", "python"):
            raise ValueError("请选择有效的 python.exe")
        if not self.config_path:
            raise ValueError("当前服务未配置运行环境保存位置")
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json_write(self.config_path, {"roformerPython": str(candidate)})
        return self.detect(refresh=True)

    def detect(self, refresh: bool = False) -> Dict[str, Any]:
        with self._lock:
            if self._cached is not None and not refresh:
                return dict(self._cached)

            probe = (
                "import importlib.util,importlib.metadata,json,sys\n"
                "mods=%r\n"
                "missing=[m for m in mods if importlib.util.find_spec(m) is None]\n"
                "result={'missing':missing}\n"
                "if not missing:\n"
                " import torch\n"
                " version=importlib.metadata.version('audio-separator')\n"
                " if sys.version_info < (3,10): result['missing']=['Python >= 3.10']\n"
                " elif version != '0.47.0': result['missing']=['audio-separator 0.47.0（当前 '+version+'）']\n"
                " result.update(device='cuda' if torch.cuda.is_available() else 'cpu',"
                "deviceName=torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU',"
                "torch=torch.__version__,audioSeparator=version)\n"
                "print(json.dumps(result))\n"
            ) % (self.REQUIRED_MODULES,)
            attempts = []
            for candidate in self._candidate_paths():
                try:
                    completed = subprocess.run(
                        [str(candidate), "-c", probe],
                        env=self.environment(),
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        timeout=15,
                        check=False,
                    )
                    result = json.loads(completed.stdout.strip().splitlines()[-1]) if completed.stdout.strip() else {"missing": ["未知依赖"]}
                    missing = result.get("missing", ["未知依赖"])
                    if completed.returncode == 0 and not missing:
                        environment = self.environment()
                        ffmpeg_ready = bool(shutil.which("ffmpeg", path=environment.get("PATH")) and
                                            shutil.which("ffprobe", path=environment.get("PATH")))
                        model_states = {}
                        for spec in MODELS.values():
                            try:
                                self.prepare_model(spec["stemCounts"][0])
                                model_states[spec["id"]] = {"ready": True, "name": spec["name"], "stemCounts": spec["stemCounts"]}
                            except (OSError, RuntimeError) as error:
                                model_states[spec["id"]] = {"ready": False, "name": spec["name"], "stemCounts": spec["stemCounts"], "message": str(error)}
                        model_ready = any(item["ready"] for item in model_states.values())
                        message = "RoFormer 与 FFmpeg 已就绪 · " + result["deviceName"]
                        if not ffmpeg_ready:
                            message = "找不到 ffmpeg 或 ffprobe。"
                        elif not model_ready:
                            message = "本地 RoFormer 模型未就绪。目录：%s" % self.model_path
                        self._cached = {
                            "ready": ffmpeg_ready and model_ready,
                            "python": str(candidate),
                            "message": message,
                            "ffmpeg": ffmpeg_ready,
                            "device": result["device"],
                            "deviceName": result["deviceName"],
                            "models": model_states,
                            "engine": "roformer",
                        }
                        return dict(self._cached)
                    attempts.append("%s: %s" % (candidate, ", ".join(missing)))
                except (OSError, subprocess.SubprocessError, ValueError, IndexError) as exc:
                    attempts.append("%s: %s" % (candidate, exc))

            detail = attempts[0].split(": ", 1)[-1] if attempts else "未找到 Python"
            self._cached = {
                "ready": False,
                "python": str(self._candidate_paths()[0]) if self._candidate_paths() else None,
                "message": format_runtime_error([detail]),
                "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
                "attempts": attempts,
            }
            return dict(self._cached)


class ProjectStore:
    def __init__(self, root: Path, runtime: RuntimeDetector) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.runtime = runtime
        self._lock = threading.RLock()
        self._active_jobs = set()
        self._queued_jobs = set()
        self._job_queue: "queue.Queue[str]" = queue.Queue()
        self._recover_interrupted_projects()
        self._worker = threading.Thread(
            target=self._worker_loop,
            daemon=True,
            name="roformer-job-queue",
        )
        self._worker.start()

    def _recover_interrupted_projects(self) -> None:
        """允许重试因应用退出而中断的任务。"""
        for metadata_path in self.root.glob("*/project.json"):
            try:
                project = json.loads(metadata_path.read_text(encoding="utf-8"))
                if project.get("status") not in ("queued", "processing"):
                    continue
                project.update(
                    status="error",
                    progress=0,
                    phase="分离已中断",
                    error="上次分离因应用退出或后台进程中断，源文件仍在，请重新分离。",
                    updatedAt=utc_now(),
                )
                atomic_json_write(metadata_path, project)
            except (OSError, ValueError, KeyError):
                continue

    def _project_dir(self, project_id: str) -> Path:
        if not PROJECT_ID_RE.match(project_id):
            raise ValueError("无效的项目 ID")
        return self.root / project_id

    def _metadata_path(self, project_id: str) -> Path:
        return self._project_dir(project_id) / "project.json"

    def read(self, project_id: str) -> Dict[str, Any]:
        path = self._metadata_path(project_id)
        if not path.exists():
            raise FileNotFoundError(project_id)
        with self._lock:
            return json.loads(path.read_text(encoding="utf-8"))

    def write(self, project: Dict[str, Any]) -> None:
        with self._lock:
            atomic_json_write(self._metadata_path(project["id"]), project)

    def update(self, project_id: str, **changes: Any) -> Dict[str, Any]:
        with self._lock:
            project = self.read(project_id)
            project.update(changes)
            project["updatedAt"] = utc_now()
            self.write(project)
            return project

    @staticmethod
    def public(project: Dict[str, Any]) -> Dict[str, Any]:
        item = dict(project)
        project_id = item["id"]
        tracks = []
        for track in item.get("tracks", []):
            public_track = dict(track)
            public_track["url"] = "/api/projects/%s/audio/%s" % (project_id, track["id"])
            public_track.pop("path", None)
            tracks.append(public_track)
        item["tracks"] = tracks
        item["exportUrl"] = "/api/projects/%s/export" % project_id if tracks else None
        item["coverUrl"] = "/api/projects/%s/cover" % project_id if item.get("coverPath") else None
        item.pop("sourcePath", None)
        item.pop("coverPath", None)
        return item

    def list(self) -> List[Dict[str, Any]]:
        projects = []
        for path in self.root.glob("*/project.json"):
            try:
                project = json.loads(path.read_text(encoding="utf-8"))
                projects.append(self.public(self._upgrade_media_metadata(project)))
            except (OSError, ValueError, KeyError):
                continue
        projects.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
        return projects

    def _upgrade_media_metadata(self, project: Dict[str, Any]) -> Dict[str, Any]:
        if int(project.get("mediaMetadataVersion") or 0) >= MEDIA_METADATA_VERSION:
            return project
        project_dir = self._project_dir(project["id"])
        source_name = project.get("sourcePath")
        source_path = (project_dir / source_name).resolve() if source_name else None
        if source_path and project_dir.resolve() in source_path.parents and source_path.is_file():
            media = self._probe_media(source_path)
            project["title"] = media.get("title") or project.get("title") or Path(project.get("sourceName", "audio")).stem
            project["artist"] = media.get("artist")
            project["album"] = media.get("album")
            if media.get("duration"):
                project["duration"] = media["duration"]
            cover_path = project_dir / "cover.jpg"
            if cover_path.is_file() or self._extract_cover(source_path, cover_path):
                project["coverPath"] = cover_path.name
        project["mediaMetadataVersion"] = MEDIA_METADATA_VERSION
        project["updatedAt"] = utc_now()
        self.write(project)
        return project

    def create(self, filename: str, stem_count: int, stream: BinaryIO, length: int) -> Dict[str, Any]:
        if stem_count not in EXPECTED_TRACKS:
            raise ValueError("音轨数量只能是 2、4、5 或 6")
        filename = safe_filename(filename)
        extension = Path(filename).suffix.lower()
        if extension not in SUPPORTED_EXTENSIONS:
            raise ValueError("不支持的音频格式：%s" % (extension or "无扩展名"))
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            raise ValueError("文件为空或超过 4 GB 限制")

        project_id = datetime.now().strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:12]
        project_dir = self._project_dir(project_id)
        project_dir.mkdir(parents=True, exist_ok=False)
        source_path = project_dir / ("source" + extension)
        remaining = length
        with source_path.open("wb") as destination:
            while remaining:
                block = stream.read(min(1024 * 1024, remaining))
                if not block:
                    raise ValueError("上传在文件结束前中断")
                destination.write(block)
                remaining -= len(block)

        media = self._probe_media(source_path)
        cover_path = project_dir / "cover.jpg"
        has_cover = self._extract_cover(source_path, cover_path)
        now = utc_now()
        project = {
            "id": project_id,
            "title": media.get("title") or Path(filename).stem,
            "artist": media.get("artist"),
            "album": media.get("album"),
            "sourceName": filename,
            "sourcePath": source_path.name,
            "coverPath": cover_path.name if has_cover else None,
            "mediaMetadataVersion": MEDIA_METADATA_VERSION,
            "stemCount": stem_count,
            "engine": "roformer",
            "model": model_for_stems(stem_count)["id"],
            "modelName": model_for_stems(stem_count)["name"],
            "status": "queued",
            "progress": 0,
            "phase": "等待分离",
            "duration": media.get("duration", 0.0),
            "tracks": [],
            "error": None,
            "createdAt": now,
            "updatedAt": now,
        }
        self.write(project)
        self.start(project_id)
        return self.public(project)

    def _media_environment(self) -> Dict[str, str]:
        return self.runtime.environment() if hasattr(self.runtime, "environment") else os.environ

    def _probe_media(self, path: Path) -> Dict[str, Any]:
        result: Dict[str, Any] = {"duration": 0.0, "title": None, "artist": None, "album": None}
        env = self._media_environment()
        ffprobe = shutil.which("ffprobe", path=env.get("PATH"))
        if not ffprobe:
            return result
        try:
            completed = subprocess.run(
                [
                    ffprobe,
                    "-v", "error",
                    "-show_entries", "format=duration:format_tags=title,artist,album",
                    "-of", "json",
                    str(path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
                check=False,
                env=env,
            )
            if completed.returncode != 0:
                return result
            payload = json.loads(completed.stdout or "{}")
            format_info = payload.get("format") or {}
            tags = {str(key).lower(): value for key, value in (format_info.get("tags") or {}).items()}
            result["duration"] = round(float(format_info.get("duration") or 0), 3)
            for key in ("title", "artist", "album"):
                value = str(tags.get(key) or "").strip()
                result[key] = value or None
        except (OSError, ValueError, TypeError, json.JSONDecodeError, subprocess.SubprocessError):
            pass
        return result

    def _extract_cover(self, source_path: Path, cover_path: Path) -> bool:
        env = self._media_environment()
        ffmpeg = shutil.which("ffmpeg", path=env.get("PATH"))
        if not ffmpeg:
            return False
        try:
            completed = subprocess.run(
                [
                    ffmpeg,
                    "-nostdin", "-v", "error", "-y",
                    "-i", str(source_path),
                    "-map", "0:v:0",
                    "-frames:v", "1",
                    "-c:v", "mjpeg",
                    "-q:v", "2",
                    "-update", "1",
                    str(cover_path),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
                check=False,
                env=env,
            )
            if completed.returncode == 0 and cover_path.is_file() and cover_path.stat().st_size > 0:
                return True
        except (OSError, subprocess.SubprocessError):
            pass
        try:
            cover_path.unlink()
        except FileNotFoundError:
            pass
        return False

    def _probe_duration(self, path: Path) -> float:
        return float(self._probe_media(path).get("duration") or 0.0)

    def start(self, project_id: str) -> None:
        with self._lock:
            if project_id in self._active_jobs or project_id in self._queued_jobs:
                return
            self._queued_jobs.add(project_id)
            self._job_queue.put(project_id)

    def _worker_loop(self) -> None:
        while True:
            project_id = self._job_queue.get()
            with self._lock:
                self._queued_jobs.discard(project_id)
                self._active_jobs.add(project_id)
            try:
                self._run(project_id)
            finally:
                with self._lock:
                    self._active_jobs.discard(project_id)
                self._job_queue.task_done()

    def retry(self, project_id: str) -> Dict[str, Any]:
        project = self.read(project_id)
        if project.get("status") in ("processing", "queued"):
            return self.public(project)
        project = self.update(
            project_id,
            status="queued",
            progress=0,
            phase="等待分离",
            error=None,
            tracks=[],
            processingSeconds=0,
        )
        self.start(project_id)
        return self.public(project)

    def _run(self, project_id: str) -> None:
        try:
            runtime = self.runtime.detect()
            if not runtime.get("ready"):
                self.update(project_id, status="error", progress=0, phase="环境未就绪", error=runtime.get("message"))
                return

            spec = model_for_stems(self.read(project_id)["stemCount"])
            project = self.update(
                project_id,
                status="processing",
                progress=3,
                phase="校验 RoFormer 模型",
                error=None,
                processingSeconds=0,
                engine="roformer",
                model=spec["id"],
                modelName=spec["name"],
            )
            project_dir = self._project_dir(project_id)
            source_path = project_dir / project["sourcePath"]
            output_root = project_dir / "separated"
            if output_root.exists():
                shutil.rmtree(str(output_root))
            self.runtime.prepare_model(project["stemCount"])
            progress_path = project_dir / "roformer-progress.json"
            if progress_path.exists():
                progress_path.unlink()
            command = [
                runtime["python"],
                "-X", "utf8",
                str(APP_ROOT / "roformer_worker.py"),
                "--input", str(source_path),
                "--output-dir",
                str(output_root),
                "--model-dir", str(self.runtime.model_path),
                "--stems", str(project["stemCount"]),
                "--device", runtime.get("device", "auto"),
                "--progress-path", str(progress_path),
            ]
            self.update(project_id, progress=3, phase="校验 RoFormer 模型", processingSeconds=0)
            log_path = project_dir / "roformer.log"
            started_at = time.monotonic()
            with log_path.open("w", encoding="utf-8", errors="replace") as log:
                process = subprocess.Popen(
                    command,
                    cwd=str(APP_ROOT),
                    env=self.runtime.environment(),
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                while True:
                    try:
                        returncode = process.wait(timeout=1)
                        break
                    except subprocess.TimeoutExpired:
                        elapsed = int(time.monotonic() - started_at)
                        changes = {"processingSeconds": elapsed}
                        try:
                            live = json.loads(progress_path.read_text(encoding="utf-8"))
                            changes.update({key: live[key] for key in ("progress", "phase", "device", "deviceName") if key in live})
                        except (OSError, ValueError):
                            pass
                        self.update(project_id, **changes)
            output = log_path.read_text(encoding="utf-8", errors="replace")
            if returncode != 0:
                lines = [line.strip() for line in output.splitlines() if line.strip()]
                message = lines[-1] if lines else "RoFormer 退出，代码 %s" % returncode
                try:
                    message = json.loads((output_root / "inference.json").read_text(encoding="utf-8")).get("error", message)
                except (OSError, ValueError):
                    pass
                raise RuntimeError(message)

            self.update(project_id, progress=98, phase="整理输出")
            expected = EXPECTED_TRACKS[project["stemCount"]]
            available = {
                path.stem.lower(): path
                for path in output_root.glob("*.wav")
                if path.is_file()
            }
            tracks = []
            for stem in expected:
                path = available.get(stem)
                if path is None:
                    continue
                tracks.append(
                    {
                        "id": stem,
                        "label": TRACK_LABELS.get(stem, stem.title()),
                        "filename": path.name,
                        "path": str(path.relative_to(project_dir)).replace("\\", "/"),
                    }
                )
            if len(tracks) != len(expected):
                raise RuntimeError("输出不完整，期望 %d 轨，实际找到 %d 轨" % (len(expected), len(tracks)))
            self._validate_distinct_tracks(project_dir / track["path"] for track in tracks)
            duration = project.get("duration") or self._probe_duration(project_dir / tracks[0]["path"])
            inference = json.loads((output_root / "inference.json").read_text(encoding="utf-8"))
            self.update(
                project_id,
                status="ready",
                progress=100,
                phase="可以播放",
                tracks=tracks,
                duration=duration,
                error=None,
                inference=inference,
                device=inference.get("device"),
                deviceName=inference.get("gpu") or "CPU",
                processingSeconds=int(time.monotonic() - started_at),
            )
        except Exception as exc:
            try:
                self.update(project_id, status="error", progress=0, phase="分离失败", error=str(exc))
            except Exception:
                pass

    @staticmethod
    def _validate_distinct_tracks(paths: Iterable[Path]) -> None:
        fingerprints = []
        for path in paths:
            digest = hashlib.sha256()
            with path.open("rb") as source:
                while True:
                    block = source.read(1024 * 1024)
                    if not block:
                        break
                    digest.update(block)
            fingerprints.append(digest.hexdigest())
        if len(fingerprints) > 1 and len(set(fingerprints)) == 1:
            raise RuntimeError(
                "分离结果中的所有音轨完全相同，预训练模型可能未正确加载。"
                "请检查模型文件后重试。"
            )

    def track_path(self, project_id: str, track_id: str) -> Path:
        project = self.read(project_id)
        for track in project.get("tracks", []):
            if track.get("id") == track_id:
                candidate = (self._project_dir(project_id) / track["path"]).resolve()
                if self._project_dir(project_id).resolve() not in candidate.parents:
                    break
                return candidate
        raise FileNotFoundError(track_id)

    def cover_path(self, project_id: str) -> Path:
        project = self.read(project_id)
        cover = project.get("coverPath")
        if not cover:
            raise FileNotFoundError(project_id)
        candidate = (self._project_dir(project_id) / cover).resolve()
        if self._project_dir(project_id).resolve() not in candidate.parents:
            raise FileNotFoundError(project_id)
        return candidate

    def export_path(self, project_id: str) -> Path:
        project = self.read(project_id)
        if not project.get("tracks"):
            raise FileNotFoundError("项目还没有可导出的音轨")
        archive = self._project_dir(project_id) / (safe_filename(project["title"]) + "-stems.zip")
        with zipfile.ZipFile(str(archive), "w", compression=zipfile.ZIP_STORED) as bundle:
            for track in project["tracks"]:
                path = self._project_dir(project_id) / track["path"]
                bundle.write(str(path), arcname=track["filename"])
            bundle.writestr(
                "project.json",
                json.dumps(
                    {"title": project["title"], "stemCount": project["stemCount"], "createdAt": project["createdAt"],
                     "engine": project.get("engine", "legacy"), "model": project.get("model"),
                     "modelName": project.get("modelName"), "device": project.get("device"),
                     "inference": project.get("inference")},
                    ensure_ascii=False,
                    indent=2,
                ),
            )
        return archive

    def delete(self, project_id: str) -> None:
        project = self.read(project_id)
        if project.get("status") in ("processing", "queued"):
            raise ValueError("正在处理的项目不能删除")
        shutil.rmtree(str(self._project_dir(project_id)))


class StudioHandler(BaseHTTPRequestHandler):
    server_version = "SpleeterStudio/" + APP_VERSION

    @property
    def store(self) -> ProjectStore:
        return self.server.store  # type: ignore[attr-defined]

    @property
    def runtime(self) -> RuntimeDetector:
        return self.server.runtime  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _headers(self, status: int, content_type: str, length: Optional[int] = None, extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if content_type.startswith("text/html"):
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self';",
            )
        if length is not None:
            self.send_header("Content-Length", str(length))
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()

    def _json(self, value: Any, status: int = 200) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(payload), {"Cache-Control": "no-store"})
        self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._json({"error": message}, status)

    def _serve_file(self, path: Path, download_name: Optional[str] = None, allow_range: bool = False) -> None:
        if not path.is_file():
            self._error(404, "文件不存在")
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        size = path.stat().st_size
        start, end = 0, size - 1
        status = HTTPStatus.OK
        extra = {"Accept-Ranges": "bytes"} if allow_range else {}
        range_header = self.headers.get("Range") if allow_range else None
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
            if match:
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), end) if last else end
                elif last:
                    start = max(0, size - int(last))
                if start > end or start >= size:
                    self._headers(416, content_type, 0, {"Content-Range": "bytes */%d" % size})
                    return
                status = HTTPStatus.PARTIAL_CONTENT
                extra["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
        if download_name:
            extra["Content-Disposition"] = "attachment; filename*=UTF-8''%s" % quote(safe_filename(download_name))
        length = end - start + 1
        self._headers(status, content_type, length, extra)
        with path.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining:
                block = source.read(min(1024 * 1024, remaining))
                if not block:
                    break
                self.wfile.write(block)
                remaining -= len(block)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/health":
                self._json({"ok": True, "version": APP_VERSION})
                return
            if path == "/api/config":
                self._json({"runtime": self.runtime.detect(), "supportedStems": list(EXPECTED_TRACKS)})
                return
            if path == "/api/projects":
                self._json({"projects": self.store.list()})
                return
            match = re.match(r"^/api/projects/([^/]+)$", path)
            if match:
                self._json(self.store.public(self.store.read(match.group(1))))
                return
            match = re.match(r"^/api/projects/([^/]+)/audio/([^/]+)$", path)
            if match:
                self._serve_file(self.store.track_path(match.group(1), unquote(match.group(2))), allow_range=True)
                return
            match = re.match(r"^/api/projects/([^/]+)/cover$", path)
            if match:
                self._serve_file(self.store.cover_path(match.group(1)))
                return
            match = re.match(r"^/api/projects/([^/]+)/export$", path)
            if match:
                archive = self.store.export_path(match.group(1))
                self._serve_file(archive, archive.name)
                return
            self._serve_static(path)
        except FileNotFoundError:
            self._error(404, "项目或文件不存在")
        except (ValueError, OSError) as exc:
            self._error(400, str(exc))

    def _serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in ("", "/") else unquote(request_path.lstrip("/"))
        candidate = (STATIC_ROOT / relative).resolve()
        if STATIC_ROOT.resolve() != candidate and STATIC_ROOT.resolve() not in candidate.parents:
            self._error(403, "禁止访问")
            return
        if not candidate.is_file():
            candidate = STATIC_ROOT / "index.html"
        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        payload = candidate.read_bytes()
        cache = "no-cache" if candidate.suffix in (".html", ".js", ".css") else "public, max-age=3600"
        self._headers(200, content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""), len(payload), {"Cache-Control": cache})
        self.wfile.write(payload)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/projects":
                length = int(self.headers.get("Content-Length", "0"))
                filename = unquote(self.headers.get("X-Filename", "audio.wav"))
                stem_count = int(self.headers.get("X-Stems", "4"))
                project = self.store.create(filename, stem_count, self.rfile, length)
                self._json(project, 201)
                return
            if path == "/api/runtime/recheck":
                self._json({"runtime": self.runtime.detect(refresh=True)})
                return
            if path == "/api/runtime/configure":
                length = min(int(self.headers.get("Content-Length", "0")), 8192)
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self._json({"runtime": self.runtime.configure(str(payload.get("python", "")))})
                return
            match = re.match(r"^/api/projects/([^/]+)/retry$", path)
            if match:
                self._json(self.store.retry(match.group(1)))
                return
            self._error(404, "接口不存在")
        except (ValueError, OSError) as exc:
            self._error(400, str(exc))

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        match = re.match(r"^/api/projects/([^/]+)$", path)
        if not match:
            self._error(404, "接口不存在")
            return
        try:
            self.store.delete(match.group(1))
            self._json({"ok": True})
        except FileNotFoundError:
            self._error(404, "项目不存在")
        except (ValueError, OSError) as exc:
            self._error(400, str(exc))


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: Tuple[str, int], store: ProjectStore, runtime: RuntimeDetector) -> None:
        super().__init__(address, StudioHandler)
        self.store = store
        self.runtime = runtime


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local Spleeter Studio application")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("SPLEETER_STUDIO_DATA", DEFAULT_DATA_ROOT)))
    configured_model_dir = os.environ.get("ROFORMER_MODEL_DIR") or os.environ.get("SPLEETER_STUDIO_MODEL_DIR")
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path(configured_model_dir) if configured_model_dir else None,
    )
    parser.add_argument("--open", action="store_true", dest="open_browser")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    data_dir = args.data_dir.resolve()
    model_dir = (args.model_dir or data_dir.parent / "roformer_models").resolve()
    runtime = RuntimeDetector(
        data_dir.parent / "runtime.json",
        model_dir,
    )
    store = ProjectStore(data_dir, runtime)
    server = StudioServer((args.host, args.port), store, runtime)
    url = "http://%s:%d" % (args.host, args.port)
    print("Spleeter Studio: %s" % url, flush=True)
    print("项目目录: %s" % store.root, flush=True)
    print("模型目录: %s" % model_dir, flush=True)
    if args.open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
