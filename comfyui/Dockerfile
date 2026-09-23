# Core ComfyUI on a CUDA 12.8 base with nightly cu128 PyTorch so it runs on
# Blackwell GPUs (RTX 50-series, sm_120). Custom nodes are intentionally NOT
# installed here — the models/input/output/user folders are bind-mounted from the
# host, so this reuses your existing models and workflows.
FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime@sha256:c16f4c749e2d9e96878875cdf6cc45cddda1d1a36fddd371dd6f2360f1b6e2a2

ARG COMFYUI_COMMIT=b33e2b55cae074eca5aec96283cceac19aa249ba
ARG TORCH_VERSION=2.12.0.dev20260408+cu128
ARG TORCHVISION_VERSION=0.27.0.dev20260407+cu128

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_PREFER_BINARY=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git wget libgl1 libglib2.0-0 ffmpeg build-essential && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git init ComfyUI && cd ComfyUI && \
  git remote add origin https://github.com/comfyanonymous/ComfyUI.git && \
  git fetch --depth 1 origin "$COMFYUI_COMMIT" && git checkout --detach FETCH_HEAD
WORKDIR /app/ComfyUI

# Core ComfyUI Python requirements.
RUN pip install -r requirements.txt

# This exact nightly pair matches the working Blackwell deployment. The
# torchvision metadata pins a different day; do not float either version.
RUN pip uninstall -y torch torchvision torchaudio || true && \
    pip install --no-cache-dir "torch==$TORCH_VERSION" \
      --index-url https://download.pytorch.org/whl/nightly/cu128 && \
    pip install --no-cache-dir --no-deps "torchvision==$TORCHVISION_VERSION" \
      --index-url https://download.pytorch.org/whl/nightly/cu128

EXPOSE 8188
CMD ["python", "main.py", "--listen", "--port", "8188"]
