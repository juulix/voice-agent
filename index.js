import express from "express";
import Busboy from "busboy";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

// ------------------ ENV ------------------
const PORT = process.env.PORT || 3000;
const APP_BEARER_TOKEN = process.env.APP_BEARER_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

// Limits (var mainīt ar ENV vēlāk)
const BASIC_DAILY = Number(process.env.BASIC_DAILY || 5);
const PRO_DAILY   = Number(process.env.PRO_DAILY   || 10);
const PRO_MONTHLY = Number(process.env.PRO_MONTHLY || 300);
// Iekšējais “piedošanas” buferis (UI to neredz)
const GRACE_DAILY = Number(process.env.GRACE_DAILY || 2);

// ---------------- OPENAI/APP ----------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
app.use(express.json({ limit: "10mb" }));

// ---------------- Helpers ----------------
function guessMime(filename) {
  const f = (filename || "").toLowerCase();
  if (f.endsWith(".m4a") || f.endsWith(".mp4")) return "audio/mp4";
  if (f.endsWith(".mp3") || f.endsWith(".mpga")) return "audio/mpeg";
  if (f.endsWith(".wav")) return "audio/wav";
  if (f.endsWith(".webm")) return "audio/webm";
  return "application/octet-stream";
}

function toRigaISO(d) {
  const tz = "Europe/Riga";
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(d);
  const parts = Object.fromEntries(f.map(p => [p.type, p.value]));
  const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  const utc = d.getTime();
  const offsetMin = Math.round((local - utc) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
}

function rigaOffsetMinutes(date = new Date()) {
  const iso = toRigaISO(date); // "YYYY-MM-DDTHH:MM:SS+HH:MM"
  const m = iso.match(/[+-]\d{2}:\d{2}$/);
  if (!m) return 0;
  const [h, min] = m[0].split(":");
  const sign = h.startsWith("-") ? -1 : 1;
  const hh = Math.abs(parseInt(h, 10));
  const mm = parseInt(min, 10);
  return sign * (hh * 60 + mm);
}

function rigaMidnightResetISO() {
  // Nākamā vietējā pusnakts (droši pret i18n)
  const now = new Date();
  const offMin = rigaOffsetMinutes(now);
  const localMs = now.getTime() + offMin * 60000;
  const local = new Date(localMs);
  const next = new Date(local);
  next.setHours(24, 0, 0, 0); // nākamā pusnakts vietējā laikā
  const backUtc = new Date(next.getTime() - offMin * 60000);
  return toRigaISO(backUtc);
}

function rigaDayKey(date = new Date()) {
  // YYYYMMDD Europe/Riga
  const tz = "Europe/Riga";
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const parts = Object.fromEntries(f.map(p => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function wordCount(t) {
  if (!t) return 0;
  return (t.trim().match(/\p{L}+/gu) || []).length;
}
function charCount(t) {
  return (t || "").trim().replace(/\s+/g, "").length;
}

// ---------------- LV parser prompt ----------------
const SYSTEM_PROMPT = `Tu esi deterministisks latviešu dabiskās valodas parsētājs, kas no īsa teikuma izvada TIKAI TĪRU JSON vienā no trim formām: calendar, reminder vai shopping. Atbilde bez skaidrojumiem, bez teksta ārpus JSON. Temperatūra = 0.

Globālie noteikumi
- Laika josla vienmēr: Europe/Riga (sezonāli +02:00 vai +03:00).
- Laika zīmogiem lieto ISO-8601: YYYY-MM-DDTHH:MM:SS+ZZ:ZZ.
- Pieņem 12h un 24h pierakstus: 9, 09:30, 9am/pm.
- Naturālie apzīmējumi:
  - no rīta → 09:00, pusdienlaikā → 12:00, pēcpusdienā → 15:00, vakarā → 19:00, naktī → 22:00.
  - Konflikts (piem., “18:00 no rīta”) → diennakts daļa ir prioritāte (tātad 09:00).
  - pusdeviņos → 08:30.
- Ilgumi: “1h”, “1.5h”, “45 min”, “2 stundas 30 min” → end = start + ilgums.
- Intervāli: “no 9 līdz 11” → start=09:00, end=11:00.
- Nedēļas dienas: “nākamajā pirmdienā” = tuvākā nākotnes pirmdiena.
- Teksta normalizācija: vārdi/uzvārdi, zīmoli ar lielo sākumburtu (Jānis, Apple, Rimi). Izlabo acīmredzamas atpazīšanas kļūdas.
- Apraksts īss un lietišķs (bez “rīt”, “šodien”).
- Valoda: atgriez lang (lv, ru, en, ...).

Laika enkuri
- currentTime – pašreizējais ISO zīmogs Europe/Riga.
- tomorrowExample – rītdienas datums tajā pašā kalendārā, ISO formā.

Speciālie aizvietojumi:
- “šodien” → izmanto currentTime datumu.
- “rīt / rītdien” → izmanto tieši tomorrowExample.

Validācija
- Ja iegūtais start < currentTime → palielini gadu +1, līdz start >= currentTime.
- Ja nav beigu laika → end = start + 1h.
- Vienmēr derīgs ISO ar +02:00 vai +03:00.

Klasifikācija
- “atgādini”, “atgādinājums”, “neaizmirsti”, “remind”, “reminder” → type="reminder".
  - Ar laiku/datumu → hasTime=true, citādi false.
- “nopirkt”, “veikalā”, “pirkumu saraksts”, “shopping”, “iegādāties” → type="shopping".
- Pretējā gadījumā type="calendar".

Izvades shēmas
KALENDĀRS
{ "type": "calendar", "lang": "lv", "start": "YYYY-MM-DDTHH:MM:SS+ZZ:ZZ", "end": "YYYY-MM-DDTHH:MM:SS+ZZ:ZZ", "description": "Teksts" }
ATGĀDINĀJUMS
{ "type": "reminder", "lang": "lv", "start": "YYYY-MM-DDTHH:MM:SS+ZZ:ZZ", "description": "Uzdevums", "hasTime": true }
PIRKUMU SARAKSTS
{ "type": "shopping", "lang": "lv", "items": "piens, maize, olas", "description": "Pirkumu saraksts" }

Atgriez tikai vienu no formām.`;

// -------------- In-memory usage store (tests) --------------
/**
 * usage = {
 *   [userId]: {
 *      dayKey: "YYYYMMDD",
 *      dailyUsed: number,
 *      dailyUsedGrace: number,
 *      monthKey: "YYYYMM",
 *      monthlyUsed: number
 *   }
 * }
 */
const usage = Object.create(null);

function getPlanFor(userId, forcedPlan) {
  const plan = (forcedPlan || "").toLowerCase() === "pro" ? "pro" : "basic";
  return plan === "pro"
    ? { name: "pro", dailyLimit: PRO_DAILY, monthlyLimit: PRO_MONTHLY }
    : { name: "basic", dailyLimit: BASIC_DAILY, monthlyLimit: null };
}

function initUsageFor(userId) {
  const now = new Date();
  const dayKey = rigaDayKey(now);
  const y = new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Riga",year:"numeric"}).format(now);
  const m = new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Riga",month:"2-digit"}).format(now);
  const monthKey = `${y}${m}`;

  if (!usage[userId]) {
    usage[userId] = { dayKey, dailyUsed: 0, dailyUsedGrace: 0, monthKey, monthlyUsed: 0 };
    return;
  }
  if (usage[userId].dayKey !== dayKey) {
    usage[userId].dayKey = dayKey;
    usage[userId].dailyUsed = 0;
    usage[userId].dailyUsedGrace = 0;
  }
  if (usage[userId].monthKey !== monthKey) {
    usage[userId].monthKey = monthKey;
    usage[userId].monthlyUsed = 0;
  }
}

function canConsume(userId, plan) {
  initUsageFor(userId);
  const u = usage[userId];

  if (plan.name === "pro" && plan.monthlyLimit != null) {
    if (u.monthlyUsed >= plan.monthlyLimit) return { ok: false, reason: "monthly_quota_exceeded" };
    if (u.dailyUsed >= plan.dailyLimit && u.monthlyUsed < plan.monthlyLimit) {
      return { ok: true, softDailyExceeded: true };
    }
  }

  const effectiveDailyLimit = plan.dailyLimit + GRACE_DAILY; // iekšējais, UI neredz
  if (u.dailyUsed >= effectiveDailyLimit) {
    return { ok: false, reason: "daily_quota_exceeded" };
  }
  return { ok: true };
}

function consume(userId, plan) {
  initUsageFor(userId);
  const u = usage[userId];
  u.dailyUsed += 1;
  if (plan.name === "pro" && plan.monthlyLimit != null) u.monthlyUsed += 1;
}

function quotaPayload(userId, plan) {
  initUsageFor(userId);
  const dailyReset = rigaMidnightResetISO();

  // nākamā mēneša 1. datums 00:00 Europe/Riga
  const now = new Date();
  const tz = "Europe/Riga";
  const d = new Date(now.toLocaleString("en-GB", { timeZone: tz }));
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0,0,0,0);
  const monthlyReset = toRigaISO(new Date(d));

  const dailyRemaining = Math.max(0, plan.dailyLimit - usage[userId].dailyUsed);
  const monthlyRemaining = plan.monthlyLimit != null
    ? Math.max(0, plan.monthlyLimit - usage[userId].monthlyUsed)
    : null;

  const payload = {
    plan: plan.name,
    dailyLimit: plan.dailyLimit,
    dailyUsed: usage[userId].dailyUsed,
    dailyRemaining,
    dailyReset
  };
  if (plan.monthlyLimit != null) {
    payload.monthlyLimit = plan.monthlyLimit;
    payload.monthlyUsed = usage[userId].monthlyUsed;
    payload.monthlyRemaining = monthlyRemaining;
    payload.monthlyReset = monthlyReset;
  }
  return payload;
}

// -------------- Health --------------
app.get("/", (_req, res) => res.json({ ok: true }));

// -------------- QUOTA --------------
app.get("/quota", (req, res) => {
  try {
    const userId = String(req.headers["x-user-id"] || "anon");
    const forcedPlan = String(req.headers["x-plan"] || "");
    const plan = getPlanFor(userId, forcedPlan);
    initUsageFor(userId);
    return res.json(quotaPayload(userId, plan));
  } catch (e) {
    console.error("quota_failed:", e);
    // droša pagaidu atbilde
    return res.status(200).json({
      plan: "basic",
      dailyLimit: BASIC_DAILY,
      dailyUsed: 0,
      dailyRemaining: BASIC_DAILY,
      dailyReset: rigaMidnightResetISO()
    });
  }
});

// -------------- INGEST (multipart form-data: file=) --------------
app.post("/ingest-audio", async (req, res) => {
  const requestId = String(req.headers["x-request-id"] || "");
  const userId = String(req.headers["x-user-id"] || "anon");
  const forcedPlan = String(req.headers["x-plan"] || "");
  const plan = getPlanFor(userId, forcedPlan);

  try {
    // Auth
    if (APP_BEARER_TOKEN) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${APP_BEARER_TOKEN}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    // QUOTA gate (pirms procesa)
    const gate = canConsume(userId, plan);
    if (!gate.ok) {
      if (gate.reason === "daily_quota_exceeded") {
        return res.status(429).json({ error: "daily_quota_exceeded", ...quotaPayload(userId, plan) });
      }
      if (gate.reason === "monthly_quota_exceeded") {
        return res.status(429).json({ error: "monthly_quota_exceeded", ...quotaPayload(userId, plan) });
      }
    }

    // Parse multipart
    const fields = {};
    let fileBuf = Buffer.alloc(0);
    let filename = "audio.m4a";

    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 8 * 1024 * 1024 } });

    await new Promise((resolve, reject) => {
      bb.on("field", (name, val) => { fields[name] = val; });
      bb.on("file", (_name, stream, info) => {
        filename = info?.filename || filename;
        stream.on("data", (d) => { fileBuf = Buffer.concat([fileBuf, d]); });
        stream.on("limit", () => reject(new Error("file_too_large")));
        stream.on("end", () => {});
      });
      bb.on("error", reject);
      bb.on("finish", resolve);
      req.pipe(bb);
    });

    if (!fileBuf.length) return res.status(400).json({ error: "file_missing" });
    if (fileBuf.length < 2 * 1024) return res.status(400).json({ error: "file_too_small" });

    // === Client VAD telemetrija (izvēles, bet ļoti vēlams) ===
    const vadActiveSeconds = parseFloat(fields.vadActiveSeconds || "0");
    const recordingDurationSeconds = parseFloat(fields.recordingDurationSeconds || "0");
    const MIN_ACTIVE_SPEECH_SEC = 0.8;
    const MIN_ACTIVE_RATIO = 0.20;

    if (recordingDurationSeconds > 0) {
      const ratio = vadActiveSeconds / recordingDurationSeconds;
      const vadOk = vadActiveSeconds >= MIN_ACTIVE_SPEECH_SEC && ratio >= MIN_ACTIVE_RATIO;
      if (!vadOk) {
        return res.status(422).json({
          error: "no_speech_detected",
          reason: "client_vad_filter",
          vadActiveSeconds,
          recordingDurationSeconds
        });
      }
    }

    // Transcribe (ar valodas mājienu)
    const userLang = String(fields.lang || req.headers["x-lang"] || "").toLowerCase();
    const langHint = (userLang === "lv" || userLang === "lav" || userLang === "latvian") ? "lv" : undefined;

    const mime = guessMime(filename);
    const file = await toFile(fileBuf, filename, { type: mime });

    const tr = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file,
      ...(langHint ? { language: langHint } : {})
    });

    const transcript = (tr?.text || "").trim();

    // Teksta validācija (mīkstāka)
    const wc = wordCount(transcript);
    const cc = charCount(transcript);
    const accept = (wc >= 2) || (wc >= 1 && cc >= 5);
    if (!accept) {
      return res.status(422).json({ error: "no_speech_detected", raw_transcript: transcript });
    }

    // Enkuri
    const nowISO = fields.currentTime || toRigaISO(new Date());
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const tomorrowISO = fields.tomorrowExample || toRigaISO(new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0));

    const userMsg = `currentTime=${nowISO}\ntomorrowExample=${tomorrowISO}\nTeksts: ${transcript}`;

    // JSON analīze
    const chat = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg }
      ]
    });

    let out;
    try {
      out = JSON.parse(chat.choices?.[0]?.message?.content || "{}");
    } catch {
      out = { type: "reminder", lang: "lv", start: nowISO, description: transcript, hasTime: false };
    }
    out.raw_transcript = transcript;

    // Derīgs rezultāts → skaitām kvotu
    consume(userId, plan);

    // Logs
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      rid: requestId, userId, route: "/ingest-audio",
      bytes: fileBuf.length, wc, cc, plan: plan.name,
      used: usage[userId].dailyUsed, monthly: usage[userId].monthlyUsed,
      langHint
    }));

    return res.json(out);

  } catch (e) {
    console.error("processing_failed:", e?.response?.status || "", e?.response?.data || "", e);
    return res.status(500).json({ error: "processing_failed", details: String(e) });
  }
});

// Start
app.listen(PORT, () => console.log("Voice agent running on", PORT));
