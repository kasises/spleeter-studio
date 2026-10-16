"""已固定本地 RoFormer 模型；无需导入机器学习运行时即可使用。"""

import hashlib
from pathlib import Path


EXPECTED_TRACKS = {
    2: ("vocals", "accompaniment"),
    4: ("vocals", "drums", "bass", "other"),
    5: ("vocals", "drums", "bass", "piano", "other"),
    6: ("vocals", "drums", "bass", "piano", "guitar", "other"),
}

MODELS = {
    "melband-big-beta6x": {
        "id": "melband-big-beta6x",
        "name": "Mel-Band RoFormer Big Beta 6X",
        "filename": "melband_roformer_big_beta6x.ckpt",
        "config": "config_melbandroformer_big_beta6x.yaml",
        "size": 1708527586,
        "sha256": "e16d702f4e20f13d60b293541c1dea75cb4414a5846b36780e28ef70352a4e5c",
        "configSha256": "42a037e9d80dc1dbc91005047cd20f4afe7c1267163fc878a9fbaf6be21959f3",
        "segment": 1201,
        "overlap": 4,
        "stemCounts": [2],
    },
    "bs-rofo-sw-fixed": {
        "id": "bs-rofo-sw-fixed",
        "name": "BS-RoFormer SW Fixed",
        "filename": "BS-Rofo-SW-Fixed.ckpt",
        "config": "BS-Rofo-SW-Fixed.yaml",
        "size": 699412152,
        "sha256": "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e",
        "configSha256": "f9fada9f94e5ba2d2e4600196299459294bc5f532b314c209cc156ac63e4329b",
        "segment": 1101,
        "overlap": 4,
        "stemCounts": [4, 5, 6],
    },
}


def model_for_stems(stem_count):
    if stem_count not in EXPECTED_TRACKS:
        raise ValueError("音轨数量只能是 2、4、5 或 6")
    return MODELS["melband-big-beta6x" if stem_count == 2 else "bs-rofo-sw-fixed"]


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_model(model_dir, spec, verify_hash=True):
    """Never delete weights or download replacements during a separation task."""
    model_dir = Path(model_dir).resolve()
    weights = model_dir / spec["filename"]
    config = model_dir / spec["config"]
    for path in (weights, config):
        if not path.is_file():
            raise RuntimeError("本地 RoFormer 模型文件不存在：%s" % path)
    if weights.stat().st_size != spec["size"]:
        raise RuntimeError("RoFormer 权重大小不正确，请重新准备完整模型：%s" % weights)
    if file_sha256(config) != spec["configSha256"]:
        raise RuntimeError("RoFormer 配置校验失败：%s" % config)
    if verify_hash and file_sha256(weights) != spec["sha256"]:
        raise RuntimeError("RoFormer 权重校验失败：%s" % weights)
    return weights, config
