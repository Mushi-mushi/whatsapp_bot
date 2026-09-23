import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { request } from "undici";
import { isSafeHttpUrl } from "../src/util/net.js";
import { fetchPublicText, publicAddresses } from "../src/util/public-http.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("undici", () => ({ Agent: class {}, request: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("public URL boundary", () => {
  it.each([
    "http://127.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]",
    "http://[fc00::1]", "http://[fe80::1]", "http://10.0.0.1",
    "http://localhost.", "http://169.254.169.254", "http://100.64.0.1",
    "http://user:password@example.com", "file:///etc/passwd",
  ])("rejects %s", (url) => expect(isSafeHttpUrl(url)).toBe(false));

  it("allows public URLs", () => {
    expect(isSafeHttpUrl("https://example.com")).toBe(true);
    expect(isSafeHttpUrl("https://[2606:4700:4700::1111]")).toBe(true);
  });

  it("rejects DNS answers containing a private address", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
    ]);
    await expect(publicAddresses("example.com")).rejects.toThrow("non-public");
  });

  it("blocks redirects to private addresses before requesting them", async () => {
    const destroy = vi.fn();
    vi.mocked(request).mockResolvedValue({
      statusCode: 302, headers: { location: "http://[::1]/secret" }, body: { destroy },
    } as never);
    await expect(fetchPublicText("https://example.com")).rejects.toThrow("Blocked");
    expect(request).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalled();
  });

  it("stops reading oversized responses", async () => {
    const destroy = vi.fn();
    vi.mocked(request).mockResolvedValue({
      statusCode: 200, headers: {}, body: {
        destroy,
        async *[Symbol.asyncIterator]() { yield Buffer.alloc(11); },
      },
    } as never);
    await expect(fetchPublicText("https://example.com", { maxBytes: 10 })).rejects.toThrow("size limit");
    expect(destroy).toHaveBeenCalled();
  });
});