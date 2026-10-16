# Spleeter Studio

<p align="center">
  <img src="../assets/icon.png" width="180" alt="Spleeter Studio application icon">
</p>

Spleeter Studio 是一个 Windows 桌面多轨音频分离工具。它使用本地 PyTorch RoFormer 模型创建 2、4、5、6 轨项目，并提供波形播放、音量/静音/独奏/声像控制和 WAV 音轨 ZIP 导出。

## 运行环境

- Windows x64
- Python 3.10 或更高
- `audio-separator==0.47.0`、PyTorch、`numpy`、`soundfile`、`PyYAML`、`requests`
- `ffmpeg` 与 `ffprobe`，并已加入 PATH

可创建一个独立 Python 环境：

```bat
conda create -n SpleeterRoFormer python=3.11
conda activate SpleeterRoFormer
pip install audio-separator==0.47.0 torch numpy soundfile pyyaml requests
```

然后在应用中点击“选择 Python”，选择这个环境的 `python.exe`。使用 NVIDIA GPU 时，请按你的 CUDA 驱动和显卡从 [PyTorch 官网](https://pytorch.org/get-started/locally/) 安装对应版本的 PyTorch；没有 CUDA 时程序会使用 CPU。

## 下载并放置模型

创建一个模型目录，例如：

```text
E:\Spleeter\RoFormerModels
```

从以下模型页面下载文件：

| 模型页面 | 下载文件 | 放入模型目录后的文件名 |
| --- | --- | --- |
| [Mel-Band RoFormer Big Beta 6X](https://huggingface.co/pcunwa/Mel-Band-Roformer-big) | `big_beta6x.ckpt` | `melband_roformer_big_beta6x.ckpt` |
| 同上 | `big_beta6x.yaml` | `config_melbandroformer_big_beta6x.yaml` |
| [BS RoFormer SW Fixed](https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed) | `BS-Rofo-SW-Fixed.ckpt` | `BS-Rofo-SW-Fixed.ckpt` |
| 同上 | `BS-Rofo-SW-Fixed.yaml` | `BS-Rofo-SW-Fixed.yaml` |

最终目录必须正好包含以下四个文件：

```text
E:\Spleeter\RoFormerModels\
  melband_roformer_big_beta6x.ckpt
  config_melbandroformer_big_beta6x.yaml
  BS-Rofo-SW-Fixed.ckpt
  BS-Rofo-SW-Fixed.yaml
```

在 Windows 中设置模型目录后，重新启动应用：

```bat
setx ROFORMER_MODEL_DIR "E:\Spleeter\RoFormerModels"
```

也可以临时设置环境变量：

```bat
set ROFORMER_MODEL_DIR=E:\Spleeter\RoFormerModels
npm start
```

模型由原作者发布，不属于本项目的 MIT 代码许可证；请遵守模型页面上适用的许可证和使用条件。

## 启动与打包

在项目根目录运行：

```bat
npm install
npm start
```

构建 Windows 安装包：

```bat
npm run check
npm run dist
```

安装包输出到 `dist\Spleeter-Studio-Setup-1.1.0.exe`。
