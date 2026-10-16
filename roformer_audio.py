"""合并 RoFormer 音轨，同时保留时序和相对音量。"""

from pathlib import Path

import numpy as np
import soundfile as sf

from roformer_models import EXPECTED_TRACKS


def group_stems(sources, stem_count):
    if stem_count not in EXPECTED_TRACKS:
        raise ValueError("音轨数量只能是 2、4、5 或 6")
    sources = {name.lower(): np.asarray(audio, dtype=np.float32) for name, audio in sources.items()}
    if stem_count == 2:
        accompaniment = sources.get("instrumental", sources.get("other", sources.get("accompaniment")))
        if "vocals" not in sources or accompaniment is None:
            raise RuntimeError("两轨 RoFormer 未输出完整的人声和伴奏")
        groups = {"vocals": sources["vocals"], "accompaniment": accompaniment}
    else:
        missing = set(EXPECTED_TRACKS[6]) - set(sources)
        if missing:
            raise RuntimeError("六轨 RoFormer 输出缺少：%s" % ", ".join(sorted(missing)))
        groups = {name: sources[name] for name in EXPECTED_TRACKS[stem_count]}
        if stem_count == 4:
            groups["other"] = sources["other"] + sources["piano"] + sources["guitar"]
        elif stem_count == 5:
            groups["other"] = sources["other"] + sources["guitar"]
    shapes = {audio.shape for audio in groups.values()}
    if len(shapes) != 1 or any(audio.ndim != 2 or audio.shape[0] != 2 for audio in groups.values()):
        raise RuntimeError("RoFormer 输出音轨的长度或声道不一致")
    if not all(np.isfinite(audio).all() for audio in groups.values()):
        raise RuntimeError("RoFormer 输出包含无效采样值")
    return groups


def write_stems(sources, stem_count, output_dir, sample_rate=44100):
    groups = group_stems(sources, stem_count)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    # 对所有音轨统一增益，可防止削波且不改变混音平衡。
    peak = max(float(np.max(np.abs(audio))) for audio in groups.values())
    gain = min(1.0, 0.999 / peak) if peak else 1.0
    tracks = []
    for name, audio in groups.items():
        path = output_dir / (name + ".wav")
        sf.write(path, (audio * gain).T, sample_rate, subtype="PCM_24")
        tracks.append({"id": name, "filename": path.name, "frames": audio.shape[1]})
    return tracks, gain
