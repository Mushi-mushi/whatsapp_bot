import type { Handler } from "../../router/router.js";
import { ollamaChat, ollamaErrorMessage } from "../../util/ollama.js";
import { decodeEntities, extractReadable, isSafeHttpUrl } from "../../util/net.js";
import { fetchPublicText } from "../../util/public-http.js";

function readerFallbackUrls(url: string): string[] {
  const stripped = url.replace(/^https?:\/\//i, "");
  return [
    `https://r.jina.ai/http://${stripped}`,
    `https://r.jina.ai/${url}`,
  ];
}

async function fetchPage(url: string): Promise<
  | { ok: true; status: number; contentType: string; body: string; finalUrl: string }
  | { ok: false; status?: number; timeout?: boolean }
> {
  try {
    const res = await fetchPublicText(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; whatsapp-bot tldr)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeoutMs: 18_000,
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ...res, ok: true };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, timeout: timedOut };
  }
}

function extractMetaTag(html: string, key: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`,
    "i",
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

function extractRedditReadable(html: string): { title: string; text: string } {
  const title =
    extractMetaTag(html, "og:title") ||
    extractMetaTag(html, "twitter:title") ||
    extractReadable(html).title;
  const desc =
    extractMetaTag(html, "description") ||
    extractMetaTag(html, "og:description") ||
    extractMetaTag(html, "twitter:description");

  const ldJsonMatch = html.match(/"articleBody"\s*:\s*"([\s\S]*?)"/i);
  const articleBody = ldJsonMatch
    ? decodeEntities(ldJsonMatch[1].replace(/\\n/g, " ").replace(/\\"/g, '"')).replace(/\s+/g, " ").trim()
    : "";

  const parts = [desc, articleBody].filter(Boolean);
  return { title, text: parts.join("\n") };
}

function stripHtml(s: string): string {
  return decodeEntities(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchRedditRss(postUrl: string): Promise<{ title: string; text: string } | null> {
  const clean = postUrl.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const rssUrl = clean.endsWith(".rss") ? clean : `${clean}/.rss`;
  const rss = await fetchPage(rssUrl);
  if (!rss.ok) return null;

  const xml = rss.body;
  const entries = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  if (!entries.length) return null;

  let bestTitle = "";
  let bestText = "";
  for (const entry of entries.slice(0, 8)) {
    const titleRaw = entry.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const title = stripHtml(titleRaw);
    if (!title || /^comment by /i.test(title)) continue;

    const contentRaw = entry.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i)?.[1] ?? "";
    const summaryRaw = entry.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? "";
    const body = stripHtml(contentRaw || summaryRaw);
    if (body.length > bestText.length) {
      bestTitle = title;
      bestText = body;
    }
  }

  if (!bestTitle || bestText.length < 120) return null;
  return { title: bestTitle, text: bestText };
}

function looksLikeBlockedPage(text: string): boolean {
  return /(\b403\b|forbidden|access is currently restricted|blocked by network security|provide a developer token|captcha|cloudflare)/i.test(
    text,
  );
}

async function fetchRedditOembed(postUrl: string): Promise<{
  title: string;
  authorName: string;
  providerName: string;
} | null> {
  try {
    const u = `https://www.reddit.com/oembed?url=${encodeURIComponent(postUrl)}`;
    const res = await fetchPublicText(u, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; whatsapp-bot tldr)",
        Accept: "application/json,text/plain,*/*",
      },
      timeoutMs: 10_000,
    });
    if (!res.ok) return null;
    const data = JSON.parse(res.body) as {
      title?: unknown;
      author_name?: unknown;
      provider_name?: unknown;
    };
    const title = typeof data.title === "string" ? data.title.trim() : "";
    const authorName = typeof data.author_name === "string" ? data.author_name.trim() : "";
    const providerName = typeof data.provider_name === "string" ? data.provider_name.trim() : "Reddit";
    if (!title) return null;
    return { title, authorName, providerName };
  } catch {
    return null;
  }
}

// bot.tldr <url> — fetch a web page and summarize it with the local LLM.
export const tldr: Handler = async (ctx) => {
  const cfg = ctx.config;
  if (!cfg.askEnabled) {
    await ctx.reply("AI features are disabled (enable them in Settings).");
    return;
  }
  const url = ctx.args.trim().split(/\s+/)[0];
  if (!url || !isSafeHttpUrl(url)) {
    await ctx.reply("Usage: `bot.tldr https://example.com/article` (public http/https pages only).");
    return;
  }

  let title = "";
  let text = "";
  let usedReaderFallback = false;
  let usedRedditRss = false;
  let metadataOnly = false;
  const host = new URL(url).hostname.toLowerCase();

  const primary = await fetchPage(url);
  if (primary.ok) {
    const ct = primary.contentType.toLowerCase();
    if (ct.includes("text/html") || ct.includes("text/plain")) {
      const readable = extractReadable(primary.body);
      title = readable.title;
      text = readable.text;

      // Reddit is heavily client-rendered; meta tags are often the best source.
      if (host.endsWith("reddit.com") && text.length < 200) {
        const reddit = extractRedditReadable(primary.body);
        if (reddit.title) title = reddit.title;
        if (reddit.text.length >= 120) text = reddit.text;
      }
    }
  }

  // Reddit is heavily client-rendered and often inaccessible via API from DC IPs.
  // If body extraction failed, try the public RSS feed first.
  if (host.endsWith("reddit.com") && text.length < 200 && primary.ok) {
    const rss = await fetchRedditRss(primary.finalUrl || url);
    if (rss) {
      title = rss.title;
      text = rss.text;
      usedRedditRss = true;
    }
  }

  // If RSS wasn't enough, try oEmbed metadata from the canonical post URL.
  if (host.endsWith("reddit.com") && text.length < 200 && primary.ok) {
    const meta = await fetchRedditOembed(primary.finalUrl || url);
    if (meta) {
      title = meta.title;
      text = `Source: ${meta.providerName}\nAuthor: ${meta.authorName || "unknown"}\nURL: ${primary.finalUrl || url}\nThis summary is based on Reddit metadata because full post text is not accessible from this network.`;
      metadataOnly = true;
    }
  }

  // Some publishers/social sites block generic bots (403) or render little static
  // HTML. Fallback to a readability mirror to salvage article text.
  const needFallback =
    !text ||
    text.length < 200 ||
    (!primary.ok && (primary.status === 401 || primary.status === 403 || primary.status === 406 || primary.status === 429));

  if (needFallback && !host.endsWith("reddit.com")) {
    for (const fallbackUrl of readerFallbackUrls(url)) {
      const alt = await fetchPage(fallbackUrl);
      if (!alt.ok) continue;
      const body = alt.body.trim();
      if (!body) continue;
      if (looksLikeBlockedPage(body)) continue;
      usedReaderFallback = true;
      if (!title) {
        const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
        title = firstLine.slice(0, 180);
      }
      text = body;
      break;
    }
  }

  if (!text || text.length < 200) {
    if (!primary.ok && primary.timeout) {
      await ctx.reply("Fetching that page timed out.");
      return;
    }
    if (!primary.ok && primary.status) {
      await ctx.reply(`Couldn't fetch that page (${primary.status}).`);
      return;
    }
    if (host.endsWith("reddit.com")) {
      await ctx.reply("I couldn't extract enough readable Reddit content from that link. Try opening the post and sharing the full comments URL.");
      return;
    }
    await ctx.reply("I couldn't find enough readable text on that page.");
    return;
  }

  const r = await ollamaChat(
    cfg,
    [
      {
        role: "system",
        content:
          "Summarize the following web page in 3-5 concise bullet points using '-' bullets. Plain text only, be factual, no preamble.",
      },
      { role: "user", content: `${title ? `Title: ${title}\n\n` : ""}${text.slice(0, 15000)}` },
    ],
    // Summarizing a long page is prefill-heavy; give it extra headroom.
    { numPredict: 350, timeoutMs: 180_000 },
  );
  if (!r.ok) {
    await ctx.reply(ollamaErrorMessage(r, cfg.ollamaModel));
    return;
  }
  const sourceHint = usedReaderFallback ? " (reader fallback)" : "";
  const rssHint = usedRedditRss ? " (reddit rss)" : "";
  const metadataHint = metadataOnly ? " (metadata fallback)" : "";
  await ctx.reply(`📰 ${title ? `${title}${sourceHint}${rssHint}${metadataHint}\n` : ""}${r.content}`);
};
