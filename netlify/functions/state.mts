import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Single JSON blob storing the live editable overlay for the VIP tracker.
// Shape: { [loginId]: { trialProgress, actionNeeded, notes, done, assign,
//                        actionNeededHeight, notesHeight } }
// This is the same shape the page used to keep in localStorage -- now it
// lives here instead, so two people opening the page see the same data.
const STORE_NAME = "vip-tracker";
const STATE_KEY = "state";

function getStateStore() {
  return getStore(STORE_NAME);
}

export default async (req: Request, context: Context) => {
  const store = getStateStore();

  if (req.method === "GET") {
    const state = (await store.get(STATE_KEY, { type: "json" })) ?? {};
    return new Response(JSON.stringify({ state }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid json" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Bulk replace -- used by "Restore backup" to push a whole downloaded
    // backup file back into the shared store in one shot.
    if (body && body.state && typeof body.state === "object") {
      await store.setJSON(STATE_KEY, body.state);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Single-field update from the tracker UI. We read-merge-write the
    // whole state blob rather than asking the client to send its full
    // local copy, so one person's edit can't stomp on another's.
    const { id, field, value } = body || {};
    if (!id || !field) {
      return new Response(JSON.stringify({ error: "id and field are required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const current = (await store.get(STATE_KEY, { type: "json" })) ?? {};
    if (!current[id]) current[id] = {};
    current[id][field] = value;
    await store.setJSON(STATE_KEY, current);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/state",
};
