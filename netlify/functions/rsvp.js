import { getStore } from "@netlify/blobs";

const STORE_NAME = "rsvp-marco-ilaria";
const KEY = "rsvps";
const MAX_RETRIES = 10;

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

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-key",
    "access-control-max-age": "86400",
  };
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async (req) => {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const store = getStore(STORE_NAME);

  // ---------- GET (ADMIN) ----------
  if (req.method === "GET") {
    if (!isAuthed(req)) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401, corsHeaders());
    }

    const data = (await store.get(KEY, { type: "json" })) || [];

    let yesCount = 0;
    let noCount = 0;
    let personsYes = 0;
    let personsNo = 0;

    for (const r of data) {
      const partecipa = String(r?.partecipa ?? "").trim();
      const num = toInt(r?.numPersone) || 0;

      if (partecipa === "Sì") {
        yesCount += 1;
        personsYes += num;
      } else if (partecipa === "No") {
        noCount += 1;
        personsNo += num; // di solito 0
      }
    }

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
        items: data,
      },
      200,
      corsHeaders()
    );
  }

  // ---------- POST (SALVATAGGIO RSVP) ----------
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders());
    }

    const nome = sanitizeString(body.nome, 80);
    const cognome = sanitizeString(body.cognome, 80);
    const contatto = sanitizeString(body.contatto, 120);
    const partecipa = sanitizeString(body.partecipa, 10); // "Sì" / "No"
    let numPersone = toInt(body.numPersone);
    let nominativi = sanitizeString(body.nominativi, 2000);
    const messaggio = sanitizeString(body.messaggio, 2000);

    // base required
    if (!nome || !cognome || !contatto || !partecipa) {
      return jsonResponse({ ok: false, error: "Missing required fields" }, 400, corsHeaders());
    }
    if (partecipa !== "Sì" && partecipa !== "No") {
      return jsonResponse({ ok: false, error: "Invalid 'partecipa' value" }, 400, corsHeaders());
    }

    // Regole: se NO → numPersone=0 e nominativi vuoto (non obbligatori)
    if (partecipa === "No") {
      numPersone = 0;
      nominativi = "";
    }

    // Regole: se SI → numPersone e nominativi obbligatori
    if (partecipa === "Sì") {
      if (!numPersone || numPersone < 1) {
        return jsonResponse(
          { ok: false, error: "Per partecipare: inserisci quante persone siete" },
          400,
          corsHeaders()
        );
      }
      if (!nominativi) {
        return jsonResponse(
          { ok: false, error: "Per partecipare: inserisci i nominativi" },
          400,
          corsHeaders()
        );
      }
    }

    const entry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      nome,
      cognome,
      contatto,
      partecipa,
      numPersone: numPersone ?? 0,
      nominativi,
      messaggio,
      ua: sanitizeString(req.headers.get("user-agent"), 400),
    };

    // Append “sicuro” con retry usando ETag
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const got = await store.getWithMetadata(KEY, { type: "json" });
      const current = Array.isArray(got?.data) ? got.data : [];
      const etag = got?.etag;

      const next = [...current, entry];

      const res = await store.setJSON(
        KEY,
        next,
        etag ? { onlyIfMatch: etag } : { onlyIfNew: true }
      );

      if (res?.modified) {
        return jsonResponse({ ok: true, id: entry.id }, 200, corsHeaders());
      }

      // se non modified → qualcuno ha scritto prima: attendo e ritento
      await sleep(120 * attempt);
    }

    // Se ancora nulla → ritorno 409 Busy
    return jsonResponse({ ok: false, error: "Busy, retry" }, 409, corsHeaders());
  }

  return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders());
};
