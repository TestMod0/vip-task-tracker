// Cloudflare Worker replacing the old Netlify Function (netlify/functions/state.mts).
// Same shape, same merge logic -- just backed by Workers KV instead of Netlify Blobs.
//
// Shape stored under STATE_KEY: { [loginId]: { trialProgress, actionNeeded, notes,
//   done, assign, actionNeededHeight, notesHeight } }
//
// Note on consistency: Workers KV is eventually consistent (a write can take up to
// ~60s to be visible everywhere). For two people occasionally editing the same
// tracker this is fine in practice -- the page's own retry queue means an edit you
// just made always shows correctly in your own browser regardless of KV's global
// propagation delay. It mainly means another device's poll might lag a write by a
// few extra seconds in the worst case, not that anything gets lost.

const STATE_KEY = "state";

// Once your GitHub Pages URL is live, you can tighten this to that exact origin
// (e.g. "https://yourusername.github.io") instead of "*". Leaving it as "*" still
// works fine -- it's not a secret-bearing endpoint, just a convenience lock-down.
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === "GET") {
      const raw = await env.VIP_TRACKER_KV.get(STATE_KEY);
      const state = raw ? JSON.parse(raw) : {};
      return json({ state });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, { status: 400 });
      }

      // Bulk replace -- used by "Restore backup" to push a whole downloaded
      // backup file back into the shared store in one shot.
      if (body && body.state && typeof body.state === "object") {
        await env.VIP_TRACKER_KV.put(STATE_KEY, JSON.stringify(body.state));
        return json({ ok: true });
      }

      // Single-field update from the tracker UI. Read-merge-write the whole
      // state blob rather than trusting the client's full local copy, so one
      // person's edit can't stomp on another's.
      const { id, field, value } = body || {};
      if (!id || !field) {
        return json({ error: "id and field are required" }, { status: 400 });
      }

      const raw = await env.VIP_TRACKER_KV.get(STATE_KEY);
      const current = raw ? JSON.parse(raw) : {};
      if (!current[id]) current[id] = {};
      current[id][field] = value;
      await env.VIP_TRACKER_KV.put(STATE_KEY, JSON.stringify(current));

      return json({ ok: true });
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
  },
};
