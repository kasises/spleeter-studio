"""用于桌面应用 FIFO 队列的离线隔离 PyTorch 工作进程。"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import traceback

from roformer_models import model_for_stems, validate_model

import numpy as np
import soundfile as sf
import torch
import requests
from audio_separator.separator import Separator
from audio_separator.separator.roformer.roformer_loader import RoformerLoader
from audio_separator.separator.architectures import mdxc_separator
from roformer_audio import write_stems


def atomic_write(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(str(temporary), str(path))


def run(args):
    args.output_dir.mkdir(parents=True, exist_ok=True)
    spec = model_for_stems(args.stems)
    report = {"engine": "roformer", "model": spec["id"], "modelName": spec["name"], "stemCount": args.stems}
    report_path = args.output_dir / "inference.json"

    def progress(percent, phase, **details):
        if args.progress_path:
            atomic_write(args.progress_path, {"progress": percent, "phase": phase, **details})

    try:
        progress(3, "校验 RoFormer 模型")
        weights, config = validate_model(args.model_dir, spec)
        for variable in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            os.environ.pop(variable, None)
        os.environ["NO_PROXY"] = "*"
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["AUDIO_SEPARATOR_MODEL_DIR"] = str(args.model_dir.resolve())
        for variable, folder in {"NUMBA_CACHE_DIR": "numba", "CUDA_CACHE_PATH": "cuda", "TORCH_HOME": "torch"}.items():
            cache = args.model_dir.parent / "runtime-cache" / folder
            cache.mkdir(parents=True, exist_ok=True)
            os.environ[variable] = str(cache)



        def reject_network(self, method, url, *request_args, **kwargs):
            raise RuntimeError("RoFormer 分离仅使用本地模型，已阻止网络请求：" + str(url))

        requests.sessions.Session.request = reject_network
        if args.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("选择了 GPU 分离，但当前 PyTorch 无法使用 CUDA")
        device = "cuda" if torch.cuda.is_available() and args.device != "cpu" else "cpu"
        torch.set_num_threads(4)
        if device == "cuda":
            torch.cuda.reset_peak_memory_stats()
        report.update(device=device, gpu=torch.cuda.get_device_name(0) if device == "cuda" else None,
                      torch=torch.__version__, cudaRuntime=torch.version.cuda,
                      segment=spec["segment"], overlap=spec["overlap"], batchSize=1)
        progress(8, "加载 RoFormer 模型", device=device, deviceName=report["gpu"] or "CPU")

        class LocalSeparator(Separator):
            def download_model_files(self, model_filename):
                if model_filename != spec["filename"]:
                    raise RuntimeError("不支持的本地 RoFormer 模型")
                return model_filename, "MDXC", spec["name"], str(weights), str(config)

        # 在 CPU 上加载检查点，然后让 MDXC 在移动前应用 FP16
        # 将模型加载到 CUDA。避免在 4 GB 显卡上保留两份全精度副本。
        original_load = RoformerLoader.load_model

        def cpu_checkpoint_load(loader, model_path, config, device="cpu"):
            return original_load(loader, model_path, config, device="cpu")

        RoformerLoader.load_model = cpu_checkpoint_load
        separator = LocalSeparator(model_file_dir=str(args.model_dir.resolve()), output_dir=str(args.output_dir),
                                   output_format="WAV", use_soundfile=True, use_native_fp16=device == "cuda",
                                   mdxc_params={"segment_size": spec["segment"], "override_model_segment_size": True,
                                                "overlap": spec["overlap"], "batch_size": 1, "process_all_stems": True})
        separator.torch_device = torch.device(device)
        started = time.monotonic()
        separator.load_model(spec["filename"])
        instance = separator.model_instance
        actual_device = str(next(instance.model_run.parameters()).device)
        if not actual_device.startswith(device):
            raise RuntimeError("RoFormer 实际执行设备与选择不一致：" + actual_device)
        report.update(actualDevice=actual_device, precision=separator.effective_precision,
                      modelLoadSeconds=round(time.monotonic() - started, 3))
        if device == "cuda":
            torch.cuda.synchronize()
            report["modelLoadPeakMiB"] = round(torch.cuda.max_memory_allocated() / 1048576, 2)
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()

        progress(15, "读取音频", device=device, deviceName=report["gpu"] or "CPU")
        decoded = args.output_dir / "decoded.wav"
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("找不到 FFmpeg，无法读取音频")
        decoded_result = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(args.input),
                                         "-ar", "44100", "-ac", "2", "-c:a", "pcm_f32le", str(decoded)],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                        errors="replace", timeout=300, check=False)
        if decoded_result.returncode:
            raise RuntimeError("读取音频失败：" + decoded_result.stderr[-1200:])
        audio, sample_rate = sf.read(decoded, dtype="float32", always_2d=True)
        if len(audio) == 0 or not np.isfinite(audio).all():
            raise RuntimeError("输入音频为空或包含无效采样值")
        input_peak = float(np.max(np.abs(audio)))
        input_gain = min(1.0, 1.0 / input_peak) if input_peak else 1.0
        mix = (audio * input_gain).T
        original_tqdm = mdxc_separator.tqdm

        def tracked_windows(items, *tqdm_args, **tqdm_kwargs):
            total = len(items)
            for index, item in enumerate(original_tqdm(items, *tqdm_args, **tqdm_kwargs), 1):
                yield item
                progress(18 + int(68 * index / max(1, total)), "正在分离音轨 · %d/%d" % (index, total),
                         device=device, deviceName=report["gpu"] or "CPU")

        mdxc_separator.tqdm = tracked_windows
        progress(18, "正在分离音轨", device=device, deviceName=report["gpu"] or "CPU")
        started = time.monotonic()
        sources = instance.demix(mix)
        if not isinstance(sources, dict):
            raise RuntimeError("RoFormer 未返回完整音轨")
        if device == "cuda":
            torch.cuda.synchronize()
            report["inferencePeakMiB"] = round(torch.cuda.max_memory_allocated() / 1048576, 2)
        report.update(separationSeconds=round(time.monotonic() - started, 3), duration=len(audio) / sample_rate,
                      sampleRate=sample_rate, inputGain=input_gain)
        if any(source.shape != mix.shape for source in sources.values()):
            raise RuntimeError("RoFormer 输出长度与输入不一致")
        progress(90, "合并与保存音轨", device=device, deviceName=report["gpu"] or "CPU")
        tracks, output_gain = write_stems(sources, args.stems, args.output_dir, sample_rate)
        report.update(status="success", tracks=tracks, outputGain=output_gain)
        atomic_write(report_path, report)
        decoded.unlink()
        progress(97, "音轨已保存", device=device, deviceName=report["gpu"] or "CPU")
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    except BaseException as error:
        message = "显存不足，请关闭占用 GPU 的其他程序后重试。" if "out of memory" in str(error).lower() else str(error)
        report.update(status="failed", error=message, traceback=traceback.format_exc())
        atomic_write(report_path, report)
        progress(0, "分离失败", error=message)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--stems", type=int, choices=(2, 4, 5, 6), required=True)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--progress-path", type=Path)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
