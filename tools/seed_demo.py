"""创建一个隔离的就绪项目，并生成音频以供 UI 验证。"""

import argparse
import json
import math
import struct
import wave
from datetime import datetime, timezone
from pathlib import Path


TRACKS = {
    "vocals": ("人声", 220.0),
    "drums": ("鼓", 72.0),
    "bass": ("贝斯", 92.5),
    "other": ("其他", 329.6),
}


def write_wave(path, frequency, duration=18, sample_rate=22050):
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = bytearray()
    for index in range(int(duration * sample_rate)):
        time = index / sample_rate
        section = int(time // 3) % 3
        envelope = (0.14, 0.48, 0.28)[section]
        pulse = 1.0 if frequency > 100 or int(time * 4) % 4 == 0 else 0.22
        sample = math.sin(2 * math.pi * frequency * time) * envelope * pulse
        sample += math.sin(2 * math.pi * frequency * 2.01 * time) * envelope * 0.12
        value = max(-32767, min(32767, int(sample * 32767)))
        frames.extend(struct.pack("<hh", value, value))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(frames)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("data_dir", type=Path)
    args = parser.parse_args()
    project_id = "20261014-demo00000001"
    project_dir = args.data_dir / project_id
    audio_dir = project_dir / "separated" / "demo-session"
    tracks = []
    for track_id, (label, frequency) in TRACKS.items():
        path = audio_dir / (track_id + ".wav")
        write_wave(path, frequency)
        tracks.append({"id": track_id, "label": label, "filename": path.name, "path": str(path.relative_to(project_dir)).replace("\\", "/")})
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    project = {
        "id": project_id,
        "title": "Midnight Session",
        "sourceName": "midnight-session.wav",
        "sourcePath": "source.wav",
        "stemCount": 4,
        "status": "ready",
        "progress": 100,
        "phase": "可以播放",
        "duration": 18.0,
        "tracks": tracks,
        "error": None,
        "createdAt": now,
        "updatedAt": now,
    }
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.json").write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
