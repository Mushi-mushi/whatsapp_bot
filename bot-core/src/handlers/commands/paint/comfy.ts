import type { Workflow } from "./workflows.js";

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyVideoRef {
  filename: string;
  subfolder: string;
  type: string;
}

interface HistoryEntry {
  outputs?: Record<string, {
    images?: ComfyImageRef[];
    gifs?: ComfyVideoRef[];
    videos?: ComfyVideoRef[];
    animated?: boolean[];
  }>;
  status?: { status_str?: string };
}

// Queue a workflow for execution; returns the prompt id to poll on.
export async function queuePrompt(
  base: string,
  workflow: Workflow,
  clientId: string,
): Promise<string> {
  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`queue failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { prompt_id?: string };
  if (!data.prompt_id) throw new Error("no prompt_id returned");
  return data.prompt_id;
}

// Upload a source photo into ComfyUI's input folder for img2img; returns the
// name to reference from a LoadImage node.
export async function uploadImage(base: string, image: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image)]), filename);
  form.append("type", "input");
  form.append("overwrite", "true");
  const res = await fetch(`${base}/upload/image`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`image upload failed (${res.status})`);
  const data = (await res.json()) as { name?: string; subfolder?: string };
  if (!data.name) throw new Error("upload returned no name");
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

// Poll history until the prompt produces an output image (or times out).
export async function waitForImage(
  base: string,
  promptId: string,
  timeoutMs: number,
): Promise<ComfyImageRef> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const hist = (await res.json()) as Record<string, HistoryEntry>;
      const entry = hist[promptId];
      if (entry?.outputs) {
        for (const out of Object.values(entry.outputs)) {
          const img = out.images?.find((i) => i.type === "output") ?? out.images?.[0];
          if (img) return img;
        }
        if (entry.status?.status_str === "error") throw new Error("generation failed in ComfyUI");
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("timed out waiting for the image");
}

// Poll history until the prompt produces a video-like output.
export async function waitForVideo(
  base: string,
  promptId: string,
  timeoutMs: number,
): Promise<ComfyVideoRef> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const hist = (await res.json()) as Record<string, HistoryEntry>;
      const entry = hist[promptId];
      if (entry?.outputs) {
        for (const out of Object.values(entry.outputs)) {
          const video = out.videos?.find((v) => v.type === "output") ?? out.videos?.[0]
            ?? out.gifs?.find((v) => v.type === "output") ?? out.gifs?.[0];
          if (video) return video;
          const animatedImage = (out.animated?.some(Boolean)
            ? out.images?.find((i) => /\.(?:mp4|webm|mkv)$/i.test(i.filename))
            : undefined)
            ?? out.images?.find((i) => /\.(?:mp4|webm|mkv)$/i.test(i.filename));
          if (animatedImage) return animatedImage;
        }
        if (entry.status?.status_str === "error") throw new Error("generation failed in ComfyUI");
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("timed out waiting for the video");
}

export async function fetchImage(base: string, ref: ComfyImageRef): Promise<Buffer> {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "output",
  });
  const res = await fetch(`${base}/view?${params.toString()}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`fetch image failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchVideo(base: string, ref: ComfyVideoRef): Promise<Buffer> {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "output",
  });
  const res = await fetch(`${base}/view?${params.toString()}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`fetch video failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
