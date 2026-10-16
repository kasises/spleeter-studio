import hashlib
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from roformer_audio import group_stems, write_stems
from roformer_models import file_sha256, model_for_stems, validate_model


class LocalModelTests(unittest.TestCase):
    def test_two_track_and_multi_track_models_are_different_weights(self):
        self.assertNotEqual(model_for_stems(2)["id"], model_for_stems(4)["id"])
        self.assertEqual(model_for_stems(4)["id"], model_for_stems(5)["id"])
        self.assertEqual(model_for_stems(5)["id"], model_for_stems(6)["id"])

    def test_same_size_corrupt_weights_are_rejected_and_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            weights, config = root / "model.ckpt", root / "model.yaml"
            weights.write_bytes(b"bad")
            config.write_bytes(b"config")
            spec = {"filename": weights.name, "config": config.name, "size": 3,
                    "sha256": hashlib.sha256(b"good").hexdigest(), "configSha256": file_sha256(config)}
            with self.assertRaisesRegex(RuntimeError, "权重校验失败"):
                validate_model(root, spec)
            self.assertEqual(weights.read_bytes(), b"bad")

    def test_mismatched_config_is_rejected_before_loading_weights(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "model.ckpt").write_bytes(b"ok")
            (root / "model.yaml").write_bytes(b"wrong")
            spec = {"filename": "model.ckpt", "config": "model.yaml", "size": 2,
                    "sha256": hashlib.sha256(b"ok").hexdigest(), "configSha256": hashlib.sha256(b"right").hexdigest()}
            with self.assertRaisesRegex(RuntimeError, "配置校验失败"):
                validate_model(root, spec)


class StemGroupingTests(unittest.TestCase):
    def setUp(self):
        self.sources = {name: np.full((2, 4096), level, dtype=np.float32)
                        for name, level in {"vocals": 0.1, "drums": 0.2, "bass": 0.3,
                                            "piano": 0.4, "guitar": 0.5, "other": 0.6}.items()}

    def test_merging_four_and_five_tracks_preserves_the_six_track_mix(self):
        six_mix = sum(self.sources.values())
        for count in (4, 5, 6):
            groups = group_stems(self.sources, count)
            self.assertEqual(len(groups), count)
            np.testing.assert_allclose(sum(groups.values()), six_mix)
            if count >= 5:
                np.testing.assert_array_equal(groups["piano"], self.sources["piano"])

    def test_missing_instrument_never_silently_produces_an_incomplete_project(self):
        self.sources.pop("guitar")
        with self.assertRaisesRegex(RuntimeError, "缺少"):
            group_stems(self.sources, 4)

    def test_export_applies_common_gain_and_does_not_clip_or_change_balance(self):
        with tempfile.TemporaryDirectory() as temporary:
            tracks, gain = write_stems(self.sources, 4, temporary)
            self.assertLess(gain, 1)
            self.assertEqual(len(tracks), 4)
            decoded = {}
            for track in tracks:
                audio, rate = sf.read(Path(temporary) / track["filename"], always_2d=True)
                self.assertEqual(rate, 44100)
                self.assertLess(float(np.abs(audio).max()), 1)
                decoded[track["id"]] = audio.T
            np.testing.assert_allclose(sum(decoded.values()) / gain, sum(self.sources.values()), atol=1e-6)

    def test_two_stem_instrumental_label_is_normalized_for_the_existing_player(self):
        groups = group_stems({"Vocals": self.sources["vocals"], "Instrumental": self.sources["other"]}, 2)
        self.assertEqual(tuple(groups), ("vocals", "accompaniment"))


if __name__ == "__main__":
    unittest.main()
