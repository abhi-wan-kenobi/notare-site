/**
 * Notare+ waitlist — Cloudflare Pages Function
 *
 * POST /api/waitlist
 *   Accepts JSON  { email, source?, website? }        (website = honeypot)
 *   or form-encoded (no-JS fallback from /plus — redirects back with a flag).
 *
 * Storage: KV binding `WAITLIST` (namespace "notare-waitlist")
 *   key   email:<lowercased email>
 *   value { ts: ISO date, source: string, ua: string }
 *
 * Deliberately NO read/list/export endpoint. Export the list with:
 *   npx wrangler kv key list --namespace-id <id> --prefix "email:"
 *
 * Self-contained: no dependencies, minimal inline types instead of
 * @cloudflare/workers-types.
 */

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

interface Env {
  WAITLIST: KVNamespace;
}

interface PagesContext {
  request: Request;
  env: Env;
}

// ---------------------------------------------------------------- config

const MAX_EMAIL_LEN = 254; // RFC 5321 overall cap
const MAX_LOCAL_LEN = 64; // RFC 5321 local-part cap
const MAX_SOURCE_LEN = 64;
const MAX_UA_LEN = 256;
const MAX_BODY_BYTES = 4096;

// Best-effort per-IP rate limit (KV counter with TTL). KV is eventually
// consistent, so this is a speed bump, not a wall — that's fine.
const RATE_LIMIT = 10; // requests…
const RATE_WINDOW_S = 3600; // …per hour per IP

// Simple RFC-ish email shape: one @, sane charsets, dotted domain, no spaces.
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// ---------------------------------------------------------------- helpers

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isValidEmail(email: string): boolean {
  if (email.length > MAX_EMAIL_LEN) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at > MAX_LOCAL_LEN) return false;
  return EMAIL_RE.test(email);
}

/**
 * Same-origin only. Browsers on notare.dev send no Origin (or the site's own)
 * for same-origin fetches; any cross-site Origin gets refused. Requests with
 * no Origin header (curl, native form posts) are allowed — CORS is a browser
 * concept and there is nothing secret in the responses anyway.
 */
function crossOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- handler

export async function onRequestPost(ctx: PagesContext): Promise<Response> {
  const { request, env } = ctx;

  if (crossOrigin(request)) {
    return json({ success: false, error: "forbidden" }, 403);
  }

  // ---- parse body: JSON (fetch path) or form-encoded (no-JS fallback)
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");

  let email = "";
  let source = "";
  let honeypot = "";
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ success: false, error: "payload_too_large" }, 413);
    }
    if (isForm) {
      const params = new URLSearchParams(raw);
      email = params.get("email") ?? "";
      source = params.get("source") ?? "";
      honeypot = params.get("website") ?? "";
    } else {
      const data = JSON.parse(raw) as Record<string, unknown>;
      email = typeof data.email === "string" ? data.email : "";
      source = typeof data.source === "string" ? data.source : "";
      honeypot = typeof data.website === "string" ? data.website : "";
    }
  } catch {
    return json({ success: false, error: "bad_request" }, 400);
  }

  // No-JS form posts get redirected back to /plus with a status flag.
  const redirectBack = (flag: string): Response =>
    isForm
      ? new Response(null, {
          status: 303,
          headers: { location: `/plus?waitlist=${flag}#waitlist` },
        })
      : json(
          flag === "already"
            ? { success: true, already: true }
            : flag === "ok"
              ? { success: true }
              : { success: false, error: flag },
          flag === "ok" || flag === "already" ? 200 : 400,
        );

  // ---- honeypot: bots fill it; pretend everything went fine.
  if (honeypot.trim() !== "") {
    return redirectBack("ok");
  }

  // ---- validate + normalize
  email = email.trim().toLowerCase();
  if (!isValidEmail(email)) {
    return redirectBack("invalid");
  }

  // ---- best-effort rate limit per IP (before any KV write for the email)
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";
  const rlKey = `rl:${ip}`;
  try {
    const count = parseInt((await env.WAITLIST.get(rlKey)) ?? "0", 10) || 0;
    if (count >= RATE_LIMIT) {
      return json({ success: false, error: "rate_limited" }, 429);
    }
    // Note: TTL refreshes on each write, so the window slides. Cheap and fine.
    await env.WAITLIST.put(rlKey, String(count + 1), {
      expirationTtl: RATE_WINDOW_S,
    });
  } catch {
    // KV hiccup on the limiter must never block a signup — carry on.
  }

  // ---- idempotent store
  const key = `email:${email}`;
  const existing = await env.WAITLIST.get(key);
  if (existing !== null) {
    return redirectBack("already");
  }

  const record = {
    ts: new Date().toISOString(),
    source: source.slice(0, MAX_SOURCE_LEN) || "plus-page",
    ua: (request.headers.get("user-agent") || "").slice(0, MAX_UA_LEN),
  };
  await env.WAITLIST.put(key, JSON.stringify(record));

  return redirectBack("ok");
}

// Anything that isn't POST: 405. (Also swallows CORS preflights — we never
// emit Access-Control-Allow-* headers, so cross-origin JS can't read replies.)
export async function onRequest(ctx: PagesContext): Promise<Response> {
  if (ctx.request.method === "POST") return onRequestPost(ctx);
  return json({ success: false, error: "method_not_allowed" }, 405);
}
