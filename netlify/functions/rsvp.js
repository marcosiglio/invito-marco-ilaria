import { getStore } from "@netlify/blobs";

const STORE_NAME = "rsvp-marco-ilaria";
const KEY = "rsvps";
const MAX_RETRIES = 10;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-key",
    "access-control-max-age": "86400",
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPreconditionError(e) {
  const msg = String(e?.message || e || "");
  // in base a come Netlify/Blobs segnala il mismatch di ETag
  return (
    msg.includes("412") ||
    msg.toLowerCase().includes("precondition") ||
    msg.toLowerCase().includes("onlyifmatch") ||
    msg.toLowerCase().includes("condition")
  );
}

export default async (req) => {
  // Preflight CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const store = getStore(STORE_NAME);

  // ---------- GET (ADMIN) ----------
  if (req.method === "GET") {
    if (!isAuthed(req)) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
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
        personsNo += num;
      }
    }

    // ritorno già ordinato (utile)
    const items = [...data].sort((a, b) =>
      String(b?.createdAt || "").localeCompare(String(a?.createdAt || ""))
    );

    return jsonResponse({
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
    });
  }

  // ---------- POST (SALVATAGGIO RSVP) ----------
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const nome = sanitizeString(body.nome, 80);
    const cognome = sanitizeString(body.cognome, 80);
    const contatto = sanitizeString(body.contatto, 120);
    const partecipa = sanitizeString(body.partecipa, 10);
    let numPersone = toInt(body.numPersone);
    let nominativi = sanitizeString(body.nominativi, 2000);
    const messaggio = sanitizeString(body.messaggio, 2000);

    if (!nome || !cognome || !contatto || !partecipa) {
      return jsonResponse({ ok: false, error: "Missing required fields" }, 400);
    }
    if (partecipa !== "Sì" && partecipa !== "No") {
      return jsonResponse({ ok: false, error: "Invalid 'partecipa' value" }, 400);
    }

    // se NO → non obbligo nulla
    if (partecipa === "No") {
      numPersone = 0;
      nominativi = "";
    }

    // se SI → obbligo numPersone e nominativi
    if (partecipa === "Sì") {
      if (!numPersone || numPersone < 1) {
        return jsonResponse({ ok: false, error: "Inserisci quante persone siete" }, 400);
      }
      if (!nominativi) {
        return jsonResponse({ ok: false, error: "Inserisci i nominativi" }, 400);
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

    // Append con retry + ETag compatibile (etag può stare in metadata.etag)
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const got = await store.getWithMetadata(KEY, { type: "json" });

        const current = Array.isArray(got?.data) ? got.data : [];
        const etag = got?.etag || got?.metadata?.etag; // ✅ FIX

        const next = [...current, entry];

        // Se ho etag → scrivo condizionale
        // Se NON ho etag:
        //   - se non c’è ancora nulla → onlyIfNew
        //   - se esiste già qualcosa → scrittura normale (fallback)
        let options = undefined;
        if (etag) options = { onlyIfMatch: etag };
        else if (current.length === 0) options = { onlyIfNew: true };

        await store.setJSON(KEY, next, options);

        // se non lancia eccezioni, considero riuscito
        return jsonResponse({ ok: true, id: entry.id }, 200);
      } catch (e) {
        // se è precondition/concurrency → aspetto e ritento
        if (isPreconditionError(e) && attempt < MAX_RETRIES) {
          await sleep(120 * attempt);
          continue;
        }
        // se non è precondition, comunque provo ancora un paio di volte
        if (attempt < MAX_RETRIES) {
          await sleep(120 * attempt);
          continue;
        }
      }
    }

    return jsonResponse({ ok: false, error: "Busy, retry" }, 409);
  }

  return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
};
