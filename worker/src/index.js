const GH_OWNER = "TestMod0";
const GH_REPO = "vip-task-tracker";
const GH_BRANCH = "data";
const GH_PATH = "state.json";
const ALLOWED_ORIGIN = "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...corsHeaders(), ...(init.headers || {}) },
  });
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const apiUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`;
    const ghHeaders = {
      Authorization: "Bearer " + env.GH_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "vip-tracker-worker",
    };

    // GET reads straight from the GitHub Contents API instead of
    // raw.githubusercontent.com. raw.githubusercontent.com is a CDN-backed
    // endpoint that can lag a few seconds behind a just-completed commit
    // even with a cache-busting query string -- the lag is in GitHub's raw-
    // content backend, not just CDN edge caching. That meant a save could
    // succeed, the page's next poll would read the old value, and the page
    // would visually "revert" an edit that was already correctly saved. The
    // Contents API is the same authoritative source the write path uses, so
    // a read here is always consistent with the most recent write.
    if (request.method === "GET") {
      const cur = await fetch(apiUrl + "?ref=" + GH_BRANCH, { headers: ghHeaders });
      if (cur.status === 404) return json({});
      if (!cur.ok) return json({ error: "github read failed", detail: await cur.text() }, { status: 502 });
      const data = await cur.json();
      const text = base64ToUtf8(data.content || "");
      return new Response(text || "{}", { headers: { "content-type": "application/json", ...corsHeaders() } });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, { status: 400 });
    }

    const fullState = body && body.state;
    if (!fullState || typeof fullState !== "object") {
      return json({ error: "state object required" }, { status: 400 });
    }

    // GitHub's Contents API requires the request's sha to exactly match the
    // file's CURRENT sha or it rejects the write with a 409 conflict. On a
    // live multi-user tracker, two saves landing close together is routine:
    // by the time our PUT arrives, someone else's edit may have already
    // moved the sha. Previously that 409 was reported straight to the
    // browser as a failure and the edit was lost. Instead, retry: re-fetch
    // the latest sha and try the write again a few times before giving up.
    let lastDetail = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      let sha;
      const cur = await fetch(apiUrl + "?ref=" + GH_BRANCH, { headers: ghHeaders });
      if (cur.ok) sha = (await cur.json()).sha;

      const put = await fetch(apiUrl, {
        method: "PUT",
        headers: { ...ghHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          message: body.message || "Tracker update",
          content: utf8ToBase64(JSON.stringify(fullState, null, 2)),
          branch: GH_BRANCH,
          ...(sha ? { sha } : {}),
        }),
      });

      if (put.ok) {
        return json({ ok: true, attempts: attempt + 1 });
      }

      lastDetail = await put.text();
      // Only a sha conflict (409) is worth retrying; anything else (bad
      // token, malformed request, etc.) will just fail the same way again.
      if (put.status !== 409) break;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }

    return json({ error: "github write failed", detail: lastDetail }, { status: 502 });
  },
};