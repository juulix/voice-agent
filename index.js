import express from "express";
import Busboy from "busboy";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

/* ===== ENV ===== */
const PORT = process.env.PORT || 3000;
const APP_BEARER_TOKEN = process.env.APP_BEARER_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ===== APP SETUP ===== */
const app = express();
app.use(express.json({ limit: "10mb" }));

/* ===== MIDDLEWARE ===== */

// Request ID middleware
app.use((req, res, next) => {
  req.requestId = req.header('X-Request-Id') || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  next();
});

// X-User-Id validation middleware
app.use((req, res, next) => {
  const method = req.method?.toUpperCase();
  const needsUser = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const isPublicGet = method === "GET" && ["/", "/health", "/ready", "/version"].includes(req.path);
  
  if (!needsUser || isPublicGet) return next();
  
  const userId = req.header("X-User-Id");
  if (!userId || !/^u-\d+-[a-z0-9]{8}$/.test(userId)) {
    return res.status(400).json({ 
      error: "missing_or_invalid_user_id",
      requestId: req.requestId,
      expectedFormat: "u-timestamp-8chars"
    });
  }
  req.userId = userId;
  next();
});

// Structured logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;
  
  res.send = function(data) {
    const duration = Date.now() - start;
    const logData = {
      requestId: req.requestId,
      userId: req.userId || 'anon',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.header('User-Agent'),
      appVersion: req.header('X-App-Version'),
      deviceId: req.header('X-Device-Id'),
      plan: req.header('X-Plan')
    };
    
    if (res.statusCode >= 400) {
      console.error(`❌ [${req.requestId}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`, logData);
    } else {
      console.log(`✅ [${req.requestId}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`, logData);
    }
    
    return originalSend.call(this, data);
  };
  
  next();
});

/* ===== PLANS (fiksēta konfigurācija kodā) ===== */
const plans = {
  basic: { dailyLimit: 5,      monthlyLimit: null },
  pro:   { dailyLimit: 999999, monthlyLimit: 300 },   // Pro: nav dienas limita, tikai 300/mēn
  dev:   { dailyLimit: 999999, monthlyLimit: 999999 }
};
const GRACE_DAILY = 2; // “kļūdu buferis” – ne-soda mēģinājumi dienā

/* ===== In-memory kvotu stāvoklis =====
   usage[userId] = {
     plan: "basic"|"pro"|"dev",
     daily: { dayKey: "YYYY-MM-DD", used: number, graceUsed: number },
     monthly: { monthKey: "YYYY-MM", used: number }
   }
*/
const usage = new Map();

/* ===== Idempotency tracking =====
   idempotency[key] = {
     result: responseData,
     timestamp: Date.now(),
     expires: Date.now() + 5 * 60 * 1000 // 5 minutes
   }
*/
const idempotency = new Map();

// Clean expired idempotency keys every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of idempotency.entries()) {
    if (value.expires < now) {
      idempotency.delete(key);
    }
  }
}, 10 * 60 * 1000);

/* ===== Helpers: laiks, mime, plāni ===== */
function todayKeyRiga(d = new Date()) {
  const tz = "Europe/Riga";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" }).format(d);
}
function monthKeyRiga(d = new Date()) {
  const tz = "Europe/Riga";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(d);
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${o.year}-${o.month}`;
}
function toRigaISO(d) {
  const tz = "Europe/Riga";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(d);
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const local = Date.parse(`${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}Z`);
  const offsetMin = Math.round((local - d.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}${sign}${hh}:${mm}`;
}
function guessMime(filename) {
  const f = (filename || "").toLowerCase();
  if (f.endsWith(".m4a") || f.endsWith(".mp4")) return "audio/mp4";
  if (f.endsWith(".mp3") || f.endsWith(".mpga")) return "audio/mpeg";
  if (f.endsWith(".wav")) return "audio/wav";
  if (f.endsWith(".webm")) return "audio/webm";
  return "application/octet-stream";
}
function getPlanLimits(planHeader) {
  const p = (planHeader || "").toLowerCase();
  if (p === "pro") return { plan: "pro", dailyLimit: plans.pro.dailyLimit, monthlyLimit: plans.pro.monthlyLimit };
  if (p === "dev") return { plan: "dev", dailyLimit: plans.dev.dailyLimit, monthlyLimit: plans.dev.monthlyLimit };
  return { plan: "basic", dailyLimit: plans.basic.dailyLimit, monthlyLimit: plans.basic.monthlyLimit ?? 0 };
}
function getUserUsage(userId, planHeader) {
  const limits = getPlanLimits(planHeader);
  const today = todayKeyRiga();
  const mKey = monthKeyRiga();
  if (!usage.has(userId)) {
    usage.set(userId, {
      plan: limits.plan,
      daily: { dayKey: today, used: 0, graceUsed: 0 },
      monthly: { monthKey: mKey, used: 0 }
    });
  }
  const u = usage.get(userId);
  u.plan = limits.plan;
  if (u.daily.dayKey !== today) { u.daily.dayKey = today; u.daily.used = 0; u.daily.graceUsed = 0; }
  if (u.monthly.monthKey !== mKey) { u.monthly.monthKey = mKey; u.monthly.used = 0; }
  return { u, limits };
}

/* ===== Teksta kvalitātes vārti (ātrā pārbaude + normalizācija) ===== */
// Biežākās LV korekcijas (minimāla normalizācija bez modeļa)
const LV_FIXES = [
  [/^\s*reit\b/gi, "rīt"],
  [/\breit\b/gi, "rīt"],
  [/\brit\b/gi, "rīt"],
  [/\bpulkstenis\b/gi, "pulksten"],
  [/\btikšanas\b/gi, "tikšanās"],
  [/\btikšanos\b/gi, "tikšanās"],
  [/\bnullei\b/gi, "nullē"],
  [/\bnulli\b/gi, "nulli"],
  [/\bdesmitos\b/gi, "desmitos"],
  [/\bdivpadsmitos\b/gi, "divpadsmitos"]
];
// “pūķa astes” – burtu atkārtojumu nogriešana (helloooo → helloo)
function squeezeRepeats(s, max = 3) {
  return s.replace(/(.)\1{3,}/g, (m, ch) => ch.repeat(max));
}
function normalizeTranscript(text, langHint) {
  let t = (text || "").replace(/\s+/g, " ").trim();
  t = squeezeRepeats(t);
  if ((langHint || "lv").startsWith("lv")) {
    LV_FIXES.forEach(([re, rep]) => { t = t.replace(re, rep); });
    // ja sākas ar mazajiem, paceļam pirmo burtu
    if (t.length > 1) t = t[0].toUpperCase() + t.slice(1);
  }
  return t;
}
// Heiristiska kvalitātes novērtēšana (bez papildu API izmaksām)
function qualityScore(text) {
  const t = (text || "").trim();
  if (!t) return 0;
  const letters = (t.match(/[A-Za-zĀ-ž]/g) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  const spaces = (t.match(/\s/g) || []).length;
  const symbols = t.length - letters - digits - spaces;
  const words = t.split(/\s+/).filter(w => w.length > 0);
  const longWords = words.filter(w => w.length >= 3).length;

  // pārmērīgas simbolu virknes = zema kvalitāte
  if (symbols / Math.max(1, t.length) > 0.25) return 0.2;
  // tikai 1 īss vārds → vāja
  if (words.length < 2) return 0.2;
  // nav pietiekami “vārdu-līdzīgu”
  if (longWords < 1) return 0.25;

  // burti vs kopgarums
  const letterRatio = letters / Math.max(1, t.length);
  // “vidējais vārda garums”
  const avgLen = t.length / Math.max(1, words.length);

  let score = 0.5;
  if (letterRatio > 0.65) score += 0.2;
  if (avgLen >= 3.5 && avgLen <= 12) score += 0.2;
  if (digits === 0) score += 0.05;
  if (!/[A-Za-zĀ-ž]/.test(t)) score -= 0.3; // nav latīņu/latviešu burtu
  // pārlieku gari bez atstarpēm
  if (avgLen > 18) score -= 0.2;

  // nogriežam [0..1]
  return Math.max(0, Math.min(1, score));
}

/* ===== LV teksta analīzes un korekcijas AI ===== */
const LV_ANALYSIS_PROMPT = `Tu esi latviešu valodas eksperts, kas analizē un uzlabo transkribētos tekstus. Tava uzdevums ir:

1. ANALIZĒT tekstu - atpazīt vārdus, kontekstu, nozīmi
2. IZLABOT kļūdas - gramatika, pareizrakstība, vārdu formas
3. UZLABOT skaidrību - padarīt tekstu skaidrāku un precīzāku
4. SAGLABĀT nozīmi - neizmainīt sākotnējo nozīmi

Atgriez TIKAI uzlaboto tekstu, bez skaidrojumiem. Temperatūra = 0.

Piemēri:
- "reit nopirkt maizi" → "Rīt nopirkt maizi"
- "pulkstenis deviņos tikšanās" → "Pulksten deviņos tikšanās"
- "atgādini man rīt uz darbu" → "Atgādini man rīt uz darbu"
- "rīt no rīta uz darbu" → "Rīt no rīta uz darbu"`;

/* ===== LV shopping list analīzes AI ===== */
const LV_SHOPPING_ANALYSIS_PROMPT = `Tu esi latviešu valodas eksperts specializējies shopping list analīzē. Tava uzdevums ir:

1. ATPAZĪT produktus - kas tie ir, cik daudz, kādi apraksti
2. IZLABOT produktu nosaukumus - pareizrakstība, latviešu valodas formas
3. NORMALIZĒT produktus - standartizēt nosaukumus, izņemt dublikātus
4. UZLABOT skaidrību - padarīt produktu sarakstu skaidrāku

Populārākie produkti latviešu valodā:
- maize, maize, maize (ne "maizīte", "maizīšu")
- piens, piens, pienu (ne "pienītis")
- olas, olas, olu (ne "oliņas")
- sviests, sviests, sviestu
- siers, siers, siera
- gaļa, gaļa, gaļas
- zivis, zivis, zivju
- dārzeņi, dārzeņi, dārzeņu
- augļi, augļi, augļu
- saldējums, saldējums, saldējuma
- maizes izstrādājumi, maizes izstrādājumi
- konditorejas izstrādājumi, konditorejas izstrādājumi

Atgriez TIKAI uzlaboto shopping tekstu, bez skaidrojumiem. Temperatūra = 0.

Piemēri:
- "nopirkt maizi, pienu, olas" → "Nopirkt maizi, pienu, olas"
- "maizīte un pienītis" → "Maize un piens"
- "sviests, sviests, sviests" → "Sviests"
- "nopirkt gaļu un zivis" → "Nopirkt gaļu un zivis"`;

/* ===== Deterministiskais LV parsētājs ===== */
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

/* ===== RATE LIMITING ===== */
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  keyGenerator: (req) => req.userId || req.ip,
  message: { 
    error: "rate_limit_exceeded",
    requestId: (req) => req.requestId,
    retryAfter: "1 minute"
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/ingest-audio', limiter);

/* ===== HEALTH ENDPOINTS ===== */
app.get("/", (req, res) => res.json({ 
  ok: true, 
  requestId: req.requestId,
  timestamp: new Date().toISOString()
}));

app.get("/health", (req, res) => res.json({ 
  status: "healthy",
  requestId: req.requestId,
  timestamp: new Date().toISOString(),
  uptime: process.uptime()
}));

app.get("/ready", (req, res) => {
  // Check if OpenAI API is accessible
  const isReady = !!process.env.OPENAI_API_KEY;
  const status = isReady ? "ready" : "not_ready";
  const statusCode = isReady ? 200 : 503;
  
  res.status(statusCode).json({
    status,
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
    openai: isReady ? "configured" : "missing"
  });
});

app.get("/version", (req, res) => res.json({
  version: "2025.01.15-1",
  requestId: req.requestId,
  timestamp: new Date().toISOString(),
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || "unknown",
  node: process.version
}));

/* ===== /quota ===== */
const normalizeDaily = (n) => (n >= 999999 ? null : n);

app.get("/quota", (req, res) => {
  const userId = req.header("X-User-Id") || "anon";
  const planHdr = req.header("X-Plan") || "basic";
  const { u, limits } = getUserUsage(userId, planHdr);

  const dailyLimitNorm = normalizeDaily(limits.dailyLimit);
  const out = {
    plan: limits.plan,
    dailyLimit: dailyLimitNorm,
    dailyUsed: u.daily.used,
    dailyRemaining: dailyLimitNorm === null ? null : Math.max(0, limits.dailyLimit - u.daily.used),
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

/* ===== POST /ingest-audio ===== */
app.post("/ingest-audio", async (req, res) => {
  try {
    // Auth
    if (APP_BEARER_TOKEN) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${APP_BEARER_TOKEN}`) {
        return res.status(401).json({ 
          error: "unauthorized",
          requestId: req.requestId
        });
      }
    }

    // Idempotency check
    const idempotencyKey = req.header("Idempotency-Key");
    if (idempotencyKey) {
      const cached = idempotency.get(idempotencyKey);
      if (cached && cached.expires > Date.now()) {
        console.log(`🔄 [${req.requestId}] Returning cached result for Idempotency-Key: ${idempotencyKey}`);
        return res.json({
          ...cached.result,
          requestId: req.requestId,
          cached: true
        });
      }
    }

    // Identitāte & plāns kvotām
    const userId = req.header("X-User-Id") || "anon";
    const planHdr = req.header("X-Plan") || "basic";
    const langHint = (req.header("X-Lang") || "lv").toLowerCase();
    const { u, limits } = getUserUsage(userId, planHdr);

    // Pārbaude pirms apstrādes
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

    // Minimāla runas aktivitāte (pirms maksas transkripcijas)
    if (vadActiveSeconds < 0.3 || recordingDurationSeconds < 0.6) {
      if (u.daily.graceUsed < GRACE_DAILY) u.daily.graceUsed += 1;
      return res.status(422).json({ error: "no_speech_detected_client", details: { vadActiveSeconds, recordingDurationSeconds } });
    }

    // Transcribe (OpenAI)
    const file = await toFile(fileBuf, filename, { type: guessMime(filename) });
    const tr = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file
    });

    // Normalizācija + kvalitātes pārbaude
    const raw = (tr.text || "").trim();
    const norm = normalizeTranscript(raw, langHint);
    const score = qualityScore(norm);

    if (norm.length < 2 || score < 0.35) {
      if (u.daily.graceUsed < GRACE_DAILY) u.daily.graceUsed += 1;
      return res.status(422).json({
        error: "low_confidence_transcript",
        score,
        raw_transcript: raw,
        normalized: norm
      });
    }

    // Trešā AI apstrāde - LV teksta analīze un korekcija (tikai ja nepieciešams)
    let analyzedText = norm;
    let needsAnalysis = false;
    
    if ((langHint || "lv").startsWith("lv")) {
      // Pārbaudām vai teksts jau ir labs
      const qualityThreshold = 0.7;
      const currentScore = qualityScore(norm);
      
      // Pārbaudām vai ir kļūdas, kas nepieciešama AI labošana
      const hasCommonErrors = /[āčēģīķļņšūž]/.test(norm) || // diakritiskās zīmes
                              norm !== norm.toLowerCase() || // mazie burti
                              norm.includes("maizīte") || norm.includes("pienītis") || // zināmās kļūdas
                              norm.includes("reit") || norm.includes("rit") || // laika kļūdas
                              currentScore < qualityThreshold;
      
      needsAnalysis = hasCommonErrors;
      
      if (needsAnalysis) {
        console.log(`🔍 Text needs analysis (score: ${currentScore.toFixed(2)}, errors: ${hasCommonErrors})`);
        
        try {
          // Vispārējā LV analīze
          const analysis = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0,
            messages: [
              { role: "system", content: LV_ANALYSIS_PROMPT },
              { role: "user", content: norm }
            ]
          });
          analyzedText = (analysis.choices?.[0]?.message?.content || norm).trim();
          
          // Papildu shopping list analīze, ja teksts satur shopping vārdus
          const shoppingKeywords = ["nopirkt", "pirkt", "iepirkums", "iepirkt", "veikals", "veikalā", "pirkumu", "pirkumus"];
          const isShoppingText = shoppingKeywords.some(keyword => 
            analyzedText.toLowerCase().includes(keyword.toLowerCase())
          );
          
          if (isShoppingText) {
            console.log("🛒 Detected shopping text, applying shopping analysis");
            try {
              const shoppingAnalysis = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: 0,
                messages: [
                  { role: "system", content: LV_SHOPPING_ANALYSIS_PROMPT },
                  { role: "user", content: analyzedText }
                ]
              });
              analyzedText = (shoppingAnalysis.choices?.[0]?.message?.content || analyzedText).trim();
            } catch (e) {
              console.warn("Shopping analysis failed, using general analysis:", e);
            }
          }
          
          console.log(`✅ Text analyzed: "${norm}" → "${analyzedText}"`);
        } catch (e) {
          console.warn("LV analysis failed, using normalized text:", e);
          analyzedText = norm;
        }
      } else {
        console.log(`✅ Text is good quality (score: ${currentScore.toFixed(2)}), skipping AI analysis`);
      }
    }

    // Laika enkuri
    const nowISO = fields.currentTime || toRigaISO(new Date());
    const tmr = new Date(Date.now() + 24 * 3600 * 1000);
    const tomorrowISO = fields.tomorrowExample || toRigaISO(new Date(tmr.getFullYear(), tmr.getMonth(), tmr.getDate(), 0, 0, 0));

    const userMsg = `currentTime=${nowISO}\ntomorrowExample=${tomorrowISO}\nTeksts: ${analyzedText}`;

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
      out = { type: "reminder", lang: langHint, start: nowISO, description: norm, hasTime: false };
    }

    out.raw_transcript = raw;
    out.normalized_transcript = norm;
    out.analyzed_transcript = analyzedText;
    out.analysis_applied = needsAnalysis;
    out.confidence = score;

    // ŠIS ieraksts derīgs → skaitām kvotu
    u.daily.used += 1;
    if (limits.plan === "pro") u.monthly.used += 1;

    // Kvotu statuss atbildē
    out.quota = {
      plan: limits.plan,
      dailyLimit: normalizeDaily(limits.dailyLimit),
      dailyUsed: u.daily.used,
      dailyRemaining: limits.dailyLimit >= 999999 ? null : Math.max(0, limits.dailyLimit - u.daily.used),
      dailyGraceLimit: GRACE_DAILY,
      dailyGraceUsed: u.daily.graceUsed
    };
    if (limits.plan === "pro") {
      out.quota.monthlyLimit = limits.monthlyLimit;
      out.quota.monthlyUsed = u.monthly.used;
      out.quota.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used);
    }

    // Add request ID to response
    out.requestId = req.requestId;

    // Cache result for idempotency
    if (idempotencyKey) {
      idempotency.set(idempotencyKey, {
        result: out,
        timestamp: Date.now(),
        expires: Date.now() + 5 * 60 * 1000 // 5 minutes
      });
    }

    return res.json(out);

  } catch (e) {
    console.error("processing_failed:", e?.response?.status || "", e?.response?.data || "", e);
    return res.status(500).json({ error: "processing_failed", details: String(e) });
  }
});

/* ===== Start ===== */
app.listen(PORT, () => console.log("Voice agent running on", PORT));
