import { lookup } from "node:dns/promises";
import net from "node:net";
import { getClientIp, jsonError, rateLimit, sameOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_TEXT = 15000;
const MIN_TEXT = 300;
const TIMEOUT_MS = 8000;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
    if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true; // link-local
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a valid link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https links are allowed.");
  if (url.username || url.password) throw new Error("Links with login details are not allowed.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Only standard web ports are allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("That address is not allowed.");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("That address is not allowed.");
  return url;
}

function decode(s: string) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8377;|&#x20b9;/gi, "₹").replace(/&amp;/g, "&");
}

function htmlToText(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim());
  const desc =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1] ||
    "";
  const body = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|section|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8377;|&#x20b9;/gi, "₹")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  const text = [title, desc, body].filter(Boolean).join("\n").slice(0, MAX_TEXT);
  return { title, text };
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError("Not allowed.", 403);
  const ip = getClientIp(req);
  if (!rateLimit(`fetch:${ip}`, 20, 60 * 60 * 1000)) return jsonError("Too many requests. Please try again in a while.", 429);

  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError("Bad request.", 400);
  }
  if (typeof body.url !== "string" || body.url.length > 2000) return jsonError("Please enter a valid link.", 400);

  try {
    let url = await assertPublicUrl(body.url.trim());
    let res: Response | null = null;
    // Follow up to 3 redirects manually, re-checking every hop.
    for (let i = 0; i < 4; i++) {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; GrowthCrewBot/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
        continue;
      }
      break;
    }
    if (!res || !res.ok || !res.body) return Response.json({ ok: false, reason: "Couldn't open that page." });
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/html") && !type.includes("text/plain")) {
      return Response.json({ ok: false, reason: "That link isn't a web page." });
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    const html = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
    const { title, text } = htmlToText(html);
    if (text.length < MIN_TEXT) return Response.json({ ok: false, reason: "The page had too little readable text." });
    return Response.json({ ok: true, title, text, url: url.toString() });
  } catch (e) {
    const msg = e instanceof Error && /allowed|valid link/.test(e.message) ? e.message : "Couldn't open that page.";
    return Response.json({ ok: false, reason: msg });
  }
}
