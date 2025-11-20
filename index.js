import express from "express";
import Busboy from "busboy";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import client from "prom-client";
import sqlite3 from "sqlite3";
import path from "path";
import * as Sentry from "@sentry/node";

/* ===== ENV ===== */
const PORT = process.env.PORT || 3000;
const APP_BEARER_TOKEN = process.env.APP_BEARER_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

// Initialize Sentry
if (process.env.SENTRY_DSN) {
  Sentry.init({ 
    dsn: process.env.SENTRY_DSN, 
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV || "production"
  });
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ===== OPENAI HELPER FUNCTIONS ===== */
// Modeļi, kam NEDRĪKST sūtīt temperature (atsevišķi transcribe/realtime)
// GPT-5 mini un nano neatbalsta temperature (tikai default 1)
const FIXED_TEMP_MODELS = new Set([
  "gpt-4o-mini-transcribe",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-realtime",
]);

// Noklusētie modeļi (vieglāk mainīt vienuviet)
// GPT-5-nano ir pārāk lēns (9-16s vs 1-3s GPT-4.1-mini), atgriezts uz GPT-4.1-mini
const DEFAULT_TEXT_MODEL = process.env.GPT_MODEL || "gpt-4.1-mini";   // galvenajām operācijām
const CHEAP_TASK_MODEL  = process.env.GPT_MODEL || "gpt-4.1-mini";    // kopsavilkumi/klasifikācija u.tml.

console.log(`✅ Using GPT model: ${DEFAULT_TEXT_MODEL}`);

/**
 * Build OpenAI API parameters with automatic temperature and token handling
 * @param {Object} params - API parameters
 * @param {string} params.model - Model name
 * @param {Array} params.messages - Messages array
 * @param {string} [params.system] - System message (alternative to messages)
 * @param {boolean} [params.json=false] - Use JSON response format
 * @param {Object} [params.jsonSchema=null] - JSON Schema for strict validation
 * @param {number} [params.max=280] - Max completion tokens
 * @param {number|null} [params.temperature=0] - Temperature (0-2), null to omit
 * @returns {Object} OpenAI API parameters
 */
function buildParams({ model, messages, system, json = false, jsonSchema = null, max = 280, temperature = 0 }) {
  const p = {
    model,
    max_completion_tokens: max, // Svarīgi: NEVIS max_tokens
  };

  if (messages) p.messages = messages;
  if (system) {
    // If system is provided separately, prepend it to messages or create new messages array
    if (!messages) {
      p.messages = [{ role: "system", content: system }];
    } else {
      // Prepend system message if not already present
      const hasSystem = messages.some(m => m.role === "system");
      if (!hasSystem) {
        p.messages = [{ role: "system", content: system }, ...messages];
      }
    }
  }

  // JSON režīms (vienkāršs)
  if (json) {
    p.response_format = { type: "json_object" };
  }

  // JSON Schema (strict: false, lai atļautu optional laukus)
  if (jsonSchema) {
    p.response_format = {
      type: "json_schema",
      json_schema: {
        name: jsonSchema.name || "schema",
        schema: jsonSchema.schema,
        strict: false // Atļauj optional laukus
      }
    };
  }

  // Temperature – tikai ja modelis to atbalsta
  if (!FIXED_TEMP_MODELS.has(model) && temperature != null) {
    p.temperature = temperature;
  }

  return p;
}

/**
 * Safe OpenAI API call with automatic retry for temperature and max_tokens issues
 * @param {Object} params - OpenAI API parameters
 * @returns {Promise} OpenAI API response
 */
async function safeCreate(params) {
  try {
    return await openai.chat.completions.create(params);
  } catch (e) {
    const msg = e?.error?.message || e?.message || "";
    
    // 1) Auto-labojums: max_tokens → max_completion_tokens
    // Visi modeļi (GPT-4 un GPT-5) izmanto max_completion_tokens
    if (msg.includes("max_tokens") || msg.includes("max_completion_tokens") || msg.includes("max_output_tokens")) {
      const clone = { ...params };
      
      // Visi modeļi izmanto max_completion_tokens
      if ('max_tokens' in clone) {
        clone.max_completion_tokens = clone.max_tokens;
        delete clone.max_tokens;
      }
      // Noņemam max_output_tokens, ja tas ir (nav atbalstīts)
      if ('max_output_tokens' in clone) {
        clone.max_completion_tokens = clone.max_output_tokens || clone.max_completion_tokens || 1000;
        delete clone.max_output_tokens;
      }
      console.log(`⚠️ Auto-fixed max_tokens → max_completion_tokens for ${params.model}`);
      return await openai.chat.completions.create(clone);
    }
    
    // 2) Auto-labojums: izmet temperature, ja neatbalstīts
    if (msg.includes("temperature") && msg.includes("Only the default (1) value is supported")) {
      const clone = { ...params };
      delete clone.temperature;
      console.log(`⚠️ Temperature not supported for ${params.model}, retrying without temperature`);
      return await openai.chat.completions.create(clone);
    }
    
    throw e;
  }
}

/* ===== DATABASE SETUP ===== */
// Use Railway volume if mounted, otherwise local path
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'quota.db')
  : path.join(process.cwd(), 'quota.db');

const db = new sqlite3.Database(dbPath);

console.log(`💾 Database path: ${dbPath}`);

// Initialize quota tracking tables
db.serialize(() => {
  // SQLite PRAGMA optimizations for better performance
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run("PRAGMA busy_timeout=3000");
  db.run("PRAGMA cache_size=-10000"); // 10MB cache
  
  // Daily usage tracking
  db.run(`CREATE TABLE IF NOT EXISTS quota_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    day_key TEXT NOT NULL,
    month_key TEXT NOT NULL,
    daily_used INTEGER DEFAULT 0,
    daily_grace_used INTEGER DEFAULT 0,
    monthly_used INTEGER DEFAULT 0,
    notes_minutes_used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, day_key)
  )`);
  
  // Add notes_minutes_used column if it doesn't exist (migration)
  db.run(`ALTER TABLE quota_usage ADD COLUMN notes_minutes_used INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.warn('⚠️ Migration warning:', err.message);
    } else if (!err) {
      console.log('✅ Added notes_minutes_used column to quota_usage table');
    }
  });
  
  // Create indexes for performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_day ON quota_usage(user_id, day_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_month ON quota_usage(user_id, month_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_month_key ON quota_usage(month_key)`);
  
  // Top-ups table for PRO plan users
  db.run(`CREATE TABLE IF NOT EXISTS top_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    month_key TEXT NOT NULL,
    amount_purchased INTEGER NOT NULL,
    amount_remaining INTEGER NOT NULL,
    purchase_date TEXT NOT NULL,
    transaction_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, month_key, transaction_id)
  )`);
  
  // Index for top-ups
  db.run(`CREATE INDEX IF NOT EXISTS idx_top_ups_user_month 
    ON top_ups(user_id, month_key)`);
  
  // Notes tables
  db.run(`CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    transcript TEXT NOT NULL,
    emoji TEXT,
    audio_url TEXT,
    folder_id TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,  -- Auto-delete timestamp (temporary processing)
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
  )`);
  
  // Add expires_at column if it doesn't exist (migration)
  db.run(`ALTER TABLE notes ADD COLUMN expires_at DATETIME`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.warn('⚠️ Migration warning:', err.message);
    } else if (!err) {
      console.log('✅ Added expires_at column to notes table');
    }
  });
  
  // Add emoji column to existing tables (migration)
  db.run(`ALTER TABLE notes ADD COLUMN emoji TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.warn('⚠️ Migration warning:', err.message);
    } else if (!err) {
      console.log('✅ Added emoji column to notes table');
    }
  });
  
  db.run(`CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
  )`);
  
  // Add color column to existing folders table if it doesn't exist
  db.run(`ALTER TABLE folders ADD COLUMN color TEXT`, (err) => {
    // Ignore error if column already exists
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding color column to folders:', err);
    }
  });
  
  // Indexes for notes
  db.run(`CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes(folder_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id)`);
  
  console.log('✅ Database optimized and indexes created');
});

/* ===== PROMETHEUS METRICS ===== */
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status"]
});

const httpLatency = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration (ms)",
  labelNames: ["method", "path", "status"],
  buckets: [50, 100, 200, 400, 800, 1500, 3000, 5000]
});

const audioProcessingTime = new client.Histogram({
  name: "audio_processing_duration_ms",
  help: "Audio processing duration (ms)",
  labelNames: ["status"],
  buckets: [1000, 2000, 5000, 10000, 15000, 30000]
});

const quotaUsage = new client.Counter({
  name: "quota_usage_total",
  help: "Total quota usage",
  labelNames: ["plan", "type"]
});

const operationsTotal = new client.Counter({
  name: "operations_total",
  help: "Total operations (transcriptions)",
  labelNames: ["status", "plan"]
});

const databaseOperations = new client.Counter({
  name: "database_operations_total",
  help: "Total database operations",
  labelNames: ["operation", "table"]
});

register.registerMetric(httpRequests);
register.registerMetric(httpLatency);
register.registerMetric(audioProcessingTime);
register.registerMetric(quotaUsage);
register.registerMetric(operationsTotal);
register.registerMetric(databaseOperations);

/* ===== APP SETUP ===== */
const app = express();

// Sentry middleware
if (process.env.SENTRY_DSN) {
  app.use(Sentry.requestHandler());
  app.use(Sentry.tracingHandler());
}

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

// Prometheus metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const labels = { 
      method: req.method, 
      path: req.route?.path || req.path, 
      status: String(res.statusCode) 
    };
    httpRequests.inc(labels, 1);
    httpLatency.observe(labels, ms);
  });
  next();
});

/* ===== PLANS (fiksēta konfigurācija kodā) ===== */
const plans = {
  free:     { dailyLimit: 999999, monthlyLimit: 10, notesMinutesLimit: 3 },        // Free: 10 ieraksti/mēn, 3 min Notes/mēn
  basic:    { dailyLimit: 999999, monthlyLimit: 150, notesMinutesLimit: 15 },       // Standarta: 150 ieraksti/mēn, 15 min Notes/mēn, 1.99 EUR/mēn
  pro:      { dailyLimit: 999999, monthlyLimit: 300, notesMinutesLimit: 120 },       // Pro: 300 ieraksti/mēn, 120 min Notes/mēn, 2.99 EUR/mēn
  "pro-yearly": { dailyLimit: 999999, monthlyLimit: 300, notesMinutesLimit: 120 },  // Pro Yearly: 300 ieraksti/mēn, 120 min Notes/mēn (ikmēneša limits), 29.99 EUR/gadā
  dev:      { dailyLimit: 999999, monthlyLimit: 999999, notesMinutesLimit: null }     // Dev: bez limits (testēšanai)
};
const GRACE_DAILY = 2; // “kļūdu buferis” – ne-soda mēģinājumi dienā

/* ===== SQLite kvotu stāvoklis ===== */

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
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset" // e.g., GMT+02:00
  });
  const partsArr = dtf.formatToParts(d);
  const parts = Object.fromEntries(partsArr.map(p => [p.type, p.value]));
  // parts.timeZoneName like "GMT+02:00" or "GMT+2" → normalize to "+HH:MM"
  let offset = (parts.timeZoneName || "GMT+00:00").replace(/^GMT/, "");

  // FIX: Normalize offset to +HH:MM format (handle "+2" or "+3" from some Node.js versions)
  if (offset && !/[+-]\d{2}:\d{2}/.test(offset)) {
    const match = offset.match(/([+-])(\d{1,2})/);
    if (match) {
      offset = `${match[1]}${match[2].padStart(2, '0')}:00`;
    }
  }

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

// ===== Simple deterministic LV parser (v2 under flag) =====
// Normalizācija pirms parsēšanas - labo biežākās kļūdas
// V3 Parser removed - using GPT-4.1-mini only

// V3 Parser class and exports removed - using GPT-4.1-mini only

/**
 * Parse Latvian calendar/reminder text using GPT-4.1-mini
   * @param {string} text - Input text
 * @param {string} nowISO - Current time ISO string
   * @param {string} langHint - Language hint (default: 'lv')
 * @returns {Object|null} Parsed result
 */
// Generic parser function that works with any GPT model
// Used for GPT-4.1-mini, GPT-5-mini, GPT-5-nano
async function parseWithGPT(text, requestId, nowISO, langHint = 'lv', modelName = DEFAULT_TEXT_MODEL) {
  const gptStart = Date.now();
  
  const now = new Date(nowISO);
  const rigaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Riga' }));
  
  const today = rigaTime.toISOString().split('T')[0]; // YYYY-MM-DD
  const currentTime = rigaTime.toTimeString().split(' ')[0]; // HH:mm:ss
  const dayNames = ['svētdiena', 'pirmdiena', 'otrdien', 'trešdien', 'ceturtdien', 'piektdien', 'sestdien'];
  const currentDay = dayNames[rigaTime.getDay()];
  
  // Calculate tomorrow
  const tomorrow = new Date(rigaTime);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];
  
  // Calculate relative times for examples (using toRigaISO for proper timezone)
  const plus10min = new Date(rigaTime);
  plus10min.setMinutes(plus10min.getMinutes() + 10);
  const plus10minISO = toRigaISO(plus10min);
  
  const plus20min = new Date(rigaTime);
  plus20min.setMinutes(plus20min.getMinutes() + 20);
  const plus20minISO = toRigaISO(plus20min);
  
  const plus2hours = new Date(rigaTime);
  plus2hours.setHours(plus2hours.getHours() + 2);
  const plus2hoursISO = toRigaISO(plus2hours);
  
  const plus1hour = new Date(rigaTime);
  plus1hour.setHours(plus1hour.getHours() + 1);
  const plus1hourISO = toRigaISO(plus1hour);
  
  const promptStart = Date.now();
  const systemPrompt = `Tu esi balss asistents latviešu valodai. Pārvērš lietotāja runu JSON formātā.

WHISPER KĻŪDU LABOŠANA:
Labo acīmredzamas kļūdas: "sastajā"→"sestajā" (26.), "pulkstenis"→"pulksten", "reit"/"rit"→"rīt", "grāmatu vedējs"→"grāmatvede". Ja labo, ieliec "corrected_input".
SVARĪGI: Saglabā profesionālos terminus - "grāmatvede" (NE "grāmatu vedējs"), "grāmatvedis" (NE "grāmatu vedējs").

KONTEKSTS:
Datums: ${today}, Rīt: ${tomorrowDate}, Laiks: ${currentTime}, Diena: ${currentDay}, Timezone: Europe/Riga

PRASĪBAS:
1. Atbildē TIKAI JSON - bez markdown, bez teksta
2. Viena darbība: reminder VAI calendar VAI shopping
3. VAIRĀKAS darbības: TIKAI reminder tipam, BET TIKAI ja ir vairāki skaidri norādīti pulksteņa laiki
   - Piemēram: "uztaisi trīs atgādinājumus: rīt plkst 9, pirmdien plkst 14, trešdien plkst 18" → 3 reminderi
   - Piemēram: "atgādini rīt 9, 10 un 11" → 3 reminderi
   - NEIZVEIDOT vairākus reminderus, ja teksts ir viens garš teikums ar vienu laiku (piem., "atgādini man rīt deviņos desmit, serverī vakarā ir arī svarīgāks" → 1 reminders)
4. Ja VIENA darbība: JSON: {type, description, notes, start, end, hasTime, items, lang, corrected_input}
5. Ja VAIRĀKAS REMINDER (tikai ar vairākiem skaidriem laikiem): JSON: {type:"multiple", tasks:[{type:"reminder", description, notes, start, end, hasTime, items, lang}, ...]}

TIPU ATŠĶIRŠANA (REMINDER vs CALENDAR):
- REMINDER: Ja teksts sākas ar "atgādini", "atgādināt", "atgādinājums" vai līdzīgiem vārdiem
- CALENDAR: Ja teksts satur "tikšanās", "sapulce", "notikums", "pasākums" UN nav vārda "atgādini" priekšā
- CALENDAR: Ja teksts satur laiku un datumu, bet nav skaidrs "atgādini" konteksts → calendar
- REMINDER: Ja teksts ir īss uzdevums bez konkrēta notikuma (piem., "zvanīt", "pierakstīt", "atcerēties")
- CALENDAR: Ja teksts satur vietu (piem., "Rīgā", "kafejnīcā", "ofisā") un laiku → calendar
- REMINDER: Ja teksts ir "pieraksti", "piezīme", "ideja", "note" → reminder (inbox reminder)

NOTES FIELD LOĢIKA:
- "notes" lauks ir pieejams reminder UN calendar tipiem - shopping tipam vienmēr notes = null
- Reminder tipam: "notes" ir papildu konteksts/garāks teksts, kas neietilpst īsajā "description"
- Calendar tipam: "notes" ir papildu informācija par notikumu (piem., "ar komandu", "jāņem dokumenti", "Zoom link")
- Reminder tipam: Ja teksts ir garāks (>10 vārdi) → description = īss summary, notes = full text vai papildu detaļas
- Calendar tipam: Ja ir papildu informācija pēc galvenās darbības (piem., "ar piezīmi ka...", "piezīmē ka...") → notes field
- Ja vienkāršs reminder vai calendar bez papildu informācijas → notes = null
- Reminder tipam: Trigger vārdi priekš "inbox reminder" (bez due date): "pieraksti", "piezīme", "ideja", "note", "atceros"

LAIKA LOĢIKA:
- "rīt"=${tomorrowDate}, "šodien"=${today}, "pirmdien/otrdien/utt"=nākamā diena
- "no rīta"=09:00, "pēcpusdienā/dienā"=14:00, "vakarā"=18:00 (ja nav precīzs laiks)
- plkst 1-7 bez "no rīta"→PM (14:00-19:00), plkst 8-11→AM, plkst 12+→keep
- SVARĪGI: Ja ir norādīts skaitlisks laiks (1-12) + "vakarā", tad "vakarā" tikai norāda PM, bet NEDRĪKST mainīt laiku:
  * "5 vakarā" = 17:00 (5 PM), NEVIS 18:00 (6 PM)
  * "9 vakarā" = 21:00 (9 PM), NEVIS 22:00 (10 PM)
  * "vakarā" tikai palīdz saprast par kuru dienas daļu ir runa, bet laiks jau ir norādīts
- Ja ir skaitlisks laiks (13-23), ignorēt "vakarā" - laiks jau ir 24h formātā

DATUMU SAPRATNE:
- "divdesmit sestajā novembrī"=26. novembris (NE 10:20!)
- "20. novembrī plkst 14"=20. novembris 14:00 (NE 02:00!)
- Ordinal skaitļi (sestajā, divdesmitajā)=datumi, NE laiki

RELATĪVĀ LAIKA PARSĒŠANA (REMINDER):
- "pēc X minūtēm" → pašreizējais laiks + X minūtes (aprēķināt precīzu datumu un laiku)
- "pēc X stundām" → pašreizējais laiks + X stundas
- "pēc X dienām" → pašreizējais laiks + X dienas
- Parsē gan ciparus ("pēc 10 minūtēm"), gan skaitļu vārdus ("pēc desmit minūtēm", "pēc divdesmit minūtēm")
- Parsē gan pilnos vārdus ("minūtēm", "stundām"), gan saīsinājumus ("min", "h")
- Izmantot pašreizējo laiku: ${currentTime}, Datums: ${today}
- SVARĪGI: Ja teksts satur "pēc X minūtēm/stundām/dienām", APRĒĶINĀT precīzu datumu un laiku, nevis atstāt start=null

CALENDAR: Vienmēr pievieno end (+1h no start). Ja nav laika→hasTime=false, bet default 14:00.

SVARĪGI - TIPU ATŠĶIRŠANA:
- "Tikšanās ar Jāni rīt plkst 10" → CALENDAR (nav "atgādini")
- "Atgādini man tikšanās ar Jāni rīt plkst 10" → REMINDER (ir "atgādini")
- "Rīt tikšanās ar Jāni Rīgā" → CALENDAR (nav "atgādini", ir vieta)
- "Tikšanās ar Jāni rīt desmitos" → CALENDAR (nav "atgādini")
- "Atgādini man rīt plkst 9 zvanīt" → REMINDER (ir "atgādini")

PIEMĒRI:

Input: "Divdesmit sastajā novembrī sapulce Limbažos" (KĻŪDA: "sastajā")
{"type":"calendar","description":"Sapulce Limbažos","notes":null,"start":"2025-11-26T14:00:00+02:00","end":"2025-11-26T15:00:00+02:00","hasTime":false,"items":null,"lang":"lv","corrected_input":"Divdesmit sestajā novembrī sapulce Limbažos"}

Input: "reit plkstenis 9 atgādini man" (KĻŪDAS: "reit","plkstenis")
{"type":"reminder","description":"Atgādinājums","notes":null,"start":"${tomorrowDate}T09:00:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv","corrected_input":"rīt pulksten 9 atgādini man"}

Input: "Pieraksti ideja dark mode"
{"type":"reminder","description":"Ideja","notes":"dark mode","start":null,"end":null,"hasTime":false,"items":null,"lang":"lv","corrected_input":null}

Input: "Zvanīt Jānim apspriest budžetu"
{"type":"reminder","description":"Zvanīt Jānim","notes":"Apspriest budžetu","start":null,"end":null,"hasTime":false,"items":null,"lang":"lv","corrected_input":null}

Input: "Atgādini man rīt 9 zvanīt klientam Jānim un apspriest budžetu"
{"type":"reminder","description":"Zvanīt klientam Jānim","notes":"Apspriest budžetu","start":"${tomorrowDate}T09:00:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv","corrected_input":null}

Input: "20. novembrī pulksten 14 budžeta izskatīšana"
{"type":"calendar","description":"Budžeta izskatīšana","notes":null,"start":"2025-11-20T14:00:00+02:00","end":"2025-11-20T15:00:00+02:00","hasTime":true,"items":null,"lang":"lv","corrected_input":null}

Input: "pievieno sapulci rīt plkst 2 ar piezīmi ka būs ar komandu"
{"type":"calendar","description":"Sapulce","notes":"Ar komandu","start":"${tomorrowDate}T14:00:00+02:00","end":"${tomorrowDate}T15:00:00+02:00","hasTime":true,"items":null,"lang":"lv","corrected_input":null}

Input: "rīt piecos vakarā tikšanās ar mīļoto teātri"
{"type":"calendar","description":"Tikšanās ar mīļoto teātri","notes":null,"start":"${tomorrowDate}T17:00:00+02:00","end":"${tomorrowDate}T18:00:00+02:00","hasTime":true,"items":null,"lang":"lv","corrected_input":null}

Input: "9 no rīt atgādini"
{"type":"reminder","description":"Atgādinājums","notes":null,"start":"${tomorrowDate}T09:00:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv","corrected_input":null}

Input: "pievieno piens, maize, olas"
{"type":"shopping","description":"Pirkumi","notes":null,"start":null,"end":null,"hasTime":false,"items":"piens, maize, olas","lang":"lv","corrected_input":null}

VAIRĀKU REMINDER PIEMĒRI (TIKAI REMINDER - TIKAI ar vairākiem skaidriem laikiem):

Input: "uztaisi trīs atgādinājumus: rīt plkst 9, pirmdien plkst 14, trešdien plkst 18"
{"type":"multiple","tasks":[{"type":"reminder","description":"Atgādinājums","notes":null,"start":"${tomorrowDate}T09:00:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv"},{"type":"reminder","description":"Atgādinājums","notes":null,"start":"2025-01-XXT14:00:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv"},{"type":"reminder","description":"Atgādinājums","notes":null,"start":"2025-01-XXT18:00:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv"}]}

Input: "atgādini rīt 9, 10 un 11"
{"type":"multiple","tasks":[{"type":"reminder","description":"Atgādinājums","notes":null,"start":"${tomorrowDate}T09:00:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv"},{"type":"reminder","description":"Atgādinājums","notes":null,"start":"${tomorrowDate}T10:00:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv"},{"type":"reminder","description":"Atgādinājums","notes":null,"start":"${tomorrowDate}T11:00:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv"}]}

Input: "Atgādini man rīt deviņos desmit, serverī vakarā ir arī svarīgāks, ja pasaka, ka maini arī deviņos no rīta, viņš tāpat ieliek sešos vakarā"
{"type":"reminder","description":"Atgādini man rīt deviņos desmit","notes":"Serverī vakarā ir arī svarīgāks, ja pasaka, ka maini arī deviņos no rīta, viņš tāpat ieliek sešos vakarā","start":"${tomorrowDate}T09:10:00+02:00","end":null,"hasTime":true,"items":null,"lang":"lv","corrected_input":null}

RELATĪVĀ LAIKA PIEMĒRI (REMINDER):

Input: "Atgādini pēc desmit minūtēm izmazgāt zobus"
{"type":"reminder","description":"Izmazgāt zobus","notes":null,"start":"${plus10minISO}","end":null,"hasTime":true,"items":null,"lang":"lv","corrected_input":null}

Input: "Atgādini pēc divdesmit minūtēm pārbaudīt e-pastu"
{"type":"reminder","description":"Pārbaudīt e-pastu","notes":null,"start":"${plus20minISO}","end":null,"hasTime":true,"items":null,"lang":"lv","corrected_input":null}

Input: "Atgādini pēc 10 minūtēm zvanīt grāmatvedei"
{"type":"reminder","description":"Zvanīt grāmatvedei","notes":null,"start":"${plus10minISO}","end":null,"hasTime":true,"items":null,"lang":"lv","corrected_input":null}

Input: "Atgādini pēc divām stundām zvanīt klientam"
{"type":"reminder","description":"Zvanīt klientam","notes":null,"start":"${plus2hoursISO}","end":null,"hasTime":true,"items":null,"lang":"lv","corrected_input":null}

Input: "Atgādini pēc stundas izslēgt krāsni"
{"type":"reminder","description":"Izslēgt krāsni","notes":null,"start":"${plus1hourISO}","end":null,"hasTime":true,"items":null,"lang":"lv","corrected_input":null}

SVARĪGI: Ja lietotājs prasa calendar + reminder VAI shopping + reminder, atgriez TIKAI PIRMO darbību (calendar vai shopping). Multi-item atbalsts ir TIKAI reminder tipam.`;
  const promptBuildTime = Date.now() - promptStart;

  try {
    const apiCallStart = Date.now();
    
    // Build API parameters - remove unsupported params for GPT-5 models
    const apiParams = {
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      response_format: { type: "json_object" }
    };
    
    // GPT-5 modeļi izmanto max_completion_tokens (kā GPT-4)
    // Nav strikti ierobežojuma - JSON atbilde ir īsa (~200 tokeni), bet iestatām 4000 drošībai
    // GPT-5-nano vajag vairāk tokenu, lai izvairītos no finish_reason: 'length'
    if (modelName === 'gpt-5-nano') {
      apiParams.max_completion_tokens = 4000; // Palielināts no 2000, lai būtu drošāk
    } else {
      apiParams.max_completion_tokens = 2000; // Palielināts no 1000 visiem citiem modeļiem
    }
    
    // Only add temperature if model supports it (not GPT-5 mini/nano)
    if (!FIXED_TEMP_MODELS.has(modelName)) {
      apiParams.temperature = 0.1;
    }
    // Note: GPT-5 models don't support: top_p, logprobs, frequency_penalty, presence_penalty
    
    // Use safeCreate to handle max_tokens → max_completion_tokens conversion if needed
    let completion = await safeCreate(apiParams);
    let apiCallTime = Date.now() - apiCallStart;

    // Log completion structure for debugging
    if (FIXED_TEMP_MODELS.has(modelName)) {
      console.log(`[${requestId}] ${modelName} completion structure:`, {
        choices_count: completion.choices?.length || 0,
        finish_reason: completion.choices?.[0]?.finish_reason,
        has_content: !!completion.choices?.[0]?.message?.content,
        content_length: completion.choices?.[0]?.message?.content?.length || 0
      });
    }

    const parseStart = Date.now();
    let response = completion.choices[0]?.message?.content;
    
    // Retry logic: ja GPT-5 modelis atgriež tukšu choices, mēģinām vēlreiz ar lielāku max_completion_tokens
    if ((!response || !response.trim()) && modelName.startsWith('gpt-5')) {
      console.log(`[${requestId}] ⚠️ Empty response from ${modelName}, retrying with larger max_completion_tokens and explicit JSON instruction`);
      
      // Retry ar lielāku max_completion_tokens un skaidrāku sistēmas norādi
      const retryParams = {
        ...apiParams,
        max_completion_tokens: 2000, // Palielinām no 1000 uz 2000
        messages: [
          { 
            role: 'system', 
            content: `${systemPrompt}\n\nCRITICAL: Return a single valid JSON object. No prose, no explanations, only JSON.`
          },
          { role: 'user', content: text }
        ]
      };
      
      try {
        completion = await safeCreate(retryParams);
        apiCallTime = Date.now() - apiCallStart; // Update total time
        response = completion.choices[0]?.message?.content;
        
        if (response && response.trim()) {
          console.log(`[${requestId}] ✅ Retry successful, got ${response.length} chars`);
        } else {
          console.error(`[${requestId}] ❌ Retry also returned empty response`);
        }
      } catch (retryError) {
        console.error(`[${requestId}] Retry failed:`, retryError.message);
      }
    }
    
    // Check if response is still empty or null after retry
    if (!response || !response.trim()) {
      console.error(`[${requestId}] Empty response from ${modelName} (after retry if applicable)`);
      console.error(`[${requestId}] Completion object:`, JSON.stringify({
        id: completion.id,
        model: completion.model,
        choices: completion.choices?.map(c => ({
          index: c.index,
          finish_reason: c.finish_reason,
          message_role: c.message?.role,
          message_content: c.message?.content ? `[${c.message.content.length} chars]` : null
        }))
      }, null, 2));
      throw new Error(`Empty response from ${modelName}`);
    }
    
    response = response.trim();
    
    // Log raw response for debugging (first 500 chars)
    if (FIXED_TEMP_MODELS.has(modelName)) {
      console.log(`[${requestId}] ${modelName} raw response (first 500 chars): ${response.substring(0, 500)}`);
    }
    
    // Extract JSON from response (ja modelis atgriež tekstu + JSON)
    // 1. Mēģinām atrast JSON objektu ar regex
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      response = jsonMatch[0];
      console.log(`[${requestId}] Extracted JSON from response (${response.length} chars)`);
    } else {
      // 2. Ja nav JSON objekta, mēģinām noņemt markdown
      response = response.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    }
    
    // Check if response is still empty after cleaning
    if (!response || response.length === 0) {
      console.error(`[${requestId}] Empty response after cleaning from ${modelName}`);
      throw new Error(`Empty response after cleaning from ${modelName}`);
    }
    
    let parsed;
    try {
      parsed = JSON.parse(response);
    } catch (parseError) {
      console.error(`[${requestId}] JSON parse error from ${modelName}:`, parseError.message);
      console.error(`[${requestId}] Response content (full):`, response);
      console.error(`[${requestId}] Response length:`, response.length);
      throw new Error(`Invalid JSON from ${modelName}: ${parseError.message}`);
    }
    const parseTime = Date.now() - parseStart;
    
    const totalGptTime = Date.now() - gptStart;
    console.log(`   └─ GPT Details: prompt=${promptBuildTime}ms, api=${apiCallTime}ms, parse=${parseTime}ms, total=${totalGptTime}ms`);
    
    // Check if multiple tasks - ONLY for reminder type
    if (parsed.type === "multiple" && Array.isArray(parsed.tasks) && parsed.tasks.length > 1) {
      // Filter only reminder tasks (ignore calendar/shopping in multi-item)
      const reminderTasks = parsed.tasks.filter(task => task.type === "reminder");
      
      // Only return multi-item if all tasks are reminders
      if (reminderTasks.length > 1 && reminderTasks.length === parsed.tasks.length) {
        // Convert to MultiReminderResponse format (iOS app expects this)
        const reminders = reminderTasks.map(task => ({
          type: task.type,
          description: task.description || "Atgādinājums",
          notes: task.notes || null,
          start: task.start || null,
          end: task.end || null,
          hasTime: task.hasTime || false,
          items: task.items || null,
          lang: task.lang || 'lv',
          raw_transcript: text,
          normalized_transcript: text,
          confidence: 0.95,
          source: modelName
        }));
        
        return {
          type: "reminders", // iOS app expects "reminders" type
          lang: parsed.lang || 'lv',
          reminders: reminders,
          raw_transcript: text,
          normalized_transcript: text,
          confidence: 0.95,
          source: modelName
        };
      }
      // If mixed types, return only first non-reminder task (fall through to single item)
      if (reminderTasks.length === 0 && parsed.tasks.length > 0) {
        // All tasks are non-reminder, return first one
        const firstTask = parsed.tasks[0];
        return {
          type: firstTask.type,
          description: firstTask.description,
          notes: firstTask.notes || null,
          start: firstTask.start,
          end: firstTask.end,
          hasTime: firstTask.hasTime,
          items: firstTask.items,
          lang: firstTask.lang || 'lv',
          corrected_input: parsed.corrected_input || null,
          raw_transcript: text,
          normalized_transcript: text,
          confidence: 0.95,
          source: modelName
        };
      }
    }
    
    // Single item (backward compatible)
    return {
      type: parsed.type,
      description: parsed.description,
      notes: parsed.notes || null,
      start: parsed.start,
      end: parsed.end,
      hasTime: parsed.hasTime,
      items: parsed.items,
      lang: parsed.lang || 'lv',
      corrected_input: parsed.corrected_input || null,
      raw_transcript: text,
      normalized_transcript: text,
      confidence: 0.95,
      source: modelName
    };
    
  } catch (error) {
    console.error(`[${requestId}] GPT parsing error (${modelName}):`, error);
    
    // Fallback: ja GPT-5-nano neizdodas, mēģinām GPT-4.1-mini
    if (modelName === 'gpt-5-nano' && DEFAULT_TEXT_MODEL === 'gpt-5-nano') {
      console.log(`[${requestId}] ⚠️ GPT-5-nano failed, falling back to GPT-4.1-mini`);
      try {
        return await parseWithGPT(text, requestId, nowISO, langHint, 'gpt-4.1-mini');
      } catch (fallbackError) {
        console.error(`[${requestId}] Fallback to GPT-4.1-mini also failed:`, fallbackError);
        throw new Error(`GPT parsing failed (nano + fallback): ${error.message}`);
      }
    }
    
    throw new Error(`GPT parsing failed: ${error.message}`);
  }
}

// Wrapper for GPT-4.1-mini (backward compatibility)
async function parseWithGPT41(text, requestId, nowISO, langHint = 'lv') {
  return parseWithGPT(text, requestId, nowISO, langHint, DEFAULT_TEXT_MODEL);
}

function normalizeForParser(text) {
  let normalized = text;
  // Labo relatīvo dienu kļūdas (bet ne personvārdus)
  // "Rītu" kā personvārds parasti ir ar lielo burtu un pirms tam ir cits vārds (piem., "ar Jāni Rītu")
  // "Rītu", "rit", "reit" → "rīt" (vienmēr, jo "Rītu" nav personvārds, bet nozīmē "rīt")
  normalized = normalized.replace(/\b([Rr]ītu|[Rr]it|[Rr]eit)\b/gi, (match) => {
    return match.charAt(0) === 'R' ? 'Rīt' : 'rīt';
  });
  // Labo citas biežas kļūdas
  normalized = normalized.replace(/\bpulkstenis\b/gi, "pulksten");
  return normalized;
}

// parseWithCode (Parser V2) removed - replaced by GPT-4.1-mini
// V2 nekad nestrādāja pareizi, tāpēc to noņēmām
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
  if (p === "pro-yearly") return { plan: "pro-yearly", dailyLimit: plans["pro-yearly"].dailyLimit, monthlyLimit: 300, notesMinutesLimit: plans["pro-yearly"].notesMinutesLimit };
  if (p === "pro") return { plan: "pro", dailyLimit: plans.pro.dailyLimit, monthlyLimit: plans.pro.monthlyLimit, notesMinutesLimit: plans.pro.notesMinutesLimit };
  if (p === "basic") return { plan: "basic", dailyLimit: plans.basic.dailyLimit, monthlyLimit: plans.basic.monthlyLimit, notesMinutesLimit: plans.basic.notesMinutesLimit };
  if (p === "dev") return { plan: "dev", dailyLimit: plans.dev.dailyLimit, monthlyLimit: plans.dev.monthlyLimit, notesMinutesLimit: plans.dev.notesMinutesLimit };
  return { plan: "free", dailyLimit: plans.free.dailyLimit, monthlyLimit: plans.free.monthlyLimit, notesMinutesLimit: plans.free.notesMinutesLimit }; // Default: free
}
async function getUserUsage(userId, planHeader) {
  const limits = getPlanLimits(planHeader);
  const today = todayKeyRiga();
  const mKey = monthKeyRiga();
  
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM quota_usage WHERE user_id = ? AND day_key = ?`,
      [userId, today],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (!row) {
          // Create new record
          db.run(
            `INSERT OR IGNORE INTO quota_usage (user_id, plan, day_key, month_key, daily_used, daily_grace_used, monthly_used) 
             VALUES (?, ?, ?, ?, 0, 0, 0)`,
            [userId, limits.plan, today, mKey],
            function(err) {
              if (err) {
                reject(err);
                return;
              }
              resolve({
                u: {
                plan: limits.plan,
                daily: { dayKey: today, used: 0, graceUsed: 0 },
                monthly: { monthKey: mKey, used: 0 },
                notesMinutes: { monthKey: mKey, used: 0 }
              },
              limits
            });
            }
          );
        } else {
          // Update plan if changed
          if (row.plan !== limits.plan) {
            db.run(
              `UPDATE quota_usage SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND day_key = ?`,
              [limits.plan, userId, today]
            );
          }
          
          // Calculate actual monthly usage from SUM of daily_used for all plans with monthly limits
          Promise.all([
            calculateMonthlyUsage(userId, mKey),
            calculateNotesMinutesUsage(userId, mKey)
          ]).then(([totalMonthly, totalNotesMinutes]) => {
            resolve({
              u: {
                plan: limits.plan,
                daily: { dayKey: row.day_key, used: row.daily_used, graceUsed: row.daily_grace_used },
                monthly: { monthKey: row.month_key, used: totalMonthly },
                notesMinutes: { monthKey: row.month_key, used: totalNotesMinutes }
              },
              limits
            });
          }).catch(reject);
        }
      }
    );
  });
}

// Calculate actual monthly usage from SUM of daily_used
async function calculateMonthlyUsage(userId, monthKey) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COALESCE(SUM(daily_used), 0) as total_monthly_used 
       FROM quota_usage 
       WHERE user_id = ? AND month_key = ?`,
      [userId, monthKey],
      (err, row) => {
        if (err) reject(err);
        else resolve(row?.total_monthly_used || 0);
      }
    );
  });
}

// Calculate actual monthly Notes minutes usage from SUM of notes_minutes_used
async function calculateNotesMinutesUsage(userId, monthKey) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COALESCE(SUM(notes_minutes_used), 0) as total_notes_minutes_used 
       FROM quota_usage 
       WHERE user_id = ? AND month_key = ?`,
      [userId, monthKey],
      (err, row) => {
        if (err) reject(err);
        else resolve(row?.total_notes_minutes_used || 0);
      }
    );
  });
}

// Use top-up if monthly limit exceeded (for PRO plan)
async function useTopUpIfNeeded(userId, monthKey, monthlyLimit) {
  return new Promise((resolve, reject) => {
    // Check if monthly usage exceeds base limit
    calculateMonthlyUsage(userId, monthKey).then(totalMonthly => {
      if (totalMonthly <= monthlyLimit) {
        // Still within base limit, no top-up needed
        resolve(0);
        return;
      }
      
      // Need to use top-ups
      const topUpNeeded = totalMonthly - monthlyLimit;
      
      // Get available top-ups (oldest first)
      db.all(
        `SELECT id, amount_remaining 
         FROM top_ups 
         WHERE user_id = ? AND month_key = ? AND amount_remaining > 0
         ORDER BY created_at ASC`,
        [userId, monthKey],
        (err, topUps) => {
          if (err) {
            reject(err);
            return;
          }
          
          if (!topUps || topUps.length === 0) {
            resolve(0);
            return;
          }
          
          let remainingToUse = topUpNeeded;
          let totalUsed = 0;
          
          // Use top-ups in order
          const updatePromises = topUps.map(topUp => {
            if (remainingToUse <= 0) return Promise.resolve();
            
            const useFromThis = Math.min(remainingToUse, topUp.amount_remaining);
            remainingToUse -= useFromThis;
            totalUsed += useFromThis;
            
            return new Promise((res, rej) => {
              db.run(
                `UPDATE top_ups 
                 SET amount_remaining = amount_remaining - ? 
                 WHERE id = ?`,
                [useFromThis, topUp.id],
                (err) => err ? rej(err) : res()
              );
            });
          });
          
          Promise.all(updatePromises)
            .then(() => resolve(totalUsed))
            .catch(reject);
        }
      );
    }).catch(reject);
  });
}

async function updateQuotaUsage(userId, plan, dailyUsed, dailyGraceUsed, monthlyLimit) {
  const today = todayKeyRiga();
  const mKey = monthKeyRiga();
  
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE quota_usage 
       SET daily_used = ?, daily_grace_used = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND day_key = ?`,
      [dailyUsed, dailyGraceUsed, userId, today],
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        
        // Update monthly_used field for easier tracking (for plans with monthly limits)
        if (plan === "pro" || plan === "pro-yearly" || plan === "basic" || plan === "free") {
          calculateMonthlyUsage(userId, mKey).then(totalMonthly => {
            db.run(
              `UPDATE quota_usage SET monthly_used = ? WHERE user_id = ? AND month_key = ?`,
              [totalMonthly, userId, mKey],
              () => {
                // Use top-ups if needed (only for pro plan)
                if (plan === "pro") {
                  useTopUpIfNeeded(userId, mKey, monthlyLimit)
                    .then(() => resolve())
                    .catch(reject);
                } else {
                  resolve();
                }
              }
            );
          }).catch(reject);
        } else {
          resolve();
        }
      }
    );
  });
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

// Format shopping items with quantities and units
function formatShoppingItems(itemsString) {
  if (!itemsString || typeof itemsString !== 'string') return itemsString;
  
  // Number word to digit mapping (Latvian)
  const numberWords = {
    'viens': 1, 'viena': 1, 'vienu': 1,
    'divi': 2, 'divas': 2, 'divus': 2,
    'trīs': 3,
    'četri': 4, 'četras': 4, 'četrus': 4,
    'pieci': 5, 'piecas': 5, 'piecus': 5,
    'seši': 6, 'sešas': 6, 'sešus': 6,
    'septiņi': 7, 'septiņas': 7, 'septiņus': 7,
    'astoņi': 8, 'astoņas': 8, 'astoņus': 8,
    'deviņi': 9, 'deviņas': 9, 'deviņus': 9,
    'desmit': 10,
    'divdesmit': 20, 'trīsdesmit': 30, 'četrdesmit': 40, 'piecdesmit': 50,
    'sešdesmit': 60, 'septiņdesmit': 70, 'astoņdesmit': 80, 'deviņdesmit': 90,
    'simts': 100, 'divsimt': 200, 'trīssimt': 300, 'trīsimts': 300,
    'četrsimt': 400, 'piecsimt': 500, 'sešsimt': 600,
    'septiņsimt': 700, 'astoņsimt': 800, 'deviņsimt': 900
  };
  
  // Unit mappings
  const unitMap = {
    'kilogrami': 'kg', 'kilogramu': 'kg', 'kilogramus': 'kg', 'kilograma': 'kg',
    'kilogram': 'kg', 'kilogramam': 'kg',
    'litri': 'l', 'litru': 'l', 'litrus': 'l', 'litra': 'l',
    'litr': 'l', 'litram': 'l',
    'grami': 'g', 'gramu': 'g', 'gramus': 'g', 'grama': 'g',
    'gram': 'g', 'gramam': 'g',
    'gabali': 'gb', 'gabalu': 'gb', 'gabalus': 'gb', 'gabala': 'gb',
    'gabals': 'gb', 'gabalam': 'gb', 'gab': 'gb'
  };
  
  // Split items by comma
  const items = itemsString.split(',').map(item => item.trim());
  
  return items.map(item => {
    if (!item) return item;
    
    const lowerItem = item.toLowerCase();
    let formatted = item;
    
    // Extract number (word or digit)
    let number = null;
    let numberWord = null;
    let digitMatch = null;
    
    // Check for number words
    for (const [word, num] of Object.entries(numberWords)) {
      const wordRegex = new RegExp(`\\b${word}\\b`, 'gi');
      if (wordRegex.test(lowerItem)) {
        number = num;
        numberWord = word;
        break;
      }
    }
    
    // If no number word, check for digits
    if (number === null) {
      digitMatch = lowerItem.match(/\b(\d+)\b/);
      if (digitMatch) {
        number = parseInt(digitMatch[1], 10);
      }
    }
    
    // Extract unit
    let unit = null;
    let unitWord = null;
    for (const [word, abbr] of Object.entries(unitMap)) {
      const unitRegex = new RegExp(`\\b${word}\\b`, 'gi');
      if (unitRegex.test(lowerItem)) {
        unit = abbr;
        unitWord = word;
        break;
      }
    }
    
    // If we have both number and unit, format it
    if (number !== null && unit !== null) {
      // Remove number word/digit and unit word from the string
      let productName = lowerItem;
      if (numberWord) {
        productName = productName.replace(new RegExp(`\\b${numberWord}\\b`, 'gi'), '');
      } else if (digitMatch) {
        productName = productName.replace(/\b\d+\b/, '');
      }
      if (unitWord) {
        productName = productName.replace(new RegExp(`\\b${unitWord}\\b`, 'gi'), '');
      }
      
      // Clean up product name (remove extra spaces)
      productName = productName.replace(/\s+/g, ' ').trim();
      
      // Format: "productName number unit" (always product first, then quantity)
      formatted = productName ? `${productName} ${number} ${unit}` : `${number} ${unit}`;
      
      // Capitalize first letter
      if (formatted.length > 0) {
        formatted = formatted[0].toUpperCase() + formatted.slice(1);
      }
    } else if (number !== null && !unit) {
      // Only number, no unit - just replace number word with digit
      if (numberWord) {
        formatted = lowerItem.replace(new RegExp(`\\b${numberWord}\\b`, 'gi'), number.toString());
        // Capitalize first letter
        if (formatted.length > 0) {
          formatted = formatted[0].toUpperCase() + formatted.slice(1);
        }
      }
    } else if (unit !== null && !number) {
      // Only unit, no number - just replace unit word with abbreviation
      formatted = lowerItem.replace(new RegExp(`\\b${unitWord}\\b`, 'gi'), unit);
      // Capitalize first letter
      if (formatted.length > 0) {
        formatted = formatted[0].toUpperCase() + formatted.slice(1);
      }
    }
    
    return formatted || item;
  }).join(', ');
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

/* ===== JSON Schema definīcijas ===== */
// OpenAI JSON Schema - strict: false, lai atļautu optional laukus
const EVENT_SCHEMA = {
  name: "calendar_or_reminder",
  schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["reminder", "calendar", "shopping"]
      },
      lang: {
        type: "string",
        const: "lv"
      },
      description: {
        type: "string",
        minLength: 1
      },
      notes: {
        type: "string",
        description: "Optional notes for reminder and calendar types"
      },
      start: {
        type: "string",
        description: "ISO 8601, Europe/Riga, format: YYYY-MM-DDTHH:MM",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}"
      },
      end: {
        type: "string",
        description: "ISO 8601, Europe/Riga, format: YYYY-MM-DDTHH:MM (for calendar)",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}"
      },
      hasTime: {
        type: "boolean",
        description: "For reminder type"
      },
      items: {
        type: "string",
        minLength: 1,
        description: "For shopping type"
      }
    },
    required: ["type", "lang", "description"], // Minimal required fields
    additionalProperties: false
  }
};

/* ===== Validācija ===== */
function isValidCalendarJson(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.type === "reminder") {
    return !!(obj.description && obj.start && obj.hasTime !== undefined && obj.lang);
  }
  if (obj.type === "calendar") {
    return !!(obj.description && obj.start && obj.end && obj.lang);
  }
  if (obj.type === "shopping") {
    return !!(obj.items && obj.lang);
  }
  if (obj.type === "reminders") {
    // Multi-reminder atbalsts
    return !!(Array.isArray(obj.reminders) && obj.reminders.length > 0 && obj.lang);
  }
  return false;
}


/* ===== RATE LIMITING ===== */
import rateLimit from 'express-rate-limit';

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

// Cache for health check status (check every 30 seconds, not every request)
let healthCheckStatus = {
  isReady: false,
  lastChecked: 0,
  checkInterval: 30000 // 30 seconds
};

async function performHealthCheck() {
  const now = Date.now();
  
  // Use cached result if less than 30 seconds old
  if (now - healthCheckStatus.lastChecked < healthCheckStatus.checkInterval) {
    return healthCheckStatus.isReady;
  }
  
  try {
    // Quick OpenAI API test
    await openai.models.list(); // Lightweight API call
    healthCheckStatus.isReady = true;
    healthCheckStatus.lastChecked = now;
    return true;
  } catch (error) {
    healthCheckStatus.isReady = false;
    healthCheckStatus.lastChecked = now;
    return false;
  }
}

app.get("/ready", async (req, res) => {
  const isReady = await performHealthCheck();
  const status = isReady ? "ready" : "not_ready";
  const statusCode = isReady ? 200 : 503;
  
  res.status(statusCode).json({
    status,
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
    openai: isReady ? "reachable" : "unreachable",
    cached: Date.now() - healthCheckStatus.lastChecked < healthCheckStatus.checkInterval
  });
});

app.get("/version", (req, res) => res.json({
  version: "2025.01.15-1",
  requestId: req.requestId,
  timestamp: new Date().toISOString(),
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || "unknown",
  node: process.version
}));

app.get("/metrics", async (req, res) => {
  // Require authentication for metrics endpoint
  let auth = req.headers.authorization || "";
  
  // Pagaidu risinājums: ja Authorization header nav nosūtīts vai ir tukšs,
  // automātiski pieņem "Bearer secret123" (emergency fallback)
  // TODO: Noņemt pēc token pievienošanas Xcode projektā
  if (!auth || auth.trim() === "" || auth === "Bearer ") {
    console.log(`[${req.requestId}] ⚠️ Authorization header missing or empty - using fallback token`);
    auth = "Bearer secret123";
  }
  
  const validTokens = [
    `Bearer ${APP_BEARER_TOKEN}`,
    "Bearer secret123" // Pagaidu fallback token
  ];

  if (APP_BEARER_TOKEN && !validTokens.includes(auth)) {
    return res.status(401).json({ 
      error: "unauthorized",
      requestId: req.requestId
    });
  }
  
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});


/* ===== /quota ===== */
const normalizeDaily = (n) => (n >= 999999 ? null : n);

app.get("/quota", async (req, res) => {
  try {
    const userId = req.header("X-User-Id") || "anon";
    const planHdr = req.header("X-Plan") || "free";
    const { u, limits } = await getUserUsage(userId, planHdr);

    const dailyLimitNorm = normalizeDaily(limits.dailyLimit);
    const out = {
      plan: limits.plan,
      dailyLimit: dailyLimitNorm,
      dailyUsed: u.daily.used,
      dailyRemaining: dailyLimitNorm === null ? null : Math.max(0, limits.dailyLimit - u.daily.used),
      dailyGraceLimit: GRACE_DAILY,
      dailyGraceUsed: u.daily.graceUsed,
      dailyReset: toRigaISO(new Date(new Date().setHours(0,0,0,0) + 24*3600*1000)),
      requestId: req.requestId
    };
    
    // Add monthly limits for all plans (basic, pro, pro-yearly all have monthly limits that reset each month)
    if (limits.monthlyLimit !== null && limits.monthlyLimit !== undefined) {
      out.monthlyLimit = limits.monthlyLimit;
      out.monthlyUsed = u.monthly.used;
      out.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used);
    }
    
    // Add Notes minutes limits
    if (limits.notesMinutesLimit !== null && limits.notesMinutesLimit !== undefined) {
      out.notesMinutesLimit = limits.notesMinutesLimit;
      out.notesMinutesUsed = u.notesMinutes?.used || 0;
      out.notesMinutesRemaining = Math.max(0, limits.notesMinutesLimit - (u.notesMinutes?.used || 0));
    }
    
    return res.json(out);
  } catch (error) {
    console.error("Quota error:", error);
    return res.status(500).json({ error: "quota_failed", requestId: req.requestId });
  }
});

/* ===== HELPER FUNCTIONS ===== */

// Log transcript flow for debugging - GPT-4.1-mini ONLY (V3 removed)
function logTranscriptFlow(req, res, raw, norm, analyzedText, needsAnalysis, score, out) {
  const requestId = req.requestId.slice(-8);
  const isError = res.statusCode >= 400;
  const debugMode = process.env.DEBUG_TRANSCRIPT === 'true';
  const alwaysLogFull = process.env.LOG_FULL_TRANSCRIPT === 'true'; // Vienmēr logē pilnu tekstu
  
  // GPT-4.1-mini result (V3 removed)
  const correctedInput = out.corrected_input || null;
  
  // PILNS TEKSTA PLŪSMA LOG (vienmēr)
  console.log(`\n📊 [${requestId}] === TEKSTA PLŪSMA ===`);
  console.log(`🎤 [1] Whisper (raw):        "${raw}"`);
  console.log(`🔧 [2] Normalized:          "${norm}"`);
  if (correctedInput) {
    console.log(`🤖 [3] GPT Corrected:        "${correctedInput}" (fixed Whisper errors)`);
  } else {
    console.log(`🤖 [3] GPT Analysis:         No corrections needed`);
  }
  
  // Handle multi-item vs single item logging
  if (out.type === "reminders" && Array.isArray(out.reminders)) {
    console.log(`📤 [4] Final Result:         ${out.reminders.length} items (type: ${out.type})`);
    out.reminders.forEach((item, idx) => {
      console.log(`   └─ [${idx + 1}] ${item.type}: "${item.description || 'N/A'}"${item.start ? ' @ ' + item.start : ''}`);
    });
  } else {
    const finalDescription = out.description || 'N/A';
    console.log(`📤 [4] Final Result:         "${finalDescription}" (type: ${out.type})`);
    if (out.start) console.log(`   └─ Start: ${out.start}`);
    if (out.end) console.log(`   └─ End: ${out.end}`);
  }
  console.log(`📊 [${requestId}] ========================\n`);
  
  // Detalizēts JSON log (ja DEBUG_TRANSCRIPT vai error)
  if (debugMode || isError || alwaysLogFull) {
    console.log(JSON.stringify({
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      transcriptFlow: {
        whisper_raw: raw,
        normalized: norm,
        corrected_input: correctedInput,
        qualityScore: score,
        gpt41Result: out.type === "reminders" && Array.isArray(out.reminders) ? {
          type: out.type,
          count: out.reminders.length,
          reminders: out.reminders.map(item => ({
            type: item.type,
            description: item.description,
            start: item.start,
            end: item.end,
            hasTime: item.hasTime,
            items: item.items
          }))
        } : {
          type: out.type,
          description: out.description || 'N/A',
          start: out.start,
          end: out.end,
          hasTime: out.hasTime,
          items: out.items,
          lang: out.lang
        },
        clientFinal: out.type === "reminders" && Array.isArray(out.reminders) ? {
          type: out.type,
          count: out.reminders.length,
          reminders: out.reminders
        } : {
          type: out.type,
          description: out.description || 'N/A',
          start: out.start,
          end: out.end,
          hasTime: out.hasTime,
          items: out.items
        }
      }
    }, null, 2));
  }
}

/* ===== POST /ingest-audio ===== */
// Testa endpoints - pieņem tīru tekstu (bez audio faila)
// Lietojums: POST /test-parse {"text": "Rīt pulksten divos tikšanās ar Jāni"}
app.post("/test-parse", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: "missing_text", message: "Pievienojiet 'text' lauku" });
    }

    // Simulējam Whisper transkripciju - izmantojam tekstu tieši
    const raw = text.trim();
    const norm = normalizeTranscript(raw, 'lv');
    const analyzedText = norm; // Pagaidām bez AI analīzes testiem
    const langHint = 'lv';
    const nowISO = toRigaISO(new Date());
    
    // Izmantojam to pašu parsēšanas loģiku kā /ingest-audio
    // Parsēšana ar GPT-4.1-mini
    let parsed = null;
    
    console.log(`🧭 [TEST] GPT-4.1-mini attempting parse: "${analyzedText}"`);
    try {
      parsed = await parseWithGPT41(analyzedText, req.headers['x-request-id'] || 'test', nowISO, langHint);
      if (parsed) {
        console.log(`🧭 [TEST] GPT-4.1-mini used: type=${parsed.type}`);
      parsed.raw_transcript = raw;
      parsed.normalized_transcript = norm;
      parsed.analyzed_transcript = analyzedText;
      parsed.test_mode = true;
      return res.json(parsed);
      }
    } catch (error) {
      console.error(`❌ [TEST] GPT-4.1-mini parsing failed:`, error);
      return res.status(500).json({ error: 'Parsing failed', message: error.message });
    }
    
  } catch (error) {
    console.error("[TEST] Error:", error);
    return res.status(500).json({ error: "test_failed", details: String(error) });
  }
});

// Test endpoint for GPT-5 mini
app.post("/test-parse-gpt5-mini", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: "missing_text", message: "Pievienojiet 'text' lauku" });
    }

    const raw = text.trim();
    const norm = normalizeTranscript(raw, 'lv');
    const analyzedText = norm;
    const langHint = 'lv';
    const nowISO = toRigaISO(new Date());
    const modelName = 'gpt-5-mini';
    
    console.log(`🧭 [TEST] ${modelName} attempting parse: "${analyzedText}"`);
    try {
      const parsed = await parseWithGPT(analyzedText, req.headers['x-request-id'] || 'test', nowISO, langHint, modelName);
      if (parsed) {
        console.log(`🧭 [TEST] ${modelName} used: type=${parsed.type}`);
        parsed.raw_transcript = raw;
        parsed.normalized_transcript = norm;
        parsed.analyzed_transcript = analyzedText;
        parsed.test_mode = true;
        parsed.model_used = modelName;
        return res.json(parsed);
      }
    } catch (error) {
      console.error(`❌ [TEST] ${modelName} parsing failed:`, error);
      // If model not found, return helpful error
      if (error.message?.includes('model') || error.message?.includes('not found')) {
        return res.status(404).json({ 
          error: 'model_not_found', 
          message: `${modelName} may not be available in your region yet`,
          details: error.message 
        });
      }
      return res.status(500).json({ error: 'Parsing failed', message: error.message });
    }
    
  } catch (error) {
    console.error("[TEST] Error:", error);
    return res.status(500).json({ error: "test_failed", details: String(error) });
  }
});

// Test endpoint for GPT-5 nano
app.post("/test-parse-gpt5-nano", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: "missing_text", message: "Pievienojiet 'text' lauku" });
    }

    const raw = text.trim();
    const norm = normalizeTranscript(raw, 'lv');
    const analyzedText = norm;
    const langHint = 'lv';
    const nowISO = toRigaISO(new Date());
    const modelName = 'gpt-5-nano';
    
    console.log(`🧭 [TEST] ${modelName} attempting parse: "${analyzedText}"`);
    try {
      const parsed = await parseWithGPT(analyzedText, req.headers['x-request-id'] || 'test', nowISO, langHint, modelName);
      if (parsed) {
        console.log(`🧭 [TEST] ${modelName} used: type=${parsed.type}`);
        parsed.raw_transcript = raw;
        parsed.normalized_transcript = norm;
        parsed.analyzed_transcript = analyzedText;
        parsed.test_mode = true;
        parsed.model_used = modelName;
        return res.json(parsed);
      }
    } catch (error) {
      console.error(`❌ [TEST] ${modelName} parsing failed:`, error);
      // If model not found, return helpful error
      if (error.message?.includes('model') || error.message?.includes('not found')) {
        return res.status(404).json({ 
          error: 'model_not_found', 
          message: `${modelName} may not be available in your region yet`,
          details: error.message 
        });
      }
      return res.status(500).json({ error: 'Parsing failed', message: error.message });
    }
    
  } catch (error) {
    console.error("[TEST] Error:", error);
    return res.status(500).json({ error: "test_failed", details: String(error) });
  }
});

app.post("/ingest-audio", async (req, res) => {
  const processingStart = Date.now();
  const timings = {}; // Profiling data
  let lastTime = processingStart;
  
  try {
    // Auth
    console.time(`[${req.requestId}] auth-check`);
    const authStart = Date.now();
    if (APP_BEARER_TOKEN) {
      let auth = req.headers.authorization || "";
      
      // Pagaidu risinājums: ja Authorization header nav nosūtīts vai ir tukšs,
      // automātiski pieņem "Bearer secret123" (emergency fallback)
      // TODO: Noņemt pēc token pievienošanas Xcode projektā
      if (!auth || auth.trim() === "" || auth === "Bearer ") {
        console.log(`[${req.requestId}] ⚠️ Authorization header missing or empty - using fallback token`);
        auth = "Bearer secret123";
      }
      
      const validTokens = [
        `Bearer ${APP_BEARER_TOKEN}`,
        "Bearer secret123" // Pagaidu fallback token
      ];
      // DEBUG: Log received token (first 20 chars only for security)
      console.log(`[${req.requestId}] Auth check - Received: "${auth.substring(0, 20)}...", Valid tokens: ${validTokens.length}`);
      if (!validTokens.includes(auth)) {
        console.log(`[${req.requestId}] ❌ Auth failed - token not in valid list`);
        console.timeEnd(`[${req.requestId}] auth-check`);
        return res.status(401).json({ 
          error: "unauthorized",
          requestId: req.requestId
        });
      }
      console.log(`[${req.requestId}] ✅ Auth passed`);
    } else {
      console.log(`[${req.requestId}] ⚠️ APP_BEARER_TOKEN not set - skipping auth`);
    }
    console.timeEnd(`[${req.requestId}] auth-check`);
    timings.auth = Date.now() - authStart;
    lastTime = Date.now();

    // Idempotency check
    console.time(`[${req.requestId}] idempotency-check`);
    const idempotencyStart = Date.now();
    const idempotencyKey = req.header("Idempotency-Key");
    if (idempotencyKey) {
      const cached = idempotency.get(idempotencyKey);
      if (cached && cached.expires > Date.now()) {
        console.timeEnd(`[${req.requestId}] idempotency-check`);
        console.log(`🔄 [${req.requestId}] Returning cached result for Idempotency-Key: ${idempotencyKey}`);
        return res.json({
          ...cached.result,
          requestId: req.requestId,
          cached: true
        });
      }
    }
    console.timeEnd(`[${req.requestId}] idempotency-check`);
    timings.idempotency = Date.now() - idempotencyStart;
    lastTime = Date.now();

    // Identitāte & plāns kvotām
    console.time(`[${req.requestId}] getUserUsage`);
    const getUserUsageStart = Date.now();
    const userId = req.header("X-User-Id") || "anon";
    const planHdr = req.header("X-Plan") || "basic";
    const langHint = (req.header("X-Lang") || "lv").toLowerCase();
    const { u, limits } = await getUserUsage(userId, planHdr);
    console.timeEnd(`[${req.requestId}] getUserUsage`);
    timings.getUserUsage = Date.now() - getUserUsageStart;
    lastTime = Date.now();

    // Pārbaude pirms apstrādes
    if (u.daily.used >= limits.dailyLimit) {
      return res.status(429).json({ error: "quota_exceeded", plan: limits.plan });
    }
    // Check monthly limits for all plans (basic, pro, pro-yearly all have monthly limits that reset each month)
    if (limits.monthlyLimit !== null && limits.monthlyLimit !== undefined) {
      if (u.monthly.used >= limits.monthlyLimit) {
        return res.status(429).json({ error: "monthly_quota_exceeded", plan: limits.plan });
      }
    }

    // Multipart
    console.time(`[${req.requestId}] busboy-parsing`);
    const busboyStart = Date.now();
    const fields = {};
    let fileBuf = Buffer.alloc(0);
    let filename = "audio.m4a";
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 8 * 1024 * 1024 } });
    let fileTooLarge = false;

    await new Promise((resolve, reject) => {
      bb.on("field", (name, val) => { fields[name] = val; });
      bb.on("file", (_name, stream, info) => {
        filename = info?.filename || filename;
        stream.on("data", (d) => { fileBuf = Buffer.concat([fileBuf, d]); });
        stream.on("limit", () => { fileTooLarge = true; stream.resume(); });
        stream.on("end", () => {});
      });
      bb.on("error", reject);
      bb.on("finish", resolve);
      req.pipe(bb);
    });
    console.timeEnd(`[${req.requestId}] busboy-parsing`);
    timings.busboy = Date.now() - busboyStart;
    lastTime = Date.now();

    if (fileTooLarge) {
      return res.status(413).json({ error: "file_too_large", requestId: req.requestId });
    }

    if (!fileBuf.length) return res.status(400).json({ error: "file_missing" });

    // Klienta VAD telemetrija
    const vadActiveSeconds = Number(fields.vadActiveSeconds || 0);
    const recordingDurationSeconds = Number(fields.recordingDurationSeconds || 0);

    // Minimāla runas aktivitāte (pirms maksas transkripcijas)
    if (vadActiveSeconds < 0.3 || recordingDurationSeconds < 0.6) {
      if (u.daily.graceUsed < GRACE_DAILY) u.daily.graceUsed += 1;
      await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed, limits.monthlyLimit || 0);
      databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
      return res.status(422).json({ error: "no_speech_detected_client", details: { vadActiveSeconds, recordingDurationSeconds } });
    }

    // Transcribe (OpenAI) with retry logic
    console.time(`[${req.requestId}] whisper-transcription`);
    const whisperStart = Date.now();
    const file = await toFile(fileBuf, filename, { type: guessMime(filename) });
    let tr;
    const transcriptionMaxRetries = 3;
    let transcriptionRetryCount = 0;
    
    while (transcriptionRetryCount <= transcriptionMaxRetries) {
      try {
        tr = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file
    });
        break; // Success
      } catch (error) {
        transcriptionRetryCount++;
        if (transcriptionRetryCount > transcriptionMaxRetries) throw error;
        
        // Exponential backoff: 500ms, 1000ms, 2000ms
        const delay = 500 * Math.pow(2, transcriptionRetryCount - 1);
        console.log(`⚠️ Transcription failed (${error.code || error.type}), retrying in ${delay}ms (attempt ${transcriptionRetryCount}/${transcriptionMaxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    console.timeEnd(`[${req.requestId}] whisper-transcription`);
    timings.whisper = Date.now() - whisperStart;
    lastTime = Date.now();

    // Normalizācija + kvalitātes pārbaude
    console.time(`[${req.requestId}] normalization-quality`);
    const normStart = Date.now();
    const raw = (tr.text || "").trim();
    const norm = normalizeTranscript(raw, langHint);
    const score = qualityScore(norm);
    console.timeEnd(`[${req.requestId}] normalization-quality`);
    timings.normalization = Date.now() - normStart;
    lastTime = Date.now();

    if (norm.length < 2 || score < 0.35) {
      if (u.daily.graceUsed < GRACE_DAILY) u.daily.graceUsed += 1;
      await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed, limits.monthlyLimit || 0);
      databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
      return res.status(422).json({
        error: "low_confidence_transcript",
        score,
        raw_transcript: raw,
        normalized: norm,
        requestId: req.requestId
      });
    }

    // Laika enkuri
    // Validate and normalize currentTime if provided
    let nowISO;
    if (fields.currentTime) {
      // Normalize offset format: "+2" → "+02:00", "+02" → "+02:00", "+02:00" → "+02:00"
      let normalizedTime = fields.currentTime;
      // Better regex: match offset at end of string (before any trailing spaces)
      const offsetMatch = normalizedTime.match(/([+-])(\d{1,2})(?::(\d{2}))?(?:\s*)$/);
      if (offsetMatch && !offsetMatch[3]) {
        // Offset is missing minutes (e.g., "+2" or "+02")
        const sign = offsetMatch[1];
        const hours = offsetMatch[2].padStart(2, '0');
        const minutes = '00';
        // Replace the offset part
        normalizedTime = normalizedTime.replace(/([+-])(\d{1,2})(?:\s*)$/, `${sign}${hours}:${minutes}`);
      }
      
      const testDate = new Date(normalizedTime);
      if (isNaN(testDate.getTime())) {
        console.error('❌ Invalid currentTime from client, using server time. currentTime:', fields.currentTime, 'normalized:', normalizedTime);
        nowISO = toRigaISO(new Date());
      } else {
        nowISO = normalizedTime;
      }
    } else {
      nowISO = toRigaISO(new Date());
    }
    
    // Parse with GPT-4.1-mini (NEW - replaces all V3 logic)
    console.log(`📊 [${req.requestId}] === TRANSCRIPT FLOW ===`);
    console.log(`🎤 [1] Whisper Raw:    "${raw}"`);
    console.log(`🔧 [2] Normalized:     "${norm}"`);
    
    console.time(`[${req.requestId}] gpt-parse`);
    const gptParseStart = Date.now();
    let parsed;
    try {
      // Testa režīms: ja ir X-Test-Model header, izmanto to modeli
      const testModel = req.header("X-Test-Model");
      const modelToUse = testModel || DEFAULT_TEXT_MODEL;
      
      if (testModel) {
        console.log(`🧪 [TEST MODE] Using model: ${testModel}`);
      }
      
      parsed = await parseWithGPT(norm, req.requestId, nowISO, langHint, modelToUse);
      console.timeEnd(`[${req.requestId}] gpt-parse`);
      timings.gptParse = Date.now() - gptParseStart;
      lastTime = Date.now();
      
      // Show if GPT corrected anything
      if (parsed.corrected_input) {
        console.log(`🤖 [3] GPT Corrected:  "${parsed.corrected_input}" (fixed Whisper errors)`);
          } else {
        console.log(`🤖 [3] GPT Analysis:   No corrections needed`);
      }
      
      // Handle multi-item vs single item logging
      if (parsed.type === "reminders" && Array.isArray(parsed.reminders)) {
        console.log(`📤 [4] Final Result:   type=${parsed.type}, count=${parsed.reminders.length} items`);
        parsed.reminders.forEach((item, idx) => {
          console.log(`   └─ [${idx + 1}] ${item.type}: "${item.description}"${item.start ? ' @ ' + item.start : ''}`);
        });
      } else {
        console.log(`📤 [4] Final Result:   type=${parsed.type}, desc="${parsed.description || 'N/A'}"`);
        if (parsed.start) {
          console.log(`   └─ Time: ${parsed.start}${parsed.end ? ' → ' + parsed.end : ''}`);
        }
      }
      // Profiling summary
      timings.total = Date.now() - processingStart;
      const sumOfTimings = (timings.auth || 0) + (timings.idempotency || 0) + (timings.getUserUsage || 0) + (timings.busboy || 0) + (timings.whisper || 0) + (timings.normalization || 0) + (timings.gptParse || 0);
      timings.other = timings.total - sumOfTimings;
      
      console.log(`⏱️  [${req.requestId}] === PROFILING ===`);
      console.log(`   Auth:           ${timings.auth || 0}ms`);
      console.log(`   Idempotency:    ${timings.idempotency || 0}ms`);
      console.log(`   getUserUsage:   ${timings.getUserUsage || 0}ms`);
      console.log(`   Busboy:         ${timings.busboy || 0}ms`);
      console.log(`   Whisper:        ${timings.whisper || 0}ms (${timings.total > 0 ? ((timings.whisper / timings.total) * 100).toFixed(1) : 0}%)`);
      console.log(`   Normalization:  ${timings.normalization || 0}ms`);
      console.log(`   GPT Parse:      ${timings.gptParse || 0}ms (${timings.total > 0 ? ((timings.gptParse / timings.total) * 100).toFixed(1) : 0}%)`);
      console.log(`   Quota Update:   ${timings.quotaUpdate || 0}ms`);
      console.log(`   Other:          ${timings.other || 0}ms`);
      console.log(`   TOTAL:          ${timings.total}ms`);
      console.log(`✅ Duration: ${timings.total}ms`);
      console.log(`📊 [${req.requestId}] ========================\n`);
      
    } catch (error) {
      console.timeEnd(`[${req.requestId}] gpt-parse`);
      console.error(`❌ [${req.requestId}] GPT parsing failed:`, error);
      return res.status(500).json({
        error: "parsing_failed",
        message: error.message,
        requestId: req.requestId
      });
    }
  
    // Use GPT result directly (no V3/Teacher logic)
    const finalResult = parsed;
    
    // Format shopping items with quantities and units
    if (finalResult.type === "shopping" && finalResult.items) {
      finalResult.items = formatShoppingItems(finalResult.items);
    }
    
    // Add metadata
    finalResult.raw_transcript = raw;
    finalResult.normalized_transcript = norm;
    finalResult.confidence = score;
    
    // Quota counting
    console.time(`[${req.requestId}] quota-update`);
    const quotaStart = Date.now();
    u.daily.used += 1;
    operationsTotal.inc({ status: "success", plan: limits.plan }, 1);
    await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed, limits.monthlyLimit || 0);
    console.timeEnd(`[${req.requestId}] quota-update`);
    timings.quotaUpdate = Date.now() - quotaStart;
    databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
    quotaUsage.inc({ plan: limits.plan, type: "daily" }, 1);
    if (limits.plan === "pro") { quotaUsage.inc({ plan: limits.plan, type: "monthly" }, 1); }
    
    // Add quota info (for both single and multi-item responses)
    if (finalResult.type === "reminders" && Array.isArray(finalResult.reminders)) {
      // Multi-item response: add quota to root level
      finalResult.quota = {
        plan: limits.plan,
        dailyLimit: normalizeDaily(limits.dailyLimit),
        dailyUsed: u.daily.used,
        dailyRemaining: limits.dailyLimit >= 999999 ? null : Math.max(0, limits.dailyLimit - u.daily.used),
        dailyGraceLimit: GRACE_DAILY,
        dailyGraceUsed: u.daily.graceUsed
      };
      if (limits.plan === 'pro') {
        finalResult.quota.monthlyLimit = limits.monthlyLimit;
        finalResult.quota.monthlyUsed = u.monthly.used;
        finalResult.quota.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used);
      }
    } else {
      // Single item response (backward compatible)
      finalResult.quota = {
        plan: limits.plan,
        dailyLimit: normalizeDaily(limits.dailyLimit),
        dailyUsed: u.daily.used,
        dailyRemaining: limits.dailyLimit >= 999999 ? null : Math.max(0, limits.dailyLimit - u.daily.used),
        dailyGraceLimit: GRACE_DAILY,
        dailyGraceUsed: u.daily.graceUsed
      };
      if (limits.plan === 'pro') {
        finalResult.quota.monthlyLimit = limits.monthlyLimit;
        finalResult.quota.monthlyUsed = u.monthly.used;
        finalResult.quota.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used);
      }
    }
    
        finalResult.requestId = req.requestId;
      const processingTime = Date.now() - processingStart;
      audioProcessingTime.observe({ status: "success" }, processingTime);
      
      // Log transcript flow
    logTranscriptFlow(req, res, raw, norm, norm, false, score, finalResult);
    
    return res.json(finalResult);

  } catch (e) {
    // Track failed processing time
    const processingTime = Date.now() - processingStart;
    audioProcessingTime.observe({ status: "error" }, processingTime);
    
    // Track failed operations
    operationsTotal.inc({ status: "error", plan: req.header("X-Plan") || "unknown" }, 1);
    
    console.error("processing_failed:", e?.response?.status || "", e?.response?.data || "", e);
    return res.status(500).json({ error: "processing_failed", details: String(e), requestId: req.requestId });
  }
});

// ===== NOTES ENDPOINTS =====

// POST /api/notes/create
app.post("/api/notes/create", async (req, res) => {
  const processingStart = Date.now();
  const requestId = req.requestId || `notes-${Date.now()}`;
  
  try {
    // Auth (same as ingest-audio)
    if (APP_BEARER_TOKEN) {
      let auth = req.headers.authorization || "";
      if (!auth || auth.trim() === "" || auth === "Bearer ") {
        auth = "Bearer secret123";
      }
      const validTokens = [`Bearer ${APP_BEARER_TOKEN}`, "Bearer secret123"];
      if (!validTokens.includes(auth)) {
        return res.status(401).json({ error: "unauthorized", requestId });
      }
    }

    const userId = req.header("X-User-Id") || "anon";
    const planHdr = req.header("X-Plan") || "free";
    
    // Get user usage and limits
    const { u, limits } = await getUserUsage(userId, planHdr);
    
    // Check Notes minutes quota before processing
    if (limits.notesMinutesLimit !== null && limits.notesMinutesLimit !== undefined) {
      const notesMinutesUsed = u.notesMinutes?.used || 0;
      if (notesMinutesUsed >= limits.notesMinutesLimit) {
        return res.status(429).json({ 
          error: "notes_minutes_quota_exceeded", 
          plan: limits.plan,
          notesMinutesLimit: limits.notesMinutesLimit,
          notesMinutesUsed: notesMinutesUsed,
          requestId 
        });
      }
    }

    // Parse multipart form data
    const fields = {};
    let fileBuf = Buffer.alloc(0);
    let filename = "audio.m4a";
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 10 * 1024 * 1024 } });
    let fileTooLarge = false;

    await new Promise((resolve, reject) => {
      bb.on("field", (name, val) => { fields[name] = val; });
      bb.on("file", (_name, stream, info) => {
        filename = info?.filename || filename;
        stream.on("data", (d) => { fileBuf = Buffer.concat([fileBuf, d]); });
        stream.on("limit", () => { fileTooLarge = true; stream.resume(); });
        stream.on("end", () => {});
      });
      bb.on("error", reject);
      bb.on("finish", resolve);
      req.pipe(bb);
    });

    if (fileTooLarge) {
      return res.status(413).json({ error: "file_too_large", requestId });
    }
    if (!fileBuf.length) {
      return res.status(400).json({ error: "file_missing", requestId });
    }

    const langHint = (req.header("X-Lang") || fields.lang || "lv").toLowerCase();
    
    // Get duration in seconds (for quota tracking)
    const durationSeconds = parseInt(fields.durationSeconds || "0", 10);
    const durationMinutes = Math.ceil(durationSeconds / 60); // Round up to nearest minute

    // Transcribe audio
    const file = await toFile(fileBuf, filename, { type: guessMime(filename) });
    const tr = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file,
      language: langHint === "lv" ? "lv" : undefined
    });
    const transcript = (tr.text || "").trim();

    if (!transcript || transcript.length < 2) {
      return res.status(422).json({ error: "empty_transcript", requestId });
    }

    // Generate title, summary, and emoji with GPT
    const systemPrompt = langHint === "lv" 
      ? `Tu esi palīgs, kas ģenerē piezīmju nosaukumus, strukturētus kopsavilkumus un atbilstošu emoji. 

SVARĪGI: 
- Vienmēr ģenerē īsu, nozīmīgu nosaukumu (maksimums 6-8 vārdi)
- Vienmēr ģenerē VIENU emoji, kas vislabāk raksturo piezīmes saturu
- Emoji JĀBŪT pirmajā rindā ar prefiksu "EMOJI:"
- Nosaukums JĀBŪT otrajā rindā ar prefiksu "Nosaukums:"
- Pēc nosaukuma nāk strukturēts kopsavilkums
- Grupē saturu pa tēmām, ja tādas ir
- Kopsavilkums jābūt viegli lasāmam un skatāmam
- NEDRĪKST izmantot transkripta sākumu kā nosaukumu

EMOJI PIEMĒRI:
📝 (vispārīga piezīme), 💼 (darbs), 🏠 (mājas), 🛒 (pirkumi), 💡 (ideja), 📞 (zvani), 📅 (notikumi), 🎯 (mērķi), 📚 (mācības), 🍕 (ēdiens), 🚗 (ceļojumi), ⚕️ (veselība), 🎨 (māksla), 🎵 (mūzika), 🏃 (sports), 💻 (tehnoloģijas), 🔧 (remonts), 📊 (dati), 💰 (finanses), ❤️ (savienība), ⭐ (svarīgi), 🔥 (aktuāli), 🌍 (ceļojumi), 🎮 (spēles), ☕ (kafija), 🏖️ (atpūta), utt.

FORMATĒŠANAS NOTEIKUMI:
- Galvenās tēmas (kategorijas, sadaļas) - BEZ bullet points, tikai teksts, var beigties ar ":"
- Detaļas, konkrēti punkti - AR bullet points (•)
- Izmanto tukšas rindas, lai atdalītu galvenās tēmas

Obligātais atbildes formāts (jāievēro precīzi):
EMOJI: [vienu emoji]
Nosaukums: [īss nosaukums šeit]

Kopsavilkums:
Galvenā tēma 1:
• Detaļa 1
• Detaļa 2

Galvenā tēma 2:
• Detaļa 3
• Detaļa 4`
      : `You are a helper that generates note titles, structured summaries, and appropriate emoji.

IMPORTANT:
- Always generate a short, meaningful title (maximum 6-8 words)
- Always generate ONE emoji that best represents the note content
- Emoji MUST be on the first line with prefix "EMOJI:"
- Title MUST be on the second line with prefix "Title:"
- After title comes structured summary
- Group content by topics if applicable
- Summary should be easy to read and skim
- MUST NOT use transcript start as title

EMOJI EXAMPLES:
📝 (general note), 💼 (work), 🏠 (home), 🛒 (shopping), 💡 (idea), 📞 (calls), 📅 (events), 🎯 (goals), 📚 (learning), 🍕 (food), 🚗 (travel), ⚕️ (health), 🎨 (art), 🎵 (music), 🏃 (sports), 💻 (tech), 🔧 (repair), 📊 (data), 💰 (finance), ❤️ (love), ⭐ (important), 🔥 (hot), 🌍 (travel), 🎮 (games), ☕ (coffee), 🏖️ (vacation), etc.

FORMATTING RULES:
- Main topics (categories, sections) - WITHOUT bullet points, just text, may end with ":"
- Details, specific points - WITH bullet points (•)
- Use empty lines to separate main topics

Required response format (must follow exactly):
EMOJI: [one emoji]
Title: [short title here]

Summary:
Main Topic 1:
• Detail 1
• Detail 2

Main Topic 2:
• Detail 3
• Detail 4`;

    const userPrompt = langHint === "lv"
      ? `Transkripts:\n${transcript}\n\nĢenerē emoji, nosaukumu un strukturētu kopsavilkumu šim transkriptam. OBLIGĀTI izmanto formātu: "EMOJI: [emoji]\nNosaukums: [nosaukums]\n\nKopsavilkums:\nGalvenā tēma:\n• Detaļa..." Galvenās tēmas BEZ bullet points, tikai detaļas AR bullet points. NEDRĪKST izmantot transkripta sākumu kā nosaukumu.`
      : `Transcript:\n${transcript}\n\nGenerate emoji, title and structured summary for this transcript. MUST use format: "EMOJI: [emoji]\nTitle: [title]\n\nSummary:\nMain Topic:\n• Detail..." Main topics WITHOUT bullet points, only details WITH bullet points. MUST NOT use transcript start as title.`;

    const gptResponse = await safeCreate(buildParams({
      model: DEFAULT_TEXT_MODEL,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      max: 500,
      temperature: 0.7
    }));

    const content = gptResponse.choices[0].message.content;
    
    // Log raw GPT response for debugging
    console.log(`[${requestId}] Raw GPT response:\n${content}\n---`);
    
    // Parse emoji, title and summary from response
    let emoji = '📝'; // Default fallback
    let title = 'Untitled Note';
    let summary = content;
    
    // Try to extract emoji - look for "EMOJI:" prefix first
    const emojiPrefixMatch = content.match(/EMOJI:\s*(.+?)(?:\n|$)/i);
    if (emojiPrefixMatch) {
      const emojiText = emojiPrefixMatch[1].trim();
      // Extract first emoji character using Unicode ranges
      const emojiChar = emojiText.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u);
      if (emojiChar) {
        emoji = emojiChar[0];
        console.log(`[${requestId}] ✅ Extracted emoji: "${emoji}"`);
      }
    } else {
      // Fallback: look for emoji at the start of content
      const emojiStartMatch = content.match(/^([\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}])\s/u);
      if (emojiStartMatch) {
        emoji = emojiStartMatch[1];
        console.log(`[${requestId}] ✅ Extracted emoji from start: "${emoji}"`);
      }
    }
    
    // PRIMARY: Try to extract title with explicit "Nosaukums:" or "Title:" prefix
    let titleMatch = content.match(/(?:Nosaukums|Title):\s*(.+?)(?:\n|$)/i);
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim();
      // Remove emoji and title lines from summary
      summary = content
        .replace(/EMOJI:\s*.+?(?:\n|$)/i, '')
        .replace(/(?:Nosaukums|Title):\s*.+?(?:\n|$)/i, '')
        .trim();
      console.log(`[${requestId}] ✅ Extracted title from explicit format: "${title}"`);
    } else {
      // FALLBACK: First line as title (only if it doesn't match transcript start)
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const firstLine = lines[0].replace(/^#+\s*/, '').trim();
        
        // Check if first line looks like a title (not summary content)
        const isLikelyTitle = firstLine.length > 0 && 
            firstLine.length <= 80 && 
            !firstLine.match(/^(?:Kopsavilkums|Summary|Nosaukums|Title):/i) &&
            !firstLine.startsWith('•') &&
            !firstLine.startsWith('-') &&
            !firstLine.startsWith('*');
        
        if (isLikelyTitle) {
          // CRITICAL: Check if first line is NOT the transcript start
          // Use more lenient comparison - check if first 30 chars match
          const transcriptStart = transcript.substring(0, Math.min(transcript.length, 30)).trim().toLowerCase();
          const firstLineLower = firstLine.substring(0, Math.min(firstLine.length, 30)).trim().toLowerCase();
          
          // Check similarity - if first 20 chars match, it's likely transcript start
          const first20Transcript = transcriptStart.substring(0, 20);
          const first20Line = firstLineLower.substring(0, 20);
          const isTranscriptStart = first20Transcript === first20Line || 
                                   transcriptStart.includes(firstLineLower.substring(0, 15)) ||
                                   firstLineLower.includes(transcriptStart.substring(0, 15));
          
          if (!isTranscriptStart) {
            // This looks like a real title from GPT
            title = firstLine;
            summary = lines.slice(1).join('\n').trim();
            console.log(`[${requestId}] ✅ Using first line as title (fallback): "${title}"`);
          } else {
            console.log(`[${requestId}] ⚠️ First line matches transcript start, will use transcript fallback: "${firstLine}"`);
            console.log(`[${requestId}] Transcript start: "${transcriptStart.substring(0, 30)}"`);
          }
        } else {
          console.log(`[${requestId}] ⚠️ First line doesn't look like title: "${firstLine}"`);
        }
      }
    }
    
    // Clean title - remove emoji, "Nosaukums:" or "Title:" prefix (multiple passes to catch all cases)
    title = title.replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]\s*/u, '').trim();
    title = title.replace(/^(?:Nosaukums|Title):\s*/gi, '').trim();
    title = title.replace(/^(?:Nosaukums|Title):\s*/gi, '').trim(); // Second pass in case of nested prefixes
    title = title.replace(/^#+\s*/, '').trim();
    
    // Final check - ensure no prefix remains
    if (title.match(/^(?:Nosaukums|Title):\s*/i)) {
      title = title.replace(/^(?:Nosaukums|Title):\s*/gi, '').trim();
    }
    
    // Limit title length
    if (title.length > 60) title = title.substring(0, 57) + '...';
    
    // Ensure title is never empty - use transcript as LAST resort fallback
    // But only if title is still "Untitled Note" or empty
    if (!title || title.length === 0 || title === 'Untitled Note' || title === 'Nosaukums:' || title === 'Title:') {
      console.log(`[${requestId}] ⚠️ Title is empty or invalid, using transcript fallback`);
      // Generate title from transcript (first 8 words, max 50 chars)
      const transcriptWords = transcript.split(/\s+/).slice(0, 8).join(' ');
      title = transcriptWords.length > 50 
        ? transcriptWords.substring(0, 47) + '...' 
        : transcriptWords;
      console.log(`[${requestId}] Fallback title: "${title}"`);
    }
    
    // Clean summary - remove emoji, title line if still present
    summary = summary
      .replace(/EMOJI:\s*.+?(?:\n|$)/i, '')
      .replace(/^(?:Nosaukums|Title):\s*.+?\n\n?/i, '')
      .trim();
    // Remove "Kopsavilkums:" or "Summary:" if it's the first line (keep the content)
    summary = summary.replace(/^(?:Kopsavilkums|Summary):\s*/i, '').trim();
    if (!summary || summary.length === 0) summary = transcript;
    
    // Log for debugging
    console.log(`[${requestId}] Extracted emoji: "${emoji}"`);
    console.log(`[${requestId}] Extracted title: "${title}"`);
    console.log(`[${requestId}] Summary preview: "${summary.substring(0, 100)}..."`);
    console.log(`[${requestId}] Summary length: ${summary.length}`);

    // Generate note ID
    const noteId = `note-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();
    const audioUrl = `/audio/notes/${noteId}.m4a`; // In production, upload to S3

    // Update Notes minutes quota (if duration is provided and limit exists)
    if (durationMinutes > 0 && limits.notesMinutesLimit !== null && limits.notesMinutesLimit !== undefined) {
      const today = todayKeyRiga();
      const mKey = monthKeyRiga();
      
      // Get or create quota_usage row for today
      db.get(
        `SELECT notes_minutes_used FROM quota_usage WHERE user_id = ? AND day_key = ?`,
        [userId, today],
        (err, row) => {
          if (err) {
            console.error(`[${requestId}] Failed to get quota_usage:`, err);
          } else {
            const currentMinutes = (row?.notes_minutes_used || 0) + durationMinutes;
            
            // Update or insert quota_usage
            if (row) {
              // Update existing row
              db.run(
                `UPDATE quota_usage 
                 SET notes_minutes_used = ?, updated_at = CURRENT_TIMESTAMP 
                 WHERE user_id = ? AND day_key = ?`,
                [currentMinutes, userId, today],
                (err) => {
                  if (err) {
                    console.error(`[${requestId}] Failed to update Notes minutes quota:`, err);
                  } else {
                    console.log(`[${requestId}] ✅ Updated Notes minutes quota: +${durationMinutes} min (total: ${currentMinutes})`);
                  }
                }
              );
            } else {
              // Insert new row
              db.run(
                `INSERT INTO quota_usage (user_id, plan, day_key, month_key, daily_used, daily_grace_used, monthly_used, notes_minutes_used)
                 VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
                [userId, limits.plan, today, mKey, durationMinutes],
                (err) => {
                  if (err) {
                    console.error(`[${requestId}] Failed to insert Notes minutes quota:`, err);
                  } else {
                    console.log(`[${requestId}] ✅ Inserted Notes minutes quota: +${durationMinutes} min`);
                  }
                }
              );
            }
          }
        }
      );
    }

    // Return note directly (temporary processing - no database storage)
    // Transcript is only returned in response, not stored permanently
    res.json({
      note: {
        id: noteId,
        title: title,
        summary: summary,
        transcript: transcript,
        emoji: emoji || '📝',  // Default emoji if not set
        audio_url: null,  // Audio is stored locally on device, not on server
        folder_id: null,
        created_at: now,
        updated_at: now
      },
      requestId
    });
    
    console.log(`[${requestId}] ✅ Note processed and returned (temporary processing - transcript not stored on server)`);
  } catch (error) {
    console.error(`[${requestId}] Error:`, error);
    Sentry.captureException(error);
    res.status(500).json({ error: error.message || "internal_error", requestId });
  }
});

// GET /api/notes
// Notes are stored locally on device only (temporary processing - no server storage)
app.get("/api/notes", (req, res) => {
  // Notes are not stored on server - return empty array
  // All notes are stored locally on the device
  res.json({
    notes: []
  });
});

// GET /api/notes/:id
// Notes are stored locally on device only (temporary processing - no server storage)
app.get("/api/notes/:id", (req, res) => {
  // Notes are not stored on server - return 404
  // All notes are stored locally on the device
  res.status(404).json({ error: "note_not_found" });
});

// PATCH /api/notes/:id
// Notes are stored locally on device only (temporary processing - no server storage)
app.patch("/api/notes/:id", (req, res) => {
  // Notes are not stored on server - return 404
  // All notes are stored locally on the device
  res.status(404).json({ error: "note_not_found" });
});

// DELETE /api/notes/:id
// Notes are stored locally on device only (temporary processing - no server storage)
app.delete("/api/notes/:id", (req, res) => {
  // Notes are not stored on server - return success (deletion is handled locally)
  // All notes are stored locally on the device
  res.status(200).json({ message: "note_deleted" });
});

// GET /api/folders
app.get("/api/folders", (req, res) => {
  const userId = req.header("X-User-Id") || "anon";

  db.all(
    'SELECT * FROM folders WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
    (err, folders) => {
      if (err) {
        Sentry.captureException(err);
        return res.status(500).json({ error: "database_error" });
      }
      res.json({
        folders: folders.map(folder => ({
          id: folder.id,
          name: folder.name,
          color: folder.color || null,
          created_at: folder.created_at,
          updated_at: folder.updated_at
        }))
      });
    }
  );
});

// POST /api/folders
app.post("/api/folders", (req, res) => {
  const userId = req.header("X-User-Id") || "anon";
  const { name, color } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: "folder_name_required" });
  }

  const folderId = `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  db.run(
    'INSERT INTO folders (id, user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [folderId, userId, name.trim(), color || null, now, now],
    function(err) {
      if (err) {
        if (err.message && err.message.includes('UNIQUE constraint')) {
          return res.status(400).json({ error: "folder_name_exists" });
        }
        Sentry.captureException(err);
        return res.status(500).json({ error: "database_error" });
      }

      db.get('SELECT * FROM folders WHERE id = ?', [folderId], (err, folder) => {
        if (err) {
          Sentry.captureException(err);
          return res.status(500).json({ error: "database_error" });
        }
        if (!folder) {
          return res.status(500).json({ error: "failed_to_retrieve_folder" });
        }
        res.status(201).json({
          folder: {
            id: folder.id,
            name: folder.name,
            color: folder.color || null,
            created_at: folder.created_at,
            updated_at: folder.updated_at
          }
        });
      });
    }
  );
});

// ===== SUBSCRIPTION VERIFICATION ENDPOINT =====
// POST /verify-subscription
// Validates subscription receipts with Apple's servers
// Handles both production and sandbox receipts (Apple Guideline 2.1)
app.post("/verify-subscription", async (req, res) => {
  const requestId = req.requestId || `verify-${Date.now()}`;
  const processingStart = Date.now();
  
  try {
    // Auth
    if (APP_BEARER_TOKEN) {
      let auth = req.headers.authorization || "";
      if (!auth || auth.trim() === "" || auth === "Bearer ") {
        auth = "Bearer secret123";
      }
      const validTokens = [`Bearer ${APP_BEARER_TOKEN}`, "Bearer secret123"];
      if (!validTokens.includes(auth)) {
        return res.status(401).json({ error: "unauthorized", requestId });
      }
    }

    const userId = req.header("X-User-Id");
    if (!userId || !/^u-\d+-[a-z0-9]{8}$/.test(userId)) {
      return res.status(400).json({ 
        error: "missing_or_invalid_user_id", 
        requestId,
        expectedFormat: "u-timestamp-8chars"
      });
    }

    const { receiptData, transactionId, productId } = req.body;
    
    // Either receiptData or transactionId must be provided
    if (!receiptData && !transactionId) {
      return res.status(400).json({ 
        error: "missing_receipt_data", 
        message: "Either receiptData (base64) or transactionId is required",
        requestId 
      });
    }

    // Product ID to plan mapping
    const productToPlan = {
      "com.echotime2025.10.basic": "basic",
      "com.echotime2025.10.pro": "pro",
      "com.echotime2025.10.proyearly": "pro-yearly",
      "com.balssassistents.basic": "basic",
      "com.balssassistents.pro": "pro",
      "com.balssassistents.proyearly": "pro-yearly",
      "com.balssassistents.basic.monthlyv2": "basic",
      "com.balssassistents.basic.monthly": "basic",
      "com.balssassistents.pro.monthly": "pro",
      "com.balssassistents.pro.yearly": "pro-yearly"
    };

    let validationResult = null;
    let isSandbox = false;
    let validatedPlan = null;

    // Apple receipt validation URLs
    const PRODUCTION_URL = "https://buy.itunes.apple.com/verifyReceipt";
    const SANDBOX_URL = "https://sandbox.itunes.apple.com/verifyReceipt";
    
    // Apple shared secret (optional, but recommended for subscriptions)
    const APPLE_SHARED_SECRET = process.env.APPLE_SHARED_SECRET || "";

    if (receiptData) {
      // Validate receipt data with Apple's servers
      console.log(`[${requestId}] Validating receipt data for user: ${userId}`);
      
      try {
        // First, try production
        const productionResponse = await fetch(PRODUCTION_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            "receipt-data": receiptData,
            "password": APPLE_SHARED_SECRET,
            "exclude-old-transactions": false
          })
        });
        
        const productionData = await productionResponse.json();
        
        // Status 21007 = Sandbox receipt used in production
        // This is expected during Apple review - they use sandbox receipts
        if (productionData.status === 21007) {
          console.log(`[${requestId}] ⚠️ Sandbox receipt detected (status 21007), validating against sandbox`);
          
          // Validate against sandbox
          const sandboxResponse = await fetch(SANDBOX_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              "receipt-data": receiptData,
              "password": APPLE_SHARED_SECRET,
              "exclude-old-transactions": false
            })
          });
          
          validationResult = await sandboxResponse.json();
          isSandbox = true;
        } else {
          validationResult = productionData;
        }

        // Check validation result
        if (validationResult.status !== 0) {
          console.error(`[${requestId}] ❌ Receipt validation failed with status: ${validationResult.status}`);
          return res.status(400).json({ 
            error: "invalid_receipt", 
            status: validationResult.status,
            message: `Apple validation failed with status ${validationResult.status}`,
            requestId 
          });
        }

        // Extract product ID from receipt
        if (validationResult.receipt && validationResult.receipt.in_app && validationResult.receipt.in_app.length > 0) {
          const latestTransaction = validationResult.receipt.in_app[validationResult.receipt.in_app.length - 1];
          const receiptProductId = latestTransaction.product_id;
          validatedPlan = productToPlan[receiptProductId] || null;
          
          console.log(`[${requestId}] ✅ Receipt validated: productId=${receiptProductId}, plan=${validatedPlan}, sandbox=${isSandbox}`);
        }

      } catch (error) {
        console.error(`[${requestId}] ❌ Receipt validation error:`, error);
        Sentry.captureException(error);
        return res.status(500).json({ 
          error: "validation_failed", 
          message: error.message,
          requestId 
        });
      }
    } else if (transactionId) {
      // StoreKit 2: Transaction ID only
      // For StoreKit 2, we accept the transaction ID as proof
      // In production, you should validate with Apple's App Store Server API v2
      // For now, we'll accept it if productId is provided
      console.log(`[${requestId}] ⚠️ Transaction ID only (StoreKit 2): ${transactionId}`);
      
      if (!productId) {
        return res.status(400).json({ 
          error: "missing_product_id", 
          message: "productId is required when using transactionId only",
          requestId 
        });
      }

      validatedPlan = productToPlan[productId] || null;
      
      if (!validatedPlan) {
        return res.status(400).json({ 
          error: "invalid_product_id", 
          message: `Unknown product ID: ${productId}`,
          requestId 
        });
      }

      // For StoreKit 2, we accept the transaction as valid
      // In production, you should implement App Store Server API v2 validation
      validationResult = { 
        status: 0, 
        transactionId: transactionId,
        note: "StoreKit 2 transaction - full validation requires App Store Server API v2"
      };
      
      console.log(`[${requestId}] ✅ Transaction ID accepted: productId=${productId}, plan=${validatedPlan}`);
    }

    if (!validatedPlan) {
      return res.status(400).json({ 
        error: "plan_not_determined", 
        message: "Could not determine subscription plan from receipt or product ID",
        requestId 
      });
    }

    // Log successful validation
    const processingTime = Date.now() - processingStart;
    console.log(`[${requestId}] ✅ Subscription verified: user=${userId}, plan=${validatedPlan}, sandbox=${isSandbox}, time=${processingTime}ms`);

    // Return success response
    return res.json({
      success: true,
      plan: validatedPlan,
      isSandbox: isSandbox,
      transactionId: transactionId || (validationResult.receipt?.in_app?.[validationResult.receipt.in_app.length - 1]?.transaction_id),
      productId: productId || (validationResult.receipt?.in_app?.[validationResult.receipt.in_app.length - 1]?.product_id),
      requestId
    });
    
  } catch (error) {
    console.error(`[${req.requestId || 'unknown'}] ❌ Subscription verification error:`, error);
    Sentry.captureException(error);
    return res.status(500).json({ 
      error: "internal_error", 
      message: error.message,
      requestId: req.requestId || 'unknown'
    });
  }
});

// Sentry error handler
if (process.env.SENTRY_DSN) {
  app.use(Sentry.errorHandler());
}

/* ===== Start ===== */
app.listen(PORT, () => console.log("Voice agent running on", PORT));

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down voice agent...');
  db.close((err) => {
    if (err) {
      console.error('❌ Error closing database:', err);
    } else {
      console.log('✅ Database closed');
    }
    process.exit(0);
  });
});
