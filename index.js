import express from "express";
import Busboy from "busboy";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const PORT = process.env.PORT || 3000;
const APP_BEARER_TOKEN = process.env.APP_BEARER_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();

// (neobligāti) ļaut JSON ķermeņus citu endpointu vajadzībām:
app.use(express.json({ limit: "10mb" }));

// ---------- LV deterministiskais parsētājs ----------
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
- Teksta normalizācija: vārdi/uzvārdi, zīmoli ar lielo sākumburtu (Jānis, Apple, Rimi). Izlabo acīmredzamas atpazīšanas kļūdas (piem., “Arjāni” → “Jāni”).
- Apraksts īss un lietišķs (bez “rīt”, “šodien”).
- Valoda: atgriez lang (lv, ru, en, ...).

Laika enkuri (padoti kā ievades mainīgie)
- currentTime – pašreizējais ISO zīmogs Europe/Riga (ar pareizo ofsetu).
- tomorrowExample – rītdienas datums tajā pašā kalendārā, ISO formā.

Speciālie aizvietojumi:
- “šodien” → izmanto currentTime datumu (laiku ņem no frāzes; ja nav, pielieto diennakts-daļas noteikumu vai noklusējumu).
- “rīt / rītdien” → izmanto tieši tomorrowExample (nemaini pēc savas loģikas).

Validācijas loģika
- Ja no frāzes iegūtais start < currentTime → palielini gadu par +1, līdz start >= currentTime.
- Ja nav beigu laika → end = start + 1h.
- Visos gadījumos ģenerē derīgu ISO ar +02:00 vai +03:00.

Klasifikācija
- Ja frāzē ir “atgādini”, “atgādinājums”, “neaizmirsti”, “remind”, “reminder” → type="reminder".
  - Ja frāzē ir konkrēts laiks/datums → hasTime=true, citādi false.
- Ja frāzē ir “nopirkt”, “veikalā”, “pirkumu saraksts”, “shopping”, “iegādāties” → type="shopping".
- Pretējā gadījumā type="calendar".

Izvades shēmas
KALENDĀRS
{ "type": "calendar", "lang": "lv", "start": "YYYY-MM-DDTHH:MM:SS+ZZ:ZZ", "end": "YYYY-MM-DDTHH:MM:SS+ZZ:ZZ", "description": "Teksts" }
ATGĀDINĀJUMS
{ "type": "reminder", "lang": "lv", "start": "YYYY-MM-DDTHH:MM:SS+ZZ:ZZ", "description": "Uzdevums", "hasTime": true }
PIRKUMU SARAKSTS
{ "type": "shopping", "lang": "lv", "items": "piens, maize, olas", "description": "Pirkumu saraksts" }

Atgriez tikai vienu no formām.`;
// ---------------------------------------------------

// Health check
app.get("/", (_req, res) => res.json({ ok: true }));

// ===== Helpers =====
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

// ===== Main endpoint (multipart/form-data with "file") =====
app.post("/ingest-audio", async (req, res) => {
  try {
    // Auth
    if (APP_BEARER_TOKEN) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${APP_BEARER_TOKEN}`) {
        return res.status(401).json({ error: "unauthorized" });
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

    // 1) Transcribe (OpenAI) — use toFile for correct multipart
    const mime = guessMime(filename);
    const file = await toFile(fileBuf, filename, { type: mime });

    const tr = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file
    });

    // 2) Anchors
    const nowISO = fields.currentTime || toRigaISO(new Date());
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const tomorrowISO = fields.tomorrowExample || toRigaISO(new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0));

    const userMsg = `currentTime=${nowISO}\ntomorrowExample=${tomorrowISO}\nTeksts: ${tr.text}`;

    // 3) Analyze → JSON-only
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
      out = { type: "reminder", lang: "lv", start: nowISO, description: tr.text, hasTime: false };
    }

    out.raw_transcript = tr.text;
    return res.json(out);

  } catch (e) {
    console.error("processing_failed:", e?.response?.status || "", e?.response?.data || "", e);
    return res.status(500).json({ error: "processing_failed", details: String(e) });
  }
});

// Start
app.listen(PORT, () => console.log("Voice agent (busboy + toFile) running on", PORT));
