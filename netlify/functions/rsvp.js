import { getStore } from "@netlify/blobs";

const STORE_NAME = "rsvp-marco-ilaria";
const KEY = "rsvps";
const MAX_RETRIES = 6;

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function isAuthed(req) {
  const url = new URL(req.url);
  const keyFromQuery = url.searchParams.get("key") || "";
  const keyFromHeader = req.headers.get("x-admin-key") || "";
  const expected = process.env.ADMIN_KEY || "";
  return !!expected && (keyFromQuery === expected || keyFromHeader === expected);
}

function sanitizeString(v, max = 500) {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function toInt(v) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-admin-key",
        "access-control-max-age": "86400",
      },
    });
  }

  const store = getStore(STORE_NAME);

  // ---------- GET (ADMIN) ----------
  if (req.method === "GET") {
    if (!isAuthed(req)) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401, {
        "access-control-allow-origin": "*",
      });
    }

    const data = (await store.get(KEY, { type: "json" })) || [];

    let yesCount = 0;
    let noCount = 0;
    let personsYes = 0;
    let personsNo = 0;

    for (const r of data) {
      const num = toInt(r?.numPersone) || 0;
      if (r?.partecipa === "Sì") {
        yesCount += 1;
        personsYes += num;
      } else if (r?.partecipa === "No") {
        noCount += 1;
        personsNo += num;
      }
    }

    const items = [...data].sort((a, b) =>
      String(b?.createdAt || "").localeCompare(String(a?.createdAt || ""))
    );

    return jsonResponse(
      {
        ok: true,
        totals: {
          rsvp_yes: yesCount,
          rsvp_no: noCount,
          persons_yes: personsYes,
          persons_no: personsNo,
          rsvp_total: data.length,
          persons_total: personsYes + personsNo,
        },
        items,
      },
      200,
      { "access-control-allow-origin": "*" }
    );
  }

  // ---------- POST (SALVATAGGIO RSVP) ----------
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, {
        "access-control-allow-origin": "*",
      });
    }

    const nome = sanitizeString(body.nome, 80);
    const cognome = sanitizeString(body.cognome, 80);
    const contatto = sanitizeString(body.contatto, 120);
    const partecipa = sanitizeString(body.partecipa, 10); // "Sì" / "No"
    const numPersone = toInt(body.numPersone);
    const nominativi = sanitizeString(body.nominativi, 2000);
    const messaggio = sanitizeString(body.messaggio, 2000);

    if (!nome || !cognome || !contatto || !partecipa || !numPersone || !nominativi) {
      return jsonResponse({ ok: false, error: "Missing required fields" }, 400, {
        "access-control-allow-origin": "*",
      });
    }
    if (partecipa !== "Sì" && partecipa !== "No") {
      return jsonResponse({ ok: false, error: "Invalid 'partecipa' value" }, 400, {
        "access-control-allow-origin": "*",
      });
    }

    const guests = nominativi
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const entry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      nome,
      cognome,
      contatto,
      partecipa,
      numPersone,
      nominativi,
      guests,
      messaggio,
      ua: sanitizeString(req.headers.get("user-agent"), 400),
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const got = await store.getWithMetadata(KEY, { type: "json" });
      const current = got?.data || [];
      const etag = got?.etag;

      const next = Array.isArray(current) ? [...current, entry] : [entry];

      const res = await store.setJSON(
        KEY,
        next,
        etag ? { onlyIfMatch: etag } : { onlyIfNew: true }
      );

      if (res?.modified) {
        return jsonResponse({ ok: true, id: entry.id }, 200, {
          "access-control-allow-origin": "*",
        });
      }
    }

    return jsonResponse({ ok: false, error: "Busy, retry" }, 409, {
      "access-control-allow-origin": "*",
    });
  }

  return jsonResponse({ ok: false, error: "Method not allowed" }, 405, {
    "access-control-allow-origin": "*",
  });
};
