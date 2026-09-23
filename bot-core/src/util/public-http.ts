import { lookup } from "node:dns/promises";
import { Agent, request } from "undici";
import { isPublicAddress, isSafeHttpUrl } from "./net.js";

export async function publicAddresses(hostname: string) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("URL resolves to a non-public address");
  }
  return addresses;
}

const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      void publicAddresses(hostname).then(
        (addresses) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
        (error: Error) => callback(error, "", 4),
      );
    },
  },
});

export async function fetchPublicText(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; status: number; body: string; contentType: string; finalUrl: string }> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 18_000);
  const maxBytes = options.maxBytes ?? 500_000;
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isSafeHttpUrl(current)) throw new Error("Blocked or invalid URL");
    const response = await request(current, {
      dispatcher,
      signal,
      headers: { ...options.headers, "accept-encoding": "identity" },
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.body.destroy();
      const location = response.headers.location;
      if (!location || redirects === 5) throw new Error("Invalid or excessive redirects");
      current = new URL(location, current).href;
      continue;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) throw new Error("Response exceeds size limit");
        chunks.push(buffer);
      }
    } finally {
      response.body.destroy();
    }
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      body: Buffer.concat(chunks).toString("utf8"),
      contentType: String(response.headers["content-type"] ?? ""),
      finalUrl: current,
    };
  }
  throw new Error("Too many redirects");
}