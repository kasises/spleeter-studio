import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import urlopen

import server


class OfflineRuntime:
    def detect(self, refresh=False):
        return {"ready": False, "python": None, "ffmpeg": True, "message": "test runtime unavailable"}


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = server.ProjectStore(self.root, OfflineRuntime())

    def tearDown(self):
        self.temp.cleanup()

    def test_rejects_unsupported_extension(self):
        with self.assertRaisesRegex(ValueError, "不支持"):
            self.store.create("notes.txt", 4, io.BytesIO(b"test"), 4)

    def test_rejects_invalid_stem_count(self):
        with self.assertRaisesRegex(ValueError, "2、4、5 或 6"):
            self.store.create("song.wav", 3, io.BytesIO(b"test"), 4)

    def test_public_project_hides_filesystem_paths(self):
        project = {
            "id": "20261014-abcdef123456",
            "sourcePath": "source.wav",
            "coverPath": "cover.jpg",
            "tracks": [{"id": "vocals", "path": "separated/song/vocals.wav", "filename": "vocals.wav"}],
        }
        public = self.store.public(project)
        self.assertNotIn("sourcePath", public)
        self.assertNotIn("coverPath", public)
        self.assertEqual(public["coverUrl"], "/api/projects/20261014-abcdef123456/cover")
        self.assertNotIn("path", public["tracks"][0])
        self.assertEqual(public["tracks"][0]["url"], "/api/projects/20261014-abcdef123456/audio/vocals")

    def test_create_uses_embedded_metadata_and_cover(self):
        def write_cover(_source, destination):
            destination.write_bytes(b"jpeg-cover")
            return True

        metadata = {
            "duration": 235.867,
            "title": "丸ノ内サディスティック (丸内虐待狂)",
            "artist": "椎名林檎",
            "album": "無罪モラトリアム",
        }
        with patch.object(self.store, "_probe_media", return_value=metadata), \
                patch.object(self.store, "_extract_cover", side_effect=write_cover), \
                patch.object(self.store, "start"):
            project = self.store.create("椎名林檎 - 丸ノ内サディスティック.mp3", 2, io.BytesIO(b"audio"), 5)

        stored = self.store.read(project["id"])
        self.assertEqual(project["title"], metadata["title"])
        self.assertEqual(project["artist"], metadata["artist"])
        self.assertEqual(project["album"], metadata["album"])
        self.assertEqual(project["duration"], metadata["duration"])
        self.assertEqual(project["coverUrl"], "/api/projects/%s/cover" % project["id"])
        self.assertEqual(stored["coverPath"], "cover.jpg")
        self.assertEqual((self.root / project["id"] / "cover.jpg").read_bytes(), b"jpeg-cover")

    def test_list_upgrades_existing_project_without_reprocessing_tracks(self):
        project_id = "20261014-legacymedia1"
        project_dir = self.root / project_id
        project_dir.mkdir()
        (project_dir / "source.mp3").write_bytes(b"audio")
        server.atomic_json_write(
            project_dir / "project.json",
            {
                "id": project_id,
                "title": "旧文件名",
                "sourceName": "旧文件名.mp3",
                "sourcePath": "source.mp3",
                "duration": 1,
                "status": "ready",
                "tracks": [],
                "createdAt": "2026-10-14T00:00:00+00:00",
            },
        )

        def write_cover(_source, destination):
            destination.write_bytes(b"jpeg-cover")
            return True

        with patch.object(
            self.store,
            "_probe_media",
            return_value={"duration": 235.867, "title": "丸ノ内サディスティック", "artist": "椎名林檎", "album": "無罪モラトリアム"},
        ), patch.object(self.store, "_extract_cover", side_effect=write_cover) as extract:
            project = self.store.list()[0]
            self.store.list()

        stored = self.store.read(project_id)
        self.assertEqual(project["title"], "丸ノ内サディスティック")
        self.assertEqual(project["artist"], "椎名林檎")
        self.assertEqual(project["coverUrl"], "/api/projects/%s/cover" % project_id)
        self.assertEqual(stored["mediaMetadataVersion"], server.MEDIA_METADATA_VERSION)
        extract.assert_called_once()

    def test_export_contains_tracks_and_manifest(self):
        project_id = "20261014-abcdef123456"
        project_dir = self.root / project_id
        audio_dir = project_dir / "separated" / "song"
        audio_dir.mkdir(parents=True)
        (audio_dir / "vocals.wav").write_bytes(b"RIFF-test")
        metadata = {
            "id": project_id,
            "title": "Test Song",
            "stemCount": 2,
            "createdAt": "2026-10-14T00:00:00+00:00",
            "status": "ready",
            "tracks": [{"id": "vocals", "path": "separated/song/vocals.wav", "filename": "vocals.wav"}],
        }
        server.atomic_json_write(project_dir / "project.json", metadata)
        archive = self.store.export_path(project_id)
        self.assertTrue(archive.exists())
        import zipfile
        with zipfile.ZipFile(str(archive)) as bundle:
            self.assertEqual(set(bundle.namelist()), {"vocals.wav", "project.json"})

    def test_rejects_identical_separation_outputs(self):
        first = self.root / "vocals.wav"
        second = self.root / "drums.wav"
        first.write_bytes(b"same audio")
        second.write_bytes(b"same audio")
        with self.assertRaisesRegex(RuntimeError, "所有音轨完全相同"):
            self.store._validate_distinct_tracks([first, second])

    def test_interrupted_project_is_available_for_retry_after_restart(self):
        project_dir = self.root / "20261014-interrupted"
        project_dir.mkdir()
        server.atomic_json_write(
            project_dir / "project.json",
            {
                "id": "20261014-interrupted",
                "status": "processing",
                "progress": 28,
                "phase": "正在分离音轨",
                "tracks": [],
            },
        )

        recovered = server.ProjectStore(self.root, OfflineRuntime()).read("20261014-interrupted")

        self.assertEqual(recovered["status"], "error")
        self.assertEqual(recovered["phase"], "分离已中断")
        self.assertIn("重新分离", recovered["error"])

    def test_jobs_run_one_at_a_time_in_fifo_order(self):
        order = []
        first_started = threading.Event()
        release_first = threading.Event()
        all_finished = threading.Event()

        def run(project_id):
            order.append(project_id)
            if project_id == "20261014-firstjob":
                first_started.set()
                release_first.wait(timeout=2)
            if project_id == "20261014-thirdjob":
                all_finished.set()

        with patch.object(self.store, "_run", side_effect=run):
            self.store.start("20261014-firstjob")
            self.assertTrue(first_started.wait(timeout=1))
            self.store.start("20261014-secondjob")
            self.store.start("20261014-thirdjob")
            release_first.set()
            self.assertTrue(all_finished.wait(timeout=2))

        self.assertEqual(
            order,
            ["20261014-firstjob", "20261014-secondjob", "20261014-thirdjob"],
        )


class RuntimeDetectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.models = self.root / "pretrained_models"
        self.runtime = server.RuntimeDetector(self.root / "runtime.json", self.models)

    def tearDown(self):
        self.temp.cleanup()

    def test_environment_uses_managed_model_directory(self):
        self.assertEqual(self.runtime.environment()["AUDIO_SEPARATOR_MODEL_DIR"], str(self.models.resolve()))
        self.assertEqual(self.runtime.environment()["HF_HUB_OFFLINE"], "1")

    def test_worker_environment_bypasses_proxy_without_changing_parent(self):
        with patch.dict("os.environ", {"HTTPS_PROXY": "http://127.0.0.1:10808", "http_proxy": "broken", "PYTHONPATH": "old-spleeter"}):
            env = self.runtime.environment()
            self.assertNotIn("HTTPS_PROXY", env)
            self.assertNotIn("http_proxy", env)
            self.assertNotIn("PYTHONPATH", env)
            self.assertEqual(env["NO_PROXY"], "*")
            import os
            self.assertEqual(os.environ["HTTPS_PROXY"], "http://127.0.0.1:10808")

    def test_parse_args_accepts_independent_model_directory(self):
        data_dir = self.root / "projects"
        args = server.parse_args(
            ["--data-dir", str(data_dir), "--model-dir", str(self.models)]
        )
        self.assertEqual(args.data_dir, data_dir)
        self.assertEqual(args.model_dir, self.models)

    def test_parse_args_uses_model_directory_environment_variable(self):
        with patch.dict("os.environ", {"SPLEETER_STUDIO_MODEL_DIR": str(self.models)}):
            args = server.parse_args([])
        self.assertEqual(args.model_dir, self.models)

    def test_missing_model_is_reported_without_deleting_existing_files(self):
        self.models.mkdir()
        marker = self.models / "user-file.txt"
        marker.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "不存在"):
            self.runtime.prepare_model(6)
        self.assertEqual(marker.read_text(), "keep")


class HttpServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        runtime = OfflineRuntime()
        store = server.ProjectStore(Path(self.temp.name), runtime)
        self.store = store
        self.httpd = server.StudioServer(("127.0.0.1", 0), store, runtime)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def test_health_and_projects(self):
        with urlopen(self.base + "/api/health") as response:
            self.assertEqual(json.load(response), {"ok": True, "version": "1.1.0"})
        with urlopen(self.base + "/api/projects") as response:
            self.assertEqual(json.load(response), {"projects": []})

    def test_static_app_has_desktop_title(self):
        with urlopen(self.base + "/") as response:
            html = response.read().decode("utf-8")
        self.assertIn("Spleeter Studio", html)
        self.assertIn("项目库", html)

    def test_project_cover_is_served_as_an_image(self):
        project_id = "20261014-cover123456"
        project_dir = self.store._project_dir(project_id)
        project_dir.mkdir()
        (project_dir / "cover.jpg").write_bytes(b"jpeg-cover")
        server.atomic_json_write(
            project_dir / "project.json",
            {"id": project_id, "coverPath": "cover.jpg", "tracks": []},
        )

        with urlopen(self.base + "/api/projects/%s/cover" % project_id) as response:
            self.assertEqual(response.headers.get_content_type(), "image/jpeg")
            self.assertEqual(response.read(), b"jpeg-cover")


if __name__ == "__main__":
    unittest.main()
