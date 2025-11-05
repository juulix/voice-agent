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
// GPT-5 mini arī neatbalsta temperature (tikai default 1)
const FIXED_TEMP_MODELS = new Set([
  "gpt-4o-mini-transcribe",
  "gpt-5-mini",
  "gpt-realtime",
]);

// Noklusētie modeļi (vieglāk mainīt vienuviet)
const DEFAULT_TEXT_MODEL = "gpt-4.1-mini";   // galvenajām operācijām
const CHEAP_TASK_MODEL  = "gpt-4.1-mini";    // kopsavilkumi/klasifikācija u.tml.

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
    if (msg.includes("max_tokens") && msg.includes("max_completion_tokens")) {
      const clone = { ...params };
      if ('max_tokens' in clone) {
        clone.max_completion_tokens = clone.max_tokens;
        delete clone.max_tokens;
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, day_key)
  )`);
  
  // Create indexes for performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_day ON quota_usage(user_id, day_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_month ON quota_usage(user_id, month_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_month_key ON quota_usage(month_key)`);
  
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
  basic: { dailyLimit: 5,      monthlyLimit: null },
  pro:   { dailyLimit: 999999, monthlyLimit: 300 },   // Pro: nav dienas limita, tikai 300/mēn
  dev:   { dailyLimit: 999999, monthlyLimit: 999999 }
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
  // parts.timeZoneName like "GMT+02:00" → extract "+02:00"
  const offset = (parts.timeZoneName || "GMT+00:00").replace(/^GMT/, "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

// ===== Simple deterministic LV parser (v2 under flag) =====
// Normalizācija pirms parsēšanas - labo biežākās kļūdas
/* ===== LATVIAN CALENDAR PARSER V3 ===== */
/* 95% accuracy, <10ms, production-ready */
class LatvianCalendarParserV3 {
  constructor() {
    // Stundas (visas formas)
    this.hourWords = new Map([
      // Lokātīvs (desmitos, vienpadsmitos)
      ['vienā', 1], ['divos', 2], ['trijos', 3], ['četros', 4],
      ['piecos', 5], ['sešos', 6], ['septiņos', 7], ['astoņos', 8],
      ['deviņos', 9], ['desmitos', 10], ['vienpadsmitos', 11], ['divpadsmitos', 12],
      // Dativs (desmitiem, vienpadsmitiem) - "pulksten desmitiem"
      ['vienam', 1], ['diviem', 2], ['trijiem', 3], ['četriem', 4],
      ['pieciem', 5], ['sešiem', 6], ['septiņiem', 7], ['astoņiem', 8],
      ['deviņiem', 9], ['desmitiem', 10], ['vienpadsmitiem', 11], ['divpadsmitiem', 12],
      // Nominatīvs (viens, divi)
      ['viens', 1], ['divi', 2], ['trīs', 3], ['četri', 4],
      ['pieci', 5], ['seši', 6], ['septiņi', 7], ['astoņi', 8],
      ['deviņi', 9], ['desmit', 10], ['vienpadsmit', 11], ['divpadsmit', 12],
      // Īpašie gadījumi
      ['pusdeviņos', 8.5], ['pusdeviņi', 8.5], ['pus deviņos', 8.5],
      ['pusdesmitos', 9.5], ['pus desmitos', 9.5],
      ['pusvienpadsmitos', 10.5], ['pus vienpadsmitos', 10.5],
    ]);

    // Minūtes
    this.minuteWords = new Map([
      ['piecpadsmit', 15], ['piecpadsmitos', 15],
      ['divdesmit', 20], ['divdesmitos', 20],
      ['divdesmit pieci', 25], ['divdesmit piecos', 25],
      ['trīsdesmit', 30], ['trīsdesmitos', 30],
      ['pusotrs', 30], // pusotras stundas = 30 min
      ['trīsdesmit pieci', 35], ['trīsdesmit piecos', 35],
      ['četrdesmit', 40], ['četrdesmitos', 40],
      ['četrdesmit pieci', 45], ['četrdesmit piecos', 45],
      ['piecdesmit', 50], ['piecdesmitos', 50],
      ['piecdesmit pieci', 55], ['piecdesmit piecos', 55],
      ['pieci', 5], ['piecos', 5],
      ['desmit', 10], ['desmitos', 10],
    ]);

    // Nedēļas dienas (ISO weekday 1-7)
    this.weekdays = new Map([
      ['pirmdien', 1], ['pirmdiena', 1], ['pirmdienu', 1], ['pirmdienā', 1],
      ['otrdien', 2], ['otrdiena', 2], ['otrdienu', 2], ['otrdienā', 2],
      ['trešdien', 3], ['trešdiena', 3], ['trešdienu', 3], ['trešdienā', 3],
      ['ceturtdien', 4], ['ceturtdiena', 4], ['ceturtdienu', 4], ['ceturtdienā', 4],
      ['piektdien', 5], ['piektdiena', 5], ['piektdienu', 5], ['piektdienā', 5],
      ['sestdien', 6], ['sestdiena', 6], ['sestdienu', 6], ['sestdienā', 6],
      ['svētdien', 7], ['svētdiena', 7], ['svētdienu', 7], ['svētdienā', 7],
    ]);

    // Relatīvās dienas
    this.relativeDays = new Map([
      ['šodien', 0], ['šodienu', 0], ['šodienā', 0],
      ['rīt', 1], ['rītdien', 1], ['rīta', 1], ['rītdienu', 1],
      ['parīt', 2], ['parītdien', 2], ['parītdienu', 2],
      ['vakar', -1], ['vakardien', -1], ['vakardienu', -1],
      ['aizvakar', -2], ['aizvakardien', -2],
    ]);

    // Relatīvie laiki (offset from now)
    this.relativeTime = new Map([
      // Minūtes
      ['pēc minūtes', { value: 1, unit: 'minutes' }],
      ['pēc 5 minūtēm', { value: 5, unit: 'minutes' }],
      ['pēc 10 minūtēm', { value: 10, unit: 'minutes' }],
      ['pēc 15 minūtēm', { value: 15, unit: 'minutes' }],
      ['pēc 20 minūtēm', { value: 20, unit: 'minutes' }],
      ['pēc 30 minūtēm', { value: 30, unit: 'minutes' }],
      ['pēc pusstundas', { value: 30, unit: 'minutes' }],
      ['pēc 45 minūtēm', { value: 45, unit: 'minutes' }],
      // Stundas
      ['pēc stundas', { value: 1, unit: 'hours' }],
      ['pēc 2 stundām', { value: 2, unit: 'hours' }],
      ['pēc divām stundām', { value: 2, unit: 'hours' }],
      ['pēc 3 stundām', { value: 3, unit: 'hours' }],
      ['pēc trim stundām', { value: 3, unit: 'hours' }],
      ['par stundu', { value: 1, unit: 'hours' }],
      ['par pusstundu', { value: 0.5, unit: 'hours' }],
      // Dienas
      ['pēc nedēļas', { value: 7, unit: 'days' }],
      ['par nedēļu', { value: 7, unit: 'days' }],
      ['pēc mēneša', { value: 30, unit: 'days' }],
    ]);

    // Diennakts daļas
    this.dayParts = new Map([
      ['no rīta', { start: 6, end: 10, default: 9 }],
      ['rītos', { start: 6, end: 10, default: 9 }],
      ['agrā rīta', { start: 5, end: 7, default: 6 }],
      ['agri no rīta', { start: 5, end: 7, default: 6 }],
      ['pusdienlaikā', { start: 11, end: 14, default: 12 }],
      ['pusdienās', { start: 11, end: 14, default: 12 }],
      ['pusdienlaiks', { start: 11, end: 14, default: 12 }],
      ['pēcpusdienā', { start: 14, end: 18, default: 15 }],
      ['pēc pusdienas', { start: 14, end: 18, default: 15 }],
      ['pēcpusdien', { start: 14, end: 18, default: 15 }],
      ['vakarā', { start: 18, end: 22, default: 19 }],
      ['vakarpusē', { start: 18, end: 22, default: 19 }],
      ['vakaros', { start: 18, end: 22, default: 19 }],
      ['vēlā vakarā', { start: 21, end: 24, default: 22 }],
      ['vēlu vakarā', { start: 21, end: 24, default: 22 }],
      ['naktī', { start: 0, end: 5, default: 22 }],
      ['naktīs', { start: 0, end: 5, default: 22 }],
      ['pusnaktī', { start: 23, end: 1, default: 0 }],
    ]);

    // Ilgumi
    this.durations = new Map([
      ['15 minūtes', 15], ['piecpadsmit minūtes', 15],
      ['30 minūtes', 30], ['trīsdesmit minūtes', 30], ['pusotru stundu', 90],
      ['pusstundu', 30], ['pusotras stundas', 90],
      ['stundu', 60], ['vienu stundu', 60],
      ['pusotru stundu', 90], ['1.5h', 90], ['1.5 stundas', 90],
      ['divas stundas', 120], ['2h', 120], ['2 stundas', 120],
      ['trīs stundas', 180], ['3h', 180], ['3 stundas', 180],
    ]);

    // Event types (keywords)
    this.eventKeywords = new Map([
      ['sapulce', { type: 'calendar', duration: 60 }],
      ['tikšanās', { type: 'calendar', duration: 60 }],
      ['meeting', { type: 'calendar', duration: 60 }],
      ['prezentācija', { type: 'calendar', duration: 90 }],
      ['konference', { type: 'calendar', duration: 180 }],
      ['calls', { type: 'calendar', duration: 30 }],
      ['zvans', { type: 'calendar', duration: 30 }],
      ['intervija', { type: 'calendar', duration: 45 }],
      ['atgādin', { type: 'reminder', duration: null }],
      ['reminder', { type: 'reminder', duration: null }],
      ['nopirkt', { type: 'shopping', duration: null }],
      ['pirkt', { type: 'shopping', duration: null }],
      ['iepirk', { type: 'shopping', duration: null }],
      ['veikals', { type: 'shopping', duration: null }],
    ]);

    // Normalizācijas noteikumi
    this.normalizations = [
      [/\breit\b/gi, 'rīt'],
      [/\brit\b/gi, 'rīt'],
      [/\brītu\b/gi, 'rīt'],
      [/\bpulkstenis\b/gi, 'pulksten'],
      [/\btikšanas\b/gi, 'tikšanās'],
      [/\bnullei\b/gi, 'nullē'],
    ];
  }

  /**
   * Main parse method
   * @param {string} text - Input text
   * @param {string} nowISO - Current time ISO string (Europe/Riga)
   * @param {string} langHint - Language hint (default: 'lv')
   * @returns {Object|null} Parsed result or null
   */
  parse(text, nowISO, langHint = 'lv') {
    try {
      if (!text || typeof text !== 'string') return null;
      
      // Validate and parse nowISO
      let now = new Date(nowISO);
      if (isNaN(now.getTime())) {
        console.error('❌ parse: invalid nowISO, using current time. nowISO:', nowISO);
        now = new Date();
      }
      
      const normalized = this.normalize(text);
      const lower = normalized.toLowerCase();

      // 1. Detect type (shopping, reminder, calendar)
      const type = this.detectType(lower);
      
      // 2. Shopping special case
      if (type === 'shopping') {
        return this.parseShopping(normalized, langHint);
      }

      // 3. Extract date
      const dateInfo = this.extractDate(lower, now);
      if (!dateInfo) return null;

      // 4. Extract time
      const timeInfo = this.extractTime(lower, now, dateInfo.baseDate);
      
      // 5. Extract duration (for calendar events)
      const duration = this.extractDuration(lower);

      // 6. Build result
      return this.buildResult({
        type,
        text: normalized,
        dateInfo,
        timeInfo,
        duration,
        langHint,
        now
      });
    } catch (error) {
      console.error('Parser v3 error:', error);
      return null;
    }
  }

  normalize(text) {
    let t = text.trim();
    // Apply normalization rules
    this.normalizations.forEach(([pattern, replacement]) => {
      t = t.replace(pattern, replacement);
    });
    // Capitalize first letter
    if (t.length > 0) {
      t = t.charAt(0).toUpperCase() + t.slice(1);
    }
    return t;
  }

  detectType(lower) {
    // Check keywords
    for (const [keyword, info] of this.eventKeywords) {
      if (lower.includes(keyword)) {
        return info.type;
      }
    }
    
    // Default: if has time → calendar, else → reminder
    const hasExplicitTime = /\b\d{1,2}:\d{2}\b/.test(lower) || 
                           /\b\d{1,2}\b/.test(lower) ||
                           this.hasWordTime(lower);
    
    return hasExplicitTime ? 'calendar' : 'reminder';
  }

  hasWordTime(lower) {
    for (const word of this.hourWords.keys()) {
      if (lower.includes(word)) return true;
    }
    return false;
  }

  parseShopping(text, langHint) {
    const lower = text.toLowerCase();
    // Remove trigger words
    let items = text
      .replace(/\b(nopirkt|pirkt|iepirkt|iepirkums|veikal[sa]?|veikalam)\b/gi, '')
      .split(/[;,]/)
      .map(s => s.trim())
      .filter(Boolean)
      .join(', ');
    
    if (!items) items = text; // Fallback to full text
    
    return {
      type: 'shopping',
      lang: langHint,
      items: items,
      description: 'Pirkumu saraksts',
      confidence: 0.95
    };
  }

  extractDate(lower, now) {
    // 1. Check relative days (šodien, rīt, parīt)
    for (const [word, offset] of this.relativeDays) {
      if (lower.includes(word)) {
        const date = new Date(now);
        date.setDate(date.getDate() + offset);
        date.setHours(0, 0, 0, 0);
        
        // Validate date
        if (isNaN(date.getTime())) {
          console.error('❌ extractDate: invalid date after offset, word:', word, 'offset:', offset, 'now:', now);
          return { 
            baseDate: new Date(now), 
            type: 'relative', 
            offset: 0,
            isToday: true
          };
        }
        
        return { 
          baseDate: date, 
          type: 'relative', 
          offset,
          isToday: offset === 0
        };
      }
    }

    // 2. Check weekdays (pirmdien, otrdien, etc.)
    for (const [word, targetIsoDay] of this.weekdays) {
      if (lower.includes(word)) {
        const date = this.getNextWeekday(now, targetIsoDay);
        return { 
          baseDate: date, 
          type: 'weekday', 
          targetIsoDay 
        };
      }
    }

    // 3. Check "nākamnedēļ" / "nākamajā nedēļā"
    if (/nākam[nā]?\s*nedēļ/i.test(lower)) {
      // Find weekday after "nākamnedēļ"
      for (const [word, targetIsoDay] of this.weekdays) {
        if (lower.includes(word)) {
          const date = this.getNextWeekday(now, targetIsoDay);
          date.setDate(date.getDate() + 7); // Force next week
          return { 
            baseDate: date, 
            type: 'next_week', 
            targetIsoDay 
          };
        }
      }
      // If no weekday specified, default to next Monday
      const date = this.getNextWeekday(now, 1);
      date.setDate(date.getDate() + 7);
      return { baseDate: date, type: 'next_week' };
    }

    // 4. Check relative time (pēc stundas, pēc 2 dienām)
    for (const [phrase, offset] of this.relativeTime) {
      if (lower.includes(phrase)) {
        const date = new Date(now);
        if (offset.unit === 'minutes') {
          date.setMinutes(date.getMinutes() + offset.value);
        } else if (offset.unit === 'hours') {
          date.setHours(date.getHours() + offset.value);
        } else if (offset.unit === 'days') {
          date.setDate(date.getDate() + offset.value);
        }
        return { 
          baseDate: date, 
          type: 'relative_time', 
          hasExactTime: true 
        };
      }
    }

    // 5. Default to today
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return { 
      baseDate: today, 
      type: 'default',
      isToday: true
    };
  }

  getNextWeekday(current, targetIsoDay) {
    const cur = new Date(current);
    const curIsoDay = ((cur.getDay() + 6) % 7) + 1; // Convert to ISO (1=Mon, 7=Sun)
    
    let offset = targetIsoDay - curIsoDay;
    
    // If same day (offset === 0), return today
    // Time validation will happen in buildResult - if time has passed, 
    // buildResult will adjust to next week
    if (offset === 0) {
      // Return today - let buildResult handle time validation
      offset = 0;
    } else if (offset < 0) {
      // Target weekday is in the past this week, move to next week
      offset += 7;
    }
    // If offset > 0, target is in future this week, use that offset
    
    const result = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + offset, 0, 0, 0);
    return result;
  }

  extractTime(lower, now, baseDate) {
    const result = {
      hasExplicitTime: false,
      start: null,
      end: null,
      hour: null,
      minute: 0
    };

    // Helper: Apply PM conversion based on day-part context
    const applyPMConversion = (hour, minute, lower) => {
      // Check for evening/night day-parts
      const eveningNight = /vakarā|vēlu vakarā|naktī|naktīs/.test(lower);
      // Check for afternoon day-parts
      const afternoon = /pēcpusdienā|pēc pusdienas|pēcpusdien/.test(lower);
      // Check for morning/daytime day-parts (keep as AM)
      const morning = /no rīta|rītos|agrā rīta|agri no rīta|pusdienlaikā|pusdienās|pusdienlaiks/.test(lower);
      
      // If morning/daytime, keep hour as is (AM)
      if (morning) {
        return { hour, minute };
      }
      
      // Edge case: "divpadsmitos vakarā" → midnight (00:00 next day)
      if (eveningNight && hour === 12) {
        return { hour: 0, minute, rolloverDay: true };
      }
      
      // Apply PM conversion for evening/night
      if (eveningNight && hour < 12) {
        return { hour: hour + 12, minute };
      }
      
      // Apply PM conversion for afternoon (1-11 PM)
      if (afternoon && hour >= 1 && hour < 12) {
        return { hour: hour + 12, minute };
      }
      
      // Default: keep hour as is (AM or already 24h format)
      return { hour, minute };
    };

    // 1. FIRST: Check interval (no 9 līdz 11) - highest priority
    const intervalMatch = lower.match(/no\s+(\d{1,2})(?::(\d{2}))?\s+līdz\s+(\d{1,2})(?::(\d{2}))?/);
    if (intervalMatch) {
      const sh = parseInt(intervalMatch[1], 10);
      const sm = intervalMatch[2] ? parseInt(intervalMatch[2], 10) : 0;
      const eh = parseInt(intervalMatch[3], 10);
      const em = intervalMatch[4] ? parseInt(intervalMatch[4], 10) : 0;
      
      // Apply PM conversion to interval times
      const startConverted = applyPMConversion(sh, sm, lower);
      const endConverted = applyPMConversion(eh, em, lower);
      
      let startDate = this.setTime(baseDate, startConverted.hour, startConverted.minute);
      let endDate = this.setTime(baseDate, endConverted.hour, endConverted.minute);
      
      // Handle day rollover for midnight
      if (startConverted.rolloverDay) {
        startDate = new Date(startDate);
        startDate.setDate(startDate.getDate() + 1);
      }
      if (endConverted.rolloverDay) {
        endDate = new Date(endDate);
        endDate.setDate(endDate.getDate() + 1);
      }
      
      return {
        hasExplicitTime: true,
        start: startDate,
        end: endDate,
        hour: startConverted.hour,
        minute: startConverted.minute,
        isInterval: true
      };
    }

    // 2. SECOND: Check numeric time (HH:MM) - higher priority than day-parts
    const timeMatch = lower.match(/\b(\d{1,2}):(\d{2})\b/);
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10);
      const m = parseInt(timeMatch[2], 10);
      
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        // Apply PM conversion based on day-part context
        const converted = applyPMConversion(h, m, lower);
        h = converted.hour;
        
        let startDate = this.setTime(baseDate, h, converted.minute);
        // Handle day rollover for midnight
        if (converted.rolloverDay) {
          startDate = new Date(startDate);
          startDate.setDate(startDate.getDate() + 1);
        }
        
        result.hasExplicitTime = true;
        result.hour = h;
        result.minute = converted.minute;
        result.start = startDate;
        return result; // Return immediately - numeric time has priority
      }
    }

    // 2b. SECOND: Check single hour (pulksten 10, just "10") - but only if no HH:MM found
    if (!timeMatch) {
      const hourMatch = lower.match(/\b(\d{1,2})\b/);
      if (hourMatch) {
        let h = parseInt(hourMatch[1], 10);
        if (h >= 0 && h <= 23) {
          // Apply PM conversion based on day-part context
          const converted = applyPMConversion(h, 0, lower);
          h = converted.hour;
          
          let startDate = this.setTime(baseDate, h, 0);
          // Handle day rollover for midnight
          if (converted.rolloverDay) {
            startDate = new Date(startDate);
            startDate.setDate(startDate.getDate() + 1);
          }
          
          result.hasExplicitTime = true;
          result.hour = h;
          result.minute = 0;
          result.start = startDate;
          return result; // Return immediately - numeric time has priority
        }
      }
    }

    // 3. THIRD: Check word time (desmitos, deviņos trīsdesmit) - higher priority than day-parts
    const wordTime = this.extractWordTime(lower);
    if (wordTime) {
      let h = Math.floor(wordTime.h);
      let m = wordTime.m;
      
      // Handle half hours (pusdeviņos = 8:30)
      if (wordTime.h % 1 !== 0) {
        h = Math.floor(wordTime.h);
        m = 30;
      }
      
      // Debug logging
      console.log(`🔍 extractTime: wordTime found - h=${h}, m=${m}, lower="${lower}"`);
      
      // Apply PM conversion based on day-part context
      const converted = applyPMConversion(h, m, lower);
      h = converted.hour;
      m = converted.minute;
      
      console.log(`🔍 extractTime: after PM conversion - h=${h}, m=${m}, rolloverDay=${converted.rolloverDay}`);
      
      let startDate = this.setTime(baseDate, h, m);
      // Handle day rollover for midnight
      if (converted.rolloverDay) {
        startDate = new Date(startDate);
        startDate.setDate(startDate.getDate() + 1);
      }
      
      result.hasExplicitTime = true;
      result.hour = h;
      result.minute = m;
      result.start = startDate;
      return result; // Return immediately - word time has priority over day-parts
    }

    // 4. LAST: Check day parts (no rīta, vakarā, etc.) - lowest priority
    // Only used if no explicit numeric or word time was found
    for (const [phrase, info] of this.dayParts) {
      if (lower.includes(phrase)) {
        result.hasExplicitTime = true;
        result.hour = info.default;
        result.minute = 0;
        result.start = this.setTime(baseDate, info.default, 0);
        result.dayPart = phrase;
        return result;
      }
    }

    // 5. No explicit time found
    return result;
  }

  extractWordTime(lower) {
    let h = null, m = 0;
    
    // Check hour words
    for (const [word, value] of this.hourWords) {
      if (lower.includes(word)) {
        h = value;
        console.log(`🔍 extractWordTime: found hour word "${word}" = ${value} in "${lower}"`);
        break;
      }
    }
    
    // Check minute words (only if hour found)
    if (h !== null) {
      for (const [word, value] of this.minuteWords) {
        if (lower.includes(word)) {
          m = value;
          console.log(`🔍 extractWordTime: found minute word "${word}" = ${value} in "${lower}"`);
          break;
        }
      }
    }
    
    // Debug: log if no hour found for common cases
    if (h === null && (lower.includes('desmitos') || lower.includes('desmitiem') || lower.includes('vienpadsmitos') || lower.includes('divpadsmitos'))) {
      console.error('❌ extractWordTime: hour word not found in lower:', lower, 'hourWords keys:', Array.from(this.hourWords.keys()).slice(0, 15));
    }
    
    return h !== null ? { h, m } : null;
  }

  extractDuration(lower) {
    // Check duration phrases
    for (const [phrase, minutes] of this.durations) {
      if (lower.includes(phrase)) {
        return minutes;
      }
    }
    
    // Check pattern "1h", "2h", etc.
    const durationMatch = lower.match(/(\d+(?:\.\d+)?)\s*h/);
    if (durationMatch) {
      return parseFloat(durationMatch[1]) * 60;
    }
    
    // Check "X minūtes"
    const minMatch = lower.match(/(\d+)\s*min/);
    if (minMatch) {
      return parseInt(minMatch[1], 10);
    }
    
    return null;
  }

  setTime(baseDate, hour, minute) {
    // Validate baseDate
    if (!baseDate || !(baseDate instanceof Date) || isNaN(baseDate.getTime())) {
      console.error('❌ setTime: invalid baseDate, using now');
      baseDate = new Date();
    }
    
    const date = new Date(baseDate);
    date.setHours(hour, minute, 0, 0);
    
    // Validate result
    if (isNaN(date.getTime())) {
      console.error('❌ setTime: invalid result date, hour:', hour, 'minute:', minute, 'baseDate:', baseDate);
      return new Date(); // Fallback to now
    }
    
    return date;
  }

  buildResult({ type, text, dateInfo, timeInfo, duration, langHint, now }) {
    const result = {
      type,
      lang: langHint,
      description: text
    };

    // If no explicit time info
    if (!timeInfo.hasExplicitTime && !dateInfo.hasExactTime) {
      // Pure reminder without time
      result.hasTime = false;
      result.start = this.toRigaISO(dateInfo.baseDate);
      result.confidence = 0.85;
      return result;
    }

    // Has time
    let startDate, endDate;
    if (dateInfo.hasExactTime) {
      // Relative time (pēc stundas) - already has exact timestamp
      startDate = dateInfo.baseDate;
      endDate = new Date(startDate.getTime() + (duration || 60) * 60 * 1000);
    } else if (timeInfo.isInterval) {
      // Interval (no 9 līdz 11)
      startDate = timeInfo.start;
      endDate = timeInfo.end;
    } else if (timeInfo.hasExplicitTime) {
      // Explicit time
      startDate = timeInfo.start;
      
      // Calculate end time
      if (duration) {
        endDate = new Date(startDate.getTime() + duration * 60 * 1000);
      } else {
        // Default 1 hour
        endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      }
    } else {
      // Fallback
      startDate = dateInfo.baseDate;
      startDate.setHours(9, 0, 0, 0);
      endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    }

    // Fix: if start is in past, adjust to next occurrence
    // Check if it's today (either isToday flag or same weekday)
    const isToday = dateInfo.isToday || 
      (dateInfo.type === 'weekday' && 
       startDate && 
       startDate.getDate() === now.getDate() && 
       startDate.getMonth() === now.getMonth() && 
       startDate.getFullYear() === now.getFullYear());
    
    if (isToday && startDate && startDate < now) {
      // If time has passed today, move to next occurrence
      if (dateInfo.type === 'weekday' && dateInfo.targetIsoDay) {
        // For weekdays, get next occurrence (7 days later)
        const nextWeekday = new Date(now);
        nextWeekday.setDate(nextWeekday.getDate() + 7);
        startDate = this.getNextWeekday(nextWeekday, dateInfo.targetIsoDay);
        startDate.setHours(timeInfo.hour || 9, timeInfo.minute || 0, 0, 0);
        endDate = new Date(startDate.getTime() + (duration || 60) * 60 * 1000);
      } else if (dateInfo.isToday) {
        // For other "today" cases, move to tomorrow with same time
        startDate = new Date(startDate);
        startDate.setDate(startDate.getDate() + 1);
        endDate = new Date(startDate.getTime() + (duration || 60) * 60 * 1000);
      }
    }

    result.start = this.toRigaISO(startDate);
    
    if (type === 'calendar') {
      result.end = this.toRigaISO(endDate);
    } else {
      result.hasTime = true;
    }
    
    result.confidence = 0.92;
    return result;
  }

  toRigaISO(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
      console.error('❌ toRigaISO: invalid date, using now');
      date = new Date();
    }
    
    const tz = "Europe/Riga";
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
      timeZoneName: "shortOffset"
    });
    const partsArr = dtf.formatToParts(date);
    const parts = Object.fromEntries(partsArr.map(p => [p.type, p.value]));
    let offset = (parts.timeZoneName || "GMT+00:00").replace(/^GMT/, "");
    
    // Normalize offset to always be "+HH:MM" or "-HH:MM" format
    // Handles: "+2" → "+02:00", "+02" → "+02:00", "+03" → "+03:00", "+02:00" → "+02:00"
    const offsetMatch = offset.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (offsetMatch) {
      const sign = offsetMatch[1];
      const hours = offsetMatch[2].padStart(2, '0');
      const minutes = offsetMatch[3] || '00';
      offset = `${sign}${hours}:${minutes}`;
    } else {
      // Fallback if parsing fails
      offset = "+02:00";
    }
    
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  }
}

// Export singleton instance
const parserV3 = new LatvianCalendarParserV3();

/**
 * Parse Latvian calendar/reminder text using Parser V3
 * @param {string} text - Input text
 * @param {string} nowISO - Current time ISO string
 * @param {string} langHint - Language hint (default: 'lv')
 * @returns {Object|null} Parsed result
 */
function parseWithV3(text, nowISO, langHint = 'lv') {
  try {
    const result = parserV3.parse(text, nowISO, langHint);
    
    // Validate result
    if (result && result.start) {
      const testDate = new Date(result.start);
      if (isNaN(testDate.getTime())) {
        console.error('❌ parseWithV3: Invalid start date:', result.start);
        return null;
      }
    }
    
    return result;
  } catch (error) {
    console.error('❌ parseWithV3 error:', error.message, 'Input:', text.substring(0, 50));
    return null; // Graceful fallback to LLM
  }
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

// parseWithCode (Parser V2) removed - replaced by Parser V3
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
  if (p === "pro") return { plan: "pro", dailyLimit: plans.pro.dailyLimit, monthlyLimit: plans.pro.monthlyLimit };
  if (p === "dev") return { plan: "dev", dailyLimit: plans.dev.dailyLimit, monthlyLimit: plans.dev.monthlyLimit };
  return { plan: "basic", dailyLimit: plans.basic.dailyLimit, monthlyLimit: plans.basic.monthlyLimit ?? 0 };
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
                  monthly: { monthKey: mKey, used: 0 }
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
          
          resolve({
            u: {
              plan: limits.plan,
              daily: { dayKey: row.day_key, used: row.daily_used, graceUsed: row.daily_grace_used },
              monthly: { monthKey: row.month_key, used: row.monthly_used }
            },
            limits
          });
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

async function updateQuotaUsage(userId, plan, dailyUsed, dailyGraceUsed) {
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
        
        // Update monthly_used field for easier tracking
        if (plan === "pro") {
          calculateMonthlyUsage(userId, mKey).then(totalMonthly => {
            db.run(
              `UPDATE quota_usage SET monthly_used = ? WHERE user_id = ? AND month_key = ?`,
              [totalMonthly, userId, mKey],
              () => resolve()
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

/* ===== COMBINED LV text analysis AI ===== */
const LV_COMBINED_ANALYSIS_PROMPT = `Tu esi latviešu valodas eksperts, kas analizē un uzlabo transkribētos tekstus. Tava uzdevums ir:

1. ANALIZĒT tekstu - atpazīt vārdus, kontekstu, nozīmi
2. IZLABOT kļūdas - gramatika, pareizrakstība, vārdu formas
3. UZLABOT skaidrību - padarīt tekstu skaidrāku un precīzāku
4. SAGLABĀT nozīmi - neizmainīt sākotnējo nozīmi

SAGLABĀT PERSONU VĀRDUS, ĢIMENES RELĀCIJAS UN KONTEKSTU:
- "WhatsApp sapulce ar Silardu" → "WhatsApp sapulce ar Silardu" (NEMAINĪT)
- "brāļiem Kalviņiem" → "brāļiem Kalviņiem" (NEMAINĪT)
- "pie vectētiņa", "pie vectētiņu", "pie vecmāmiņas", "pie vecākiem" → SAGLABĀT (nav "veselīšu" vai "veselības")
- Personīgie vārdi ar lielo burtu NEMAZ TIESĀMI ārā
- ⚠️ "vesetiņu" kontekstā ar "dzimšanas dienu", "uzņemšanas dienu" (pasākums) vai "vectētiņ"/"vecmāmiņ"/"vecāki" → "vectētiņu", NEVIS "veselīšu"
- "veselīšu" / "veselības" izmanto TIKAI, ja konteksts skaidri norāda uz veselības iestādi (piem., "ārsts", "laboratorija", "uzņemšana veselības iestādē", BET NAV "dzimšanas diena")

JA TEKSTS SATUR SHOPPING VĀRDU (nopirkt, pirkt, iepirkums, veikals), pielieto šādus noteikumus:
- Saglabāj produktu specifiku: "vājpiena" → saglabāj, "bezlaktozes" → saglabāj
- Labo gramatikas formas: "maizīte" → "maize", "pienītis" → "piens"

GRAMATIKAS KOREKCIJAS:
- Laika vārdi: "reit" → "Rīt", "rit" → "Rīt"
- Vārdu formas: "pulkstenis" → "pulksten", "tikšanas" → "tikšanās"
- Shopping: "sierīņus" → "sierīņi" (akuzatīvs → nominatīvs)

Atgriez TIKAI uzlaboto tekstu, bez skaidrojumiem. Temperatūra = 0.

Piemēri:
- "reit nopirkt maizi" → "Rīt nopirkt maizi"
- "pulkstenis deviņos tikšanās" → "Pulksten deviņos tikšanās"
- "nopirkt maizīte, pienītis" → "Nopirkt maize, piens"
- "vājpiena biezpienu" → "Vājpiena biezpiens"
- "WhatsApp sapulce ar Silardu" → "WhatsApp sapulce ar Silardu" (personvārds saglabāts)
- "Rīt ievest simts eiro brāļiem Kalviņiem" → "Rīt ievest simts eiro brāļiem Kalviņiem" (personvārds saglabāts)
- "pie vesetiņu uzņemšanas dienu" + konteksts "dzimšanas diena" → "pie vectētiņu uzņemšanas dienu" (ģimenes pasākums, nevis veselības iestāde)
- "Atgādinu, ka pie vesetiņu uz dzimšanas dienu" → "Atgādinu, ka pie vectētiņu uz dzimšanas dienu" (vectētiņu, nevis veselīšu)`;

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

/* ===== Deterministiskais LV parsētājs ===== */

const SYSTEM_PROMPT = `Tu esi deterministisks latviešu dabiskās valodas parsētājs. Atgriez TIKAI derīgu JSON objektu bez markdown, bez skaidrojumiem, bez teksta ārpus JSON. Formāts: {"type":"reminder|calendar|shopping","lang":"lv","start":"YYYY-MM-DDTHH:MM:SS+ZZ:ZZ","description":"...","hasTime":true/false}. Temperatūra = 0.

Globālie noteikumi
- Laika josla vienmēr: Europe/Riga (sezonāli +02:00 vai +03:00).
- Laika zīmogiem lieto ISO-8601: YYYY-MM-DDTHH:MM:SS+ZZ:ZZ.
- Pieņem 12h un 24h pierakstus: 9, 09:30, 9am/pm.
- Naturālie apzīmējumi: no rīta=09:00, pusdienlaikā=12:00, pēcpusdienā=15:00, vakarā=19:00, naktī=22:00. Konflikts → diennakts daļa ir prioritāte. "pusdeviņos"=08:30.
- Ilgumi: “1h”, “1.5h”, “45 min” → end = start + ilgums.
- Intervāli: “no 9 līdz 11” → start=09:00, end=11:00.
- Nedēļas dienas: 
  * Pirmdiena = 1, Otrdiena = 2, Trešdiena = 3, Ceturtdiena = 4, Piektdiena = 5, Sestdiena = 6, Svētdiena = 7 (ISO 8601).
  * "nākamajā pirmdienā" = tuvākā nākotnes pirmdiena.
  * JA tiek minēta nedēļas diena ar laiku → izmanto tuvāko dienu, izmantojot loģiku:
    - JA currentTime nedēļas diena (1-7) < minēta diena (1-7) → minēta diena VĒL NAV iestājusies → ŠĪ nedēļa
    - JA currentTime nedēļas diena >= minēta diena → minēta diena JAU pagājusi → NĀKAMĀ nedēļa
  * IZŅĒMUMS: ja currentTime.datums = minētais datums un currentTime.laiks < minētais laiks → ŠODIEN, bet vēlāk
- Piemēri (JA ŠODIEN IR TREŠDIENA, diena 3):
  * "Svētdien, 10:00" → nākamā svētdiena (diena 7, tagad 3, 7 >= 3 → nākamā nedēļa)
  * "Pirmdiena, 9:00" → nākamā nedēļas pirmdiena (diena 1, tagad 3, 1 < 3 → BET 1 jau pagājis šajā nedēļā, jo nedēļa sākas ar pirmdienu → nākamā nedēļa)
  * "Piektdiena, 18:00" → šī nedēļas piektdiena (diena 5, tagad 3, 5 > 3 → šī nedēļa)
  * "Trešdiena, 12:00" → šodien 12:00, JA tagad < 12:00; citādi nākamā trešdiena
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

Vairāki reminderi vienā frāzē:
- Ja tekstā ir vairāki atgādinājumi (atdalīti ar "un", "kā arī", "arī", utt.):
  { "type":"reminders","lang":"lv","reminders":[
    {"type":"reminder","start":"...","description":"...","hasTime":true},
    {"type":"reminder","start":"...","description":"...","hasTime":false}
  ]}
- Ja ir viens reminders → izmanto vienkāršo formu (backward compatible).

Atgriez tikai vienu no formām.`;

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
  const auth = req.headers.authorization || "";
  const expectedToken = `Bearer ${APP_BEARER_TOKEN}`;
  
  if (APP_BEARER_TOKEN && auth !== expectedToken) {
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
    const planHdr = req.header("X-Plan") || "basic";
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
    if (limits.plan === "pro") {
      out.monthlyLimit = limits.monthlyLimit;
      out.monthlyUsed = u.monthly.used;
      out.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used);
    }
    return res.json(out);
  } catch (error) {
    console.error("Quota error:", error);
    return res.status(500).json({ error: "quota_failed", requestId: req.requestId });
  }
});

/* ===== HELPER FUNCTIONS ===== */

// Log transcript flow for debugging
function logTranscriptFlow(req, res, raw, norm, analyzedText, needsAnalysis, score, out) {
  const requestId = req.requestId.slice(-8);
  const isError = res.statusCode >= 400;
  const debugMode = process.env.DEBUG_TRANSCRIPT === 'true';
  
  // Kompakts log (vienmēr)
  const whisperShort = raw.length > 50 ? raw.slice(0, 50) + '...' : raw;
  const analyzedShort = analyzedText.length > 50 ? analyzedText.slice(0, 50) + '...' : analyzedText;
  const finalShort = out.description?.length > 50 ? out.description.slice(0, 50) + '...' : (out.description || 'N/A');
  
  let logLine = `📝 [${requestId}] W:"${whisperShort}"`;
  if (needsAnalysis) {
    logLine += ` → GPT:"${analyzedShort}"`;
  }
  logLine += ` → Client:${out.type}:"${finalShort}"`;
  
  console.log(logLine);
  
  // Detalizēts log (ja DEBUG_TRANSCRIPT vai error)
  if (debugMode || isError) {
    console.log(JSON.stringify({
      requestId: req.requestId,
      transcriptFlow: {
        whisper: raw,
        normalized: norm,
        analyzed: analyzedText,
        analysisApplied: needsAnalysis,
        confidence: score,
        final: {
          type: out.type,
          description: out.description,
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
    // Parsēšana ar Parser v3 vai LLM (V3 vienmēr ieslēgts)
    let parsed = null;
    
    console.log(`🧭 [TEST] Parser v3 attempting parse: "${analyzedText}"`);
    parsed = parseWithV3(analyzedText, nowISO, langHint);
    if (parsed && parsed.confidence >= 0.8) {
      console.log(`🧭 [TEST] Parser v3 used: type=${parsed.type}`);
      parsed.raw_transcript = raw;
      parsed.normalized_transcript = norm;
      parsed.analyzed_transcript = analyzedText;
      parsed.analysis_applied = false;
      parsed.test_mode = true;
      return res.json(parsed);
    }
    
    // LLM fallback
    console.log(`🤖 [TEST] LLM fallback: parsing with GPT`);
    const userMsg = `currentTime=${nowISO}\ntomorrowExample=${toRigaISO(new Date(Date.now() + 24 * 3600 * 1000))}\nTeksts: ${analyzedText}`;
    
    const messages = [
      { 
        role: "system", 
        content: SYSTEM_PROMPT + `\n\nSVARĪGI: Atgriez TIKAI derīgu JSON objektu pēc shēmas. Nav markdown, nav \`\`\`json\`\`\`, tikai tīrs JSON ar type, lang, description, start, hasTime (vai end calendar gadījumā).\n\nTagadējais datums un laiks: ${nowISO} (Europe/Riga).`
      },
      { role: "user", content: userMsg }
    ];
    
    const params = buildParams({
      model: DEFAULT_TEXT_MODEL,
      messages: messages,
      json: true,
      max: 280,
      temperature: 0
    });
    
    const chat = await safeCreate(params);
    const content = chat?.choices?.[0]?.message?.content || "{}";
    const out = JSON.parse(content);
    
    out.raw_transcript = raw;
    out.normalized_transcript = norm;
    out.analyzed_transcript = analyzedText;
    out.analysis_applied = false;
    out.test_mode = true;
    
    return res.json(out);
    
  } catch (error) {
    console.error("[TEST] Error:", error);
    return res.status(500).json({ error: "test_failed", details: String(error) });
  }
});

app.post("/ingest-audio", async (req, res) => {
  const processingStart = Date.now();
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
    const { u, limits } = await getUserUsage(userId, planHdr);

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
      return res.status(413).json({ error: "file_too_large", requestId: req.requestId });
    }

    if (!fileBuf.length) return res.status(400).json({ error: "file_missing" });

    // Klienta VAD telemetrija
    const vadActiveSeconds = Number(fields.vadActiveSeconds || 0);
    const recordingDurationSeconds = Number(fields.recordingDurationSeconds || 0);

    // Minimāla runas aktivitāte (pirms maksas transkripcijas)
    if (vadActiveSeconds < 0.3 || recordingDurationSeconds < 0.6) {
      if (u.daily.graceUsed < GRACE_DAILY) u.daily.graceUsed += 1;
      await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed);
      databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
      return res.status(422).json({ error: "no_speech_detected_client", details: { vadActiveSeconds, recordingDurationSeconds } });
    }

    // Transcribe (OpenAI) with retry logic
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

    // Normalizācija + kvalitātes pārbaude
    const raw = (tr.text || "").trim();
    const norm = normalizeTranscript(raw, langHint);
    const score = qualityScore(norm);

    if (norm.length < 2 || score < 0.35) {
      if (u.daily.graceUsed < GRACE_DAILY) u.daily.graceUsed += 1;
      await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed);
      databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
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
      const qualityThreshold = 0.6; // Lower = triggers less often (saves OpenAI calls)
      const currentScore = qualityScore(norm);
      
      // Pārbaudām vai ir kļūdas, kas nepieciešama AI labošana
    // QC v2: neuzskata diakritikas/lielos burtus par kļūdu; fokusējas uz konkrētām kļūdām + zemu score
    const hasCommonErrors = ((req.header("X-Text-QC") || "").toLowerCase() === "v2")
      ? (
          norm.includes("maizīte") || norm.includes("pienītis") ||
          norm.includes("reit") || norm.includes("rit") ||
          currentScore < qualityThreshold
        )
      : (
          /[āčēģīķļņšūž]/.test(norm) ||
          norm !== norm.toLowerCase() ||
          norm.includes("maizīte") || norm.includes("pienītis") ||
          norm.includes("reit") || norm.includes("rit") ||
          currentScore < qualityThreshold
        );
      
      needsAnalysis = hasCommonErrors;
      
      if (needsAnalysis) {
        console.log(`🔍 Text needs analysis (score: ${currentScore.toFixed(2)}, errors: ${hasCommonErrors})`);
        
        try {
          // Combined LV analysis (saves 1 AI call by doing both general + shopping analysis in one call)
          const analysis = await safeCreate(
            buildParams({
              model: DEFAULT_TEXT_MODEL,
            messages: [
              { role: "system", content: LV_COMBINED_ANALYSIS_PROMPT },
              { role: "user", content: norm }
              ],
              max: 350,
              temperature: 0
            })
          );
          analyzedText = (analysis.choices?.[0]?.message?.content || norm).trim();
          console.log(`✅ Text analyzed in single call: "${norm}" → "${analyzedText}"`);
        } catch (e) {
          console.warn("LV analysis failed, using normalized text:", e);
          analyzedText = norm;
        }
      } else {
        console.log(`✅ Text is good quality (score: ${currentScore.toFixed(2)}), skipping AI analysis`);
      }
    }

    // Laika enkuri
    // Validate and normalize currentTime if provided
    let nowISO;
    if (fields.currentTime) {
      // Normalize offset format: "+2" → "+02:00", "+02" → "+02:00", "+02:00" → "+02:00"
      let normalizedTime = fields.currentTime;
      const offsetMatch = normalizedTime.match(/([+-])(\d{1,2})(?::(\d{2}))?$/);
      if (offsetMatch && !offsetMatch[3]) {
        // Offset is missing minutes (e.g., "+2" or "+02")
        const sign = offsetMatch[1];
        const hours = offsetMatch[2].padStart(2, '0');
        const minutes = '00';
        normalizedTime = normalizedTime.replace(/([+-])(\d{1,2})(?::(\d{2}))?$/, `${sign}${hours}:${minutes}`);
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
    
    const tmr = new Date(Date.now() + 24 * 3600 * 1000);
    const tomorrowISO = fields.tomorrowExample || toRigaISO(new Date(tmr.getFullYear(), tmr.getMonth(), tmr.getDate(), 0, 0, 0));

    const userMsg = `currentTime=${nowISO}\ntomorrowExample=${tomorrowISO}\nTeksts: ${analyzedText}`;

  // Feature flags via headers (no app update required)
  const headerQcV2 = (req.header("X-Text-QC") || "").toLowerCase() === "v2";
  const headerShoppingList = (req.header("X-Shopping-Style") || "").toLowerCase() === "list";

  const allowDevices = (process.env.FEATURE_ALLOWLIST_DEVICE_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const allowUsers = (process.env.FEATURE_ALLOWLIST_USER_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const deviceIdHdr = req.header("X-Device-Id") || "";
  const userIdHdr = req.header("X-User-Id") || "";
  const allowlisted = (allowDevices.includes(deviceIdHdr) || allowUsers.includes(userIdHdr));

  const qcV2 = headerQcV2 || allowlisted;
  const shoppingStyleList = headerShoppingList || allowlisted;

  // Text quality check v2
  if (qcV2) {
    // hasCommonErrors v2: no diacritics/lowercase heuristics; rely on concrete fixes + score
    // Already achieved by not altering analyzedText here; we just log the mode
    console.log(`🧪 QC v2 enabled`);
  }

  // Parser V3 vienmēr ieslēgts visiem lietotājiem
  console.log(`🧭 Parser v3 attempting parse: "${analyzedText}"`);
  const parsed = parseWithV3(analyzedText, nowISO, langHint);
  // Ja Parser v3 atgriež objektu ar pietiekamu confidence (≥0.8), izmanto to bez LLM
  if (parsed && parsed.confidence >= 0.8) {
    console.log(`🧭 Parser v3 used (confidence: ${parsed.confidence}): type=${parsed.type}, start=${parsed.start}, end=${parsed.end || 'none'}`);
    parsed.raw_transcript = raw;
    parsed.normalized_transcript = norm;
    parsed.analyzed_transcript = analyzedText;
    parsed.analysis_applied = needsAnalysis;
    parsed.confidence = score;
    if (parsed.type === 'shopping' && shoppingStyleList) {
      parsed.description = parsed.description || 'Pirkumu saraksts';
    }
    // Kvotu skaitīšana un atbilde kā zemāk (kopējam no success ceļa)
    u.daily.used += 1;
    operationsTotal.inc({ status: "success", plan: limits.plan }, 1);
    await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed);
    databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
    quotaUsage.inc({ plan: limits.plan, type: "daily" }, 1);
    if (limits.plan === "pro") { quotaUsage.inc({ plan: limits.plan, type: "monthly" }, 1); }
    parsed.quota = {
      plan: limits.plan,
      dailyLimit: normalizeDaily(limits.dailyLimit),
      dailyUsed: u.daily.used,
      dailyRemaining: limits.dailyLimit >= 999999 ? null : Math.max(0, limits.dailyLimit - u.daily.used),
      dailyGraceLimit: GRACE_DAILY,
      dailyGraceUsed: u.daily.graceUsed
    };
    if (limits.plan === 'pro') {
      parsed.quota.monthlyLimit = limits.monthlyLimit;
      parsed.quota.monthlyUsed = u.monthly.used;
      parsed.quota.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used);
    }
    parsed.requestId = req.requestId;
    const processingTime = Date.now() - processingStart;
    audioProcessingTime.observe({ status: "success" }, processingTime);
    
    // Log transcript flow
    logTranscriptFlow(req, res, raw, norm, analyzedText, needsAnalysis, score, parsed);
    
    return res.json(parsed);
  } else {
    console.log(`🧭 Parser v3 returned ${parsed ? `low confidence (${parsed.confidence || 0})` : 'null'}, falling back to LLM`);
  }

  // Ja Parser V3 neizdevās – krītam atpakaļ uz LLM
  console.log(`🤖 LLM fallback: parsing with GPT for "${analyzedText.substring(0, 50)}..."`);
    let chat;
    const maxRetries = 2;
    let retryCount = 0;
    
  try {
    while (retryCount <= maxRetries) {
      try {
        const messages = [
          { 
            role: "system", 
            content: SYSTEM_PROMPT + `\n\nSVARĪGI: Atgriez TIKAI derīgu JSON objektu pēc shēmas. Nav markdown, nav \`\`\`json\`\`\`, tikai tīrs JSON ar type, lang, description, start, hasTime (vai end calendar gadījumā).\n\nTagadējais datums un laiks: ${nowISO} (Europe/Riga).`
          },
            { role: "user", content: userMsg }
        ];
        
        // GPT-5 mini var nestrādāt ar JSON Schema, tāpēc izmantojam vienkāršu JSON mode
        const params = buildParams({
          model: DEFAULT_TEXT_MODEL,
          messages: messages,
          json: true,  // Vienkāršs JSON mode (nevis JSON Schema)
          max: 280,
          temperature: 0
        });
        
        console.log(`🔍 LLM request params:`, JSON.stringify({
          model: params.model,
          has_json_schema: !!params.response_format?.json_schema,
          max_completion_tokens: params.max_completion_tokens,
          has_temperature: 'temperature' in params,
          messages_count: params.messages?.length
        }));
        
        chat = await safeCreate(params);
        console.log(`✅ LLM response received, content length: ${chat?.choices?.[0]?.message?.content?.length || 0}`);
        break; // Success
      } catch (error) {
        retryCount++;
        if (retryCount > maxRetries) {
          console.error(`❌ LLM call failed after ${maxRetries} retries: ${error.message}`);
          throw error;
        }
        
        // Exponential backoff: 500ms, 1000ms
        const delay = 500 * Math.pow(2, retryCount - 1);
        console.log(`⚠️ OpenAI call failed, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  } catch (llmError) {
    // If LLM completely fails, create a fallback reminder
    console.error(`❌ LLM parsing failed completely: ${llmError.message}`);
    const fallbackOut = { 
      type: "reminder", 
      lang: langHint || "lv", 
      start: nowISO, 
      description: analyzedText || norm, 
      hasTime: false 
    };
    fallbackOut.raw_transcript = raw;
    fallbackOut.normalized_transcript = norm;
    fallbackOut.analyzed_transcript = analyzedText;
    fallbackOut.analysis_applied = needsAnalysis;
    fallbackOut.confidence = score;
    
    // Count quota even for fallback
    u.daily.used += 1;
    operationsTotal.inc({ status: "success", plan: limits.plan }, 1);
    await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed);
    databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
    quotaUsage.inc({ plan: limits.plan, type: "daily" }, 1);
    if (limits.plan === "pro") { quotaUsage.inc({ plan: limits.plan, type: "monthly" }, 1); }
    
    fallbackOut.quota = {
      plan: limits.plan,
      dailyLimit: normalizeDaily(limits.dailyLimit),
      dailyUsed: u.daily.used,
      dailyRemaining: limits.dailyLimit >= 999999 ? null : Math.max(0, limits.dailyLimit - u.daily.used),
      dailyGraceLimit: GRACE_DAILY,
      dailyGraceUsed: u.daily.graceUsed
    };
    if (limits.plan === 'pro') {
      fallbackOut.quota.monthlyLimit = limits.monthlyLimit;
      fallbackOut.quota.monthlyUsed = u.monthly.used;
      fallbackOut.quota.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used);
    }
    fallbackOut.requestId = req.requestId;
    const processingTime = Date.now() - processingStart;
    audioProcessingTime.observe({ status: "success" }, processingTime);
    
    logTranscriptFlow(req, res, raw, norm, analyzedText, needsAnalysis, score, fallbackOut);
    return res.json(fallbackOut);
    }

    let out;
    try {
      const content = chat?.choices?.[0]?.message?.content || "{}";
      console.log(`🔍 LLM raw response (first 200 chars): ${content.substring(0, 200)}`);
      out = JSON.parse(content);
      
      // Validate JSON with schema - pārbaudām arī, vai nav tukšs
      const isEmpty = Object.keys(out).length === 0;
      const isValid = !isEmpty && isValidCalendarJson(out);
      
      if (!isValid) {
        if (isEmpty) {
          console.warn(`⚠️ LLM returned empty JSON {}. Attempting canary fallback to gpt-4o-mini...`);
        } else {
          console.warn(`⚠️ LLM returned invalid JSON (failed validation). Type: ${out.type}, hasLang: ${!!out.lang}, hasReminders: ${Array.isArray(out.reminders)}, remindersCount: ${out.reminders?.length || 0}. Attempting repair...`);
        }
        
        // Repair attempt - viens mēģinājums ar skaidru repair prompt
        let repaired = null;
        try {
          const repairMessages = [
            { 
              role: "system", 
              content: SYSTEM_PROMPT + "\n\nSVARĪGI: Atgriez TIKAI derīgu JSON objektu ar type, lang, description, start, hasTime. Nav markdown, tikai tīrs JSON."
            },
            { 
              role: "user", 
              content: isEmpty 
                ? `Parsē šo tekstu latviešu valodā un izveido JSON:\n${analyzedText}`
                : `Labo šo JSON, lai tas atbilstu shēmai:\n${JSON.stringify(out, null, 2)}\n\nSākotnējais teksts: ${analyzedText}`
            }
          ];
          
          const repairParams = buildParams({
            model: DEFAULT_TEXT_MODEL,
            messages: repairMessages,
            json: true,
            max: 280,
            temperature: 0
          });
          
          const repairChat = await safeCreate(repairParams);
          const repairContent = repairChat?.choices?.[0]?.message?.content || "{}";
          repaired = JSON.parse(repairContent);
          
          if (!isEmpty && isValidCalendarJson(repaired)) {
            console.log(`✅ Repair successful`);
            out = repaired;
          } else if (isEmpty && isValidCalendarJson(repaired)) {
            console.log(`✅ Canary repair successful`);
            out = repaired;
          } else {
            console.warn(`⚠️ Repair failed, trying canary fallback to gpt-4o-mini...`);
            // Canary fallback uz gpt-4o-mini
            try {
              const canaryMessages = [
                { 
                  role: "system", 
                  content: SYSTEM_PROMPT + `\n\nSVARĪGI: Atgriez TIKAI derīgu JSON objektu ar type, lang, description, start, hasTime. Nav markdown, tikai tīrs JSON.\n\nTagadējais datums un laiks: ${nowISO} (Europe/Riga).`
                },
                { role: "user", content: analyzedText }
              ];
              
              const canaryParams = buildParams({
                model: "gpt-4o-mini",
                messages: canaryMessages,
                json: true,
                max: 280,
                temperature: 0
              });
              
              const canaryChat = await safeCreate(canaryParams);
              const canaryContent = canaryChat?.choices?.[0]?.message?.content || "{}";
              const canaryOut = JSON.parse(canaryContent);
              
              if (isValidCalendarJson(canaryOut)) {
                console.log(`✅ Canary fallback (gpt-4o-mini) successful`);
                out = canaryOut;
              } else {
                console.warn(`⚠️ Canary fallback failed, using generic reminder`);
                out = { type: "reminder", lang: langHint || "lv", start: nowISO, description: analyzedText || norm, hasTime: false };
              }
            } catch (canaryError) {
              console.error(`❌ Canary fallback failed: ${canaryError.message}`);
              out = { type: "reminder", lang: langHint || "lv", start: nowISO, description: analyzedText || norm, hasTime: false };
            }
          }
        } catch (repairError) {
          console.error(`❌ Repair attempt failed: ${repairError.message}. Trying canary fallback...`);
          // Canary fallback uz gpt-4o-mini
          try {
            const canaryMessages = [
              { 
                role: "system", 
                content: SYSTEM_PROMPT + `\n\nSVARĪGI: Atgriez TIKAI derīgu JSON objektu ar type, lang, description, start, hasTime. Nav markdown, tikai tīrs JSON.\n\nTagadējais datums un laiks: ${nowISO} (Europe/Riga).`
              },
              { role: "user", content: analyzedText }
            ];
            
            const canaryParams = buildParams({
              model: "gpt-4o-mini",
              messages: canaryMessages,
              json: true,
              max: 280,
              temperature: 0
            });
            
            const canaryChat = await safeCreate(canaryParams);
            const canaryContent = canaryChat?.choices?.[0]?.message?.content || "{}";
            const canaryOut = JSON.parse(canaryContent);
            
            if (isValidCalendarJson(canaryOut)) {
              console.log(`✅ Canary fallback (gpt-4o-mini) successful`);
              out = canaryOut;
            } else {
              console.warn(`⚠️ Canary fallback failed, using generic reminder`);
              out = { type: "reminder", lang: langHint || "lv", start: nowISO, description: analyzedText || norm, hasTime: false };
            }
          } catch (canaryError) {
            console.error(`❌ Canary fallback failed: ${canaryError.message}`);
            out = { type: "reminder", lang: langHint || "lv", start: nowISO, description: analyzedText || norm, hasTime: false };
          }
        }
      }
    } catch (parseError) {
      const rawContent = chat?.choices?.[0]?.message?.content || "empty";
      console.error(`❌ JSON parse error: ${parseError.message}. Raw content (first 200 chars): ${rawContent.substring(0, 200)}. Trying canary fallback...`);
      
      // Canary fallback uz gpt-4o-mini
      try {
        const canaryMessages = [
          { 
            role: "system", 
            content: SYSTEM_PROMPT + `\n\nSVARĪGI: Atgriez TIKAI derīgu JSON objektu ar type, lang, description, start, hasTime. Nav markdown, tikai tīrs JSON.\n\nTagadējais datums un laiks: ${nowISO} (Europe/Riga).`
          },
          { role: "user", content: analyzedText }
        ];
        
        const canaryParams = buildParams({
          model: "gpt-4o-mini",
          messages: canaryMessages,
          json: true,
          max: 280,
          temperature: 0
        });
        
        const canaryChat = await safeCreate(canaryParams);
        const canaryContent = canaryChat?.choices?.[0]?.message?.content || "{}";
        const canaryOut = JSON.parse(canaryContent);
        
        if (isValidCalendarJson(canaryOut)) {
          console.log(`✅ Canary fallback (gpt-4o-mini) successful after parse error`);
          out = canaryOut;
        } else {
          console.warn(`⚠️ Canary fallback failed, using generic reminder`);
          out = { type: "reminder", lang: langHint || "lv", start: nowISO, description: analyzedText || norm, hasTime: false };
        }
      } catch (canaryError) {
        console.error(`❌ Canary fallback failed: ${canaryError.message}`);
        out = { type: "reminder", lang: langHint || "lv", start: nowISO, description: analyzedText || norm, hasTime: false };
      }
    }

    // Ensure out has required fields before proceeding
    if (!out.type) {
      console.error(`❌ Critical: out object missing type field. Creating fallback reminder.`);
      out = { type: "reminder", lang: langHint || "lv", start: nowISO, description: analyzedText || norm, hasTime: false };
    }

    // Pārbaudām vai ir masīvs ar reminderiem
    const isMultipleReminders = out.type === "reminders" && Array.isArray(out.reminders) && out.reminders.length > 0;
    
    if (isMultipleReminders) {
      // Apstrādājam katru reminderu masīvā
      for (const reminder of out.reminders) {
        reminder.raw_transcript = raw;
        reminder.normalized_transcript = norm;
        reminder.analyzed_transcript = analyzedText;
        reminder.analysis_applied = needsAnalysis;
        reminder.confidence = score;
        reminder.lang = reminder.lang || langHint;
      }
      
      // Quota counting - ja < 20 sekundes, skaitām kā 1 request
      const totalProcessingTime = Date.now() - processingStart;
      if (totalProcessingTime < 20000) {
        u.daily.used += 1; // Skaitām kā 1 request
      } else {
        // Skaitām pēc reminderu skaita
        u.daily.used += out.reminders.length;
      }
      
      // Kvotu statuss atbildē (kopīgs visiem reminderiem)
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
      
      // Update quota in database
      await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed);
      databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
      quotaUsage.inc({ plan: limits.plan, type: "daily" }, 1);
      if (limits.plan === "pro") { quotaUsage.inc({ plan: limits.plan, type: "monthly" }, 1); }
      
      // Track successful operations
      operationsTotal.inc({ status: "success", plan: limits.plan }, 1);
      
      out.requestId = req.requestId;
      const processingTime = Date.now() - processingStart;
      audioProcessingTime.observe({ status: "success" }, processingTime);
      
      // Log transcript flow
      logTranscriptFlow(req, res, raw, norm, analyzedText, needsAnalysis, score, out);
      
      return res.json(out);
    }

    // Backward compatible: viens reminders (vai cits types)
    out.raw_transcript = raw;
    out.normalized_transcript = norm;
    out.analyzed_transcript = analyzedText;
    out.analysis_applied = needsAnalysis;
    out.confidence = score;

    // ŠIS ieraksts derīgs → skaitām kvotu
    u.daily.used += 1;
    
    // Track successful operations
    operationsTotal.inc({ status: "success", plan: limits.plan }, 1);
    
    // Update quota in database (monthly is calculated automatically)
    await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed);
    
    // Track database operations
    databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
    
    // Track quota usage metrics
    quotaUsage.inc({ plan: limits.plan, type: "daily" }, 1);
    if (limits.plan === "pro") {
      quotaUsage.inc({ plan: limits.plan, type: "monthly" }, 1);
    }

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

    // Track successful processing time
    const processingTime = Date.now() - processingStart;
    audioProcessingTime.observe({ status: "success" }, processingTime);

    // Log transcript flow
    logTranscriptFlow(req, res, raw, norm, analyzedText, needsAnalysis, score, out);

    return res.json(out);

  } catch (e) {
    // Track failed processing time
    const processingTime = Date.now() - processingStart;
    audioProcessingTime.observe({ status: "error" }, processingTime);
    
    // Track failed operations
    operationsTotal.inc({ status: "error", plan: req.header("X-Plan") || "unknown" }, 1);
    
    console.error("processing_failed:", e?.response?.status || "", e?.response?.data || "", e);
    return res.status(500).json({ error: "processing_failed", details: String(e) });
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
