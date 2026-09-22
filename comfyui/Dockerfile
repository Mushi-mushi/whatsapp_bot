# Core ComfyUI on a CUDA 12.8 base with nightly cu128 PyTorch so it runs on
# Blackwell GPUs (RTX 50-series, sm_120). Custom nodes are intentionally NOT
# installed here — the models/input/output/user folders are bind-mounted from the
# host, so this reuses your existing models and workflows.
FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_PREFER_BINARY=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git wget libgl1 libglib2.0-0 ffmpeg build-essential && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git
WORKDIR /app/ComfyUI

# Core ComfyUI Python requirements.
RUN pip install -r requirements.txt

# Nightly cu128 PyTorch so the fp8 flux models run natively on Blackwell. Stable
# torch 2.7.1 casts fp8 weights up to bf16 (~2x VRAM), which overflows a 16GB
# card and stalls flux. torch and torchvision nightlies can lag each other by a
# day, so install torch first, then torchvision with --no-deps to skip its
# exact same-day torch pin (a one-day nightly gap is ABI-compatible).
RUN pip uninstall -y torch torchvision torchaudio || true && \
    pip install --pre --no-cache-dir torch \
      --index-url https://download.pytorch.org/whl/nightly/cu128 && \
    pip install --pre --no-cache-dir --no-deps torchvision \
      --index-url https://download.pytorch.org/whl/nightly/cu128

EXPOSE 8188
CMD ["python", "main.py", "--listen", "--port", "8188"]
