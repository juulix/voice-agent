
import express from "express";
import multer from "multer";
import OpenAI from "openai";

// --- Config ---
const PORT = process.env.PORT || 3000;
const APP_BEARER_TOKEN = process.env.APP_BEARER_TOKEN; // optional: set to enable simple auth
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const upload = multer();

// Deterministic LV parser system prompt
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

// Health check
app.get("/", (_req, res) => res.json({ ok: true }));

app.post("/ingest-audio", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file_missing" });

    // Optional Bearer auth
    if (APP_BEARER_TOKEN) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${APP_BEARER_TOKEN}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    // 1) Transcribe (Whisper)
    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: { name: req.file.originalname, data: req.file.buffer }
    });

    // 2) Build user message with anchors
    // Europe/Riga now:
    const now = new Date();
    // Get offset for Europe/Riga via Intl (best-effort; real prod should compute via tz lib)
    const tz = "Europe/Riga";
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
    const currentISO = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offsetForRiga(now)}`;

    const tomorrow = new Date(now.getTime() + 24*60*60*1000);
    const partsT = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).formatToParts(tomorrow).map(p => [p.type, p.value]));
    const tomorrowISO = `${partsT.year}-${partsT.month}-${partsT.day}T00:00:00${offsetForRiga(tomorrow)}`;

    const userContent = `currentTime=${currentISO}\ntomorrowExample=${tomorrowISO}\nTeksts: ${transcription.text}`;

    // 3) Analyze → JSON-only
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent }
      ]
    });

    const jsonText = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      // fallback minimal response
      parsed = { type: "reminder", lang: "lv", start: currentISO, description: transcription.text, hasTime: false };
    }

    // Add raw transcript for client-side display/debug
    parsed.raw_transcript = transcription.text;
    return res.json(parsed);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "processing_failed", details: String(err) });
  }
});

// Helper: crude offset for Europe/Riga (handles DST approx via locale; if mismatch, override on client)
function offsetForRiga(d) {
  // Create the same UTC time and then compute tz offset string
  const tz = "Europe/Riga";
  const iso = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(d);
  const parts = Object.fromEntries(iso.map(p => [p.type, p.value]));
  const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  const utc = d.getTime();
  const offsetMin = Math.round((local - utc) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

app.listen(PORT, () => {
  console.log("Voice agent server running on", PORT);
});
