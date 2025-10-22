/* ===== ENV ===== */
const PORT = process.env.PORT || 3000;
const APP_BEARER_TOKEN = process.env.APP_BEARER_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

/* ===== PLANS (fiksēta konfigurācija kodā) ===== */
const plans = {
  basic: { dailyLimit: 5,      monthlyLimit: null },
  pro:   { dailyLimit: 999999, monthlyLimit: 300 },   // ← Pro: nav dienas limita (tikai 300/mēn)
  dev:   { dailyLimit: 999999, monthlyLimit: 999999 }
};

// “kļūdu buferis” – cik “tukšus/failed” mēģinājumus atļaujam dienā papildus limitam
const GRACE_DAILY = 2;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
app.use(express.json({ limit: "10mb" }));

/* ===== In-memory kvotu stāvoklis (vienkārši; pietiek MVP) =====
   Struktūra:
   usage[userId] = {
     plan: "basic"|"pro",
     daily: { dayKey: "YYYY-MM-DD", used: number, graceUsed: number },
     monthly: { monthKey: "YYYY-MM", used: number }   // tikai Pro
   }
*/
const usage = new Map();

/* ===== Palīgfunkcijas ===== */
function todayKeyRiga(d = new Date()) {
  const tz = "Europe/Riga";
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" })
    .format(d); // YYYY-MM-DD
  return f;
}
function monthKeyRiga(d = new Date()) {
  const tz = "Europe/Riga";
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit"
  }).formatToParts(d);
  const obj = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${obj.year}-${obj.month}`; // YYYY-MM
}
function getPlanLimits(plan) {
  if ((plan || "").toLowerCase() === "pro") {
    return { plan: "pro", dailyLimit: PRO_DAILY, monthlyLimit: PRO_MONTHLY };
  }
  return { plan: "basic", dailyLimit: BASIC_DAILY, monthlyLimit: 0 };
}
function getUserUsage(userId, planHeader) {
  const limits = getPlanLimits(planHeader);
  const today = todayKeyRiga();
  const mKey = monthKeyRiga();
  if (!usage.has(userId)) {
    usage.set(userId, {
      plan: limits.plan,
      daily:   { dayKey: today, used: 0, graceUsed: 0 },
      monthly: { monthKey: mKey, used: 0 }
    });
  }
  const u = usage.get(userId);

  // ja plāns headerī mainīts — sinhronizē
  u.plan = limits.plan;

  // dienas reset
  if (u.daily.dayKey !== today) {
    u.daily.dayKey = today;
    u.daily.used = 0;
    u.daily.graceUsed = 0;
  }
  // mēneša reset (tikai Pro)
  if (u.monthly.monthKey !== mKey) {
    u.monthly.monthKey = mKey;
    u.monthly.used = 0;
  }
  return { u, limits };
}
function toRigaISO(d) {
  const tz = "Europe/Riga";
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
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
function guessMime(filename) {
  const f = (filename || "").toLowerCase();
  if (f.endsWith(".m4a") || f.endsWith(".mp4")) return "audio/mp4";
  if (f.endsWith(".mp3") || f.endsWith(".mpga")) return "audio/mpeg";
  if (f.endsWith(".wav")) return "audio/wav";
  if (f.endsWith(".webm")) return "audio/webm";
  return "application/octet-stream";
}

/* ===== Deterministiskais LV parsētājs (tavs teksts) ===== */
const SYSTEM_PROMPT = `Tu esi deterministisks latviešu dabiskās valodas parsētājs, kas no īsa teikuma izvada TIKAI TĪRU JSON vienā no trim formām: calendar, reminder vai shopping. Atbilde bez skaidrojumiem, bez teksta ārpus JSON. Temperatūra = 0.

Globālie noteikumi
- Laika josla vienmēr: Europe/Riga (sezonāli +02:00 vai +03:00).
- Laika zīmogiem lieto ISO-8601: YYYY-MM-DDTHH:MM:SS+ZZ:ZZ.
- Pieņem 12h un 24h pierakstus: 9, 09:30, 9am/pm.
- Naturālie apzīmējumi: no rīta=09:00, pusdienlaikā=12:00, pēcpusdienā=15:00, vakarā=19:00, naktī=22:00. Konflikts → diennakts daļa ir prioritāte. "pusdeviņos"=08:30.
- Ilgumi: “1h”, “1.5h”, “45 min” → end = start + ilgums.
- Intervāli: “no 9 līdz 11” → start=09:00, end=11:00.
- Nedēļas dienas: “nākamajā pirmdienā” = tuvākā nākotnes pirmdiena.
- Normalizē vārdus/brandus ar lielo sākumburtu; izlabo atpazīšanas kļūdas.
- Apraksts īss un lietišķs; valoda -> lang (lv, en, ...).

Laika enkuri
- currentTime – pašreizējais ISO Europe/Riga.
- tomorrowExample – rītdienas datums 00:00 Europe/Riga.

Speciālie aizvietojumi:
- “šodien” → currentTime datums.
- “rīt/rītdien” → tomorrowExample.

Validācijas loģika
- Ja start < currentTime → palielini gadu par +1 līdz start ≥ currentTime.
- Ja nav beigu laika → end = start + 1h.

Klasifikācija
- “atgādini”, “reminder” → type="reminder" (+ hasTime).
- “nopirkt”, “shopping” → type="shopping".
- Citādi → type="calendar".

Izvades shēmas:
{ "type":"calendar","lang":"lv","start":"...","end":"...","description":"..." }
{ "type":"reminder","lang":"lv","start":"...","description":"...","hasTime":true }
{ "type":"shopping","lang":"lv","items":"piens, maize, olas","description":"Pirkumu saraksts" }

Atgriez tikai vienu no formām.`;

/* ===== Healthcheck ===== */
app.get("/", (_req, res) => res.json({ ok: true }));

/* ===== /quota (publisks GET) ===== */
app.get("/quota", (req, res) => {
  const userId = req.header("X-User-Id") || "anon";
  const planHdr = req.header("X-Plan") || "basic";
  const { u, limits } = getUserUsage(userId, planHdr);

  const dailyRemaining = Math.max(0, limits.dailyLimit - u.daily.used);
  const out = {
    plan: limits.plan,
    dailyLimit: limits.dailyLimit,
    dailyUsed: u.daily.used,
    dailyRemaining,
    dailyGraceLimit: GRACE_DAILY,
    dailyGraceUsed: u.daily.graceUsed,
    dailyReset: toRigaISO(new Date(new Date().setHours(0,0,0,0) + 24*3600*1000)),
  };
  if (limits.plan === "pro") {
    out.monthlyLimit = limits.monthlyLimit;
    out.monthlyUsed = u.monthly.used;
    out.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used);
  }
  return res.json(out);
});

/* ===== Galvenais: POST /ingest-audio ===== */
app.post("/ingest-audio", async (req, res) => {
  try {
    // Auth
    if (APP_BEARER_TOKEN) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${APP_BEARER_TOKEN}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    // Identitāte & plāns kvotām
    const userId = req.header("X-User-Id") || "anon";
    const planHdr = req.header("X-Plan") || "basic";
    const { u, limits } = getUserUsage(userId, planHdr);

    // pārbaude pirms apstrādes
    if (u.daily.used >= limits.dailyLimit) {
      return res.status(429).json({ error: "quota_exceeded", plan: limits.plan });
    }
    if (limits.plan === "pro" && u.monthly.used >= limits.monthlyLimit) {
      return res.status(429).json({ error: "monthly_quota_exceeded", plan: limits.plan });
    }

    // Multipart
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

    // Klienta VAD telemetrija
    const vadActiveSeconds = Number(fields.vadActiveSeconds || 0);
    const recordingDurationSeconds = Number(fields.recordingDurationSeconds || 0);
    const langHint = (req.header("X-Lang") || fields.lang || "lv").toLowerCase();

    // Ļaujam “tukšos” iekrist GRACE buferī (neskaitām pret limitu)
    const PASSES_MIN_SPEECH = vadActiveSeconds >= 0.5;

    // Transcribe
    const file = await toFile(fileBuf, filename, { type: guessMime(filename) });
    const tr = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file
    });

    // Ja arī transkripts tukšs – metam 422 un, ja pieejams, izmantojam GRACE
    const transcript = (tr.text || "").trim();
    if (!PASSES_MIN_SPEECH || transcript.length < 2) {
      if (u.daily.graceUsed < GRACE_DAILY) {
        u.daily.graceUsed += 1; // “ne-soda” mēģinājums
      }
      return res.status(422).json({ error: "no_speech_detected", raw_transcript: transcript });
    }

    // Laika enkuri
    const nowISO = fields.currentTime || toRigaISO(new Date());
    const tmr = new Date(Date.now() + 24 * 3600 * 1000);
    const tomorrowISO = fields.tomorrowExample || toRigaISO(new Date(tmr.getFullYear(), tmr.getMonth(), tmr.getDate(), 0, 0, 0));

    const userMsg = `currentTime=${nowISO}\ntomorrowExample=${tomorrowISO}\nTeksts: ${transcript}`;

    // Parsēšana uz JSON
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
      out = { type: "reminder", lang: langHint, start: nowISO, description: transcript, hasTime: false };
    }

    out.raw_transcript = transcript;

    // ŠIS ieraksts bija derīgs → skaitām kvotu
    u.daily.used += 1;
    if (limits.plan === "pro") u.monthly.used += 1;

    // Pievienojam kvotu statusu atbildē (noder UI)
    out.quota = {
      plan: limits.plan,
      dailyLimit: limits.dailyLimit,
      dailyUsed: u.daily.used,
      dailyRemaining: Math.max(0, limits.dailyLimit - u.daily.used),
      dailyGraceLimit: GRACE_DAILY,
      dailyGraceUsed: u.daily.graceUsed
    };
    if (limits.plan === "pro") {
      out.quota.monthlyLimit = limits.monthlyLimit;
      out.quota.monthlyUsed = u.monthly.used;
      out.quota.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used);
    }

    return res.json(out);

  } catch (e) {
    console.error("processing_failed:", e?.response?.status || "", e?.response?.data || "", e);
    return res.status(500).json({ error: "processing_failed", details: String(e) });
  }
});

/* ===== Start ===== */
app.listen(PORT, () => console.log("Voice agent running on", PORT));
