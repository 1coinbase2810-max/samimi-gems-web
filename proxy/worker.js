/**
 * samimi Gems — CORS proxy (Cloudflare Workers, free plan)
 *
 * Why this exists: the Nara router does NOT send Access-Control-Allow-Origin,
 * so a browser page (e.g. on GitHub Pages) cannot call it directly — the
 * browser blocks the response (CORS). curl / the Telegram bot are unaffected.
 * This tiny worker forwards the exact OpenAI-compatible request server-side
 * (where CORS does not apply) and adds `Access-Control-Allow-Origin: *`.
 *
 * Security: the worker NEVER stores or logs the key. The key stays in the
 * user's browser and is only forwarded in the Authorization header, exactly
 * as the browser would send it. Deploy it under YOUR Cloudflare account.
 *
 * Deploy (2 minutes):
 *   cd proxy
 *   npm i -g wrangler        # if needed
 *   wrangler login
 *   wrangler deploy
 * Then copy the workers.dev URL into the website: Settings -> Proxy URL.
 * The website calls <proxy-url>/chat/completions and <proxy-url>/models,
 * exactly like it would call the router directly; the worker routes by path.
 *
 * Optional: set NARA_BASE as a var in wrangler.toml to point elsewhere.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, proxy: "samimi-gems" }), {
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: CORS });
    }
    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: { message: "Missing Bearer key" } }), {
        status: 401, headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    const base = (env.NARA_BASE || "https://router.bynara.id/v1").replace(/\/+$/, "");
    const url = new URL(request.url);
    if (url.pathname === "/models") {
      const upstream = await fetch(`${base}/models`, {
        headers: { Authorization: auth },
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json", ...CORS },
      });
    }
    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: { message: "Bad JSON" } }), {
        status: 400, headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    const init = { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth } };
    init.body = JSON.stringify(body);
    const upstream = await fetch(`${base}/chat/completions`, init);
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json", ...CORS },
    });
  },
};
