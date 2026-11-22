// Basic protection for the public API routes.
// Note: on Vercel, memory is per server instance, so these limits are "best effort".
// The real hard cap is the monthly spend limit you set in the Claude Console.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/** Returns true if the request is allowed. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    }
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}

/** Blocks calls made from other websites' pages (browser requests carry an Origin header). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin GET/POST from some browsers, or server tools
  try {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}
