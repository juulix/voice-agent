import express from "express";
import Busboy from "busboy";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import Anthropic from "@anthropic-ai/sdk";
import client from "prom-client";
import sqlite3 from "sqlite3";
import path from "path";
import * as Sentry from "@sentry/node";

/* ===== ENV ===== */
const PORT = process.env.PORT || 3000;
const APP_BEARER_TOKEN = process.env.APP_BEARER_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

// Claude/Teacher configuration
// Meklē API key dažādos environment variable nosaukumos (Railway var būt ar domuzīmēm vai citādāk)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY 
  || process.env.ECHOTIME_ONBOARDING_API_KEY 
  || process.env['ECHOTIME-ONBOARDING-API-KEY'] // Railway ar domuzīmēm (uppercase)
  || process.env['echotime-onboarding-api-key'] // Railway ar domuzīmēm (lowercase) ← Railway standarts
  || process.env.echotime_onboarding_api_key; // lowercase underscore
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

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

// Teacher-Student Learning Mode Configuration
const LEARNING_MODE = (process.env.LEARNING_MODE || '').toLowerCase() === 'on';
const TEACHER_MODEL = process.env.TEACHER_MODEL || 'claude-sonnet-4-20250514'; // Claude Sonnet 4.5
const TEACHER_RATE = parseFloat(process.env.TEACHER_RATE || '0.3'); // Max 30% of requests
const CONFIDENCE_THRESHOLD_HIGH = parseFloat(process.env.CONFIDENCE_THRESHOLD_HIGH || '0.8');
const CONFIDENCE_THRESHOLD_LOW = parseFloat(process.env.CONFIDENCE_THRESHOLD_LOW || '0.5');
const STRICT_TRIGGERS = (process.env.STRICT_TRIGGERS || 'am_pm,interval,relative_multi').split(',').map(s => s.trim());

// V3 Parser Feature Flags (rollback plāns)
const DAY_EVENING_DEFAULT = (process.env.DAY_EVENING_DEFAULT || 'on').toLowerCase() === 'on';
const ABSOLUTE_DATE_FIRST = (process.env.ABSOLUTE_DATE_FIRST || 'on').toLowerCase() === 'on';
const WEEKDAY_EARLY_PM = (process.env.WEEKDAY_EARLY_PM || 'on').toLowerCase() === 'on';
const HOUR_DEFAULTS_V1 = (process.env.HOUR_DEFAULTS_V1 || 'on').toLowerCase() === 'on'; // New: 6/7 o'clock policy

// Debug: Log Teacher-Student mode status (after all config is defined)
console.log(`🔍 Teacher-Student Learning Mode: ${LEARNING_MODE ? 'ON' : 'OFF'}`);
const hasAnthropicKey = !!ANTHROPIC_API_KEY;
// Atklāt, kurš environment variable satur key
let keySource = 'none';
if (process.env.ANTHROPIC_API_KEY) keySource = 'ANTHROPIC_API_KEY';
else if (process.env.ECHOTIME_ONBOARDING_API_KEY) keySource = 'ECHOTIME_ONBOARDING_API_KEY';
else if (process.env['ECHOTIME-ONBOARDING-API-KEY']) keySource = 'ECHOTIME-ONBOARDING-API-KEY';
else if (process.env['echotime-onboarding-api-key']) keySource = 'echotime-onboarding-api-key'; // Railway standarts
else if (process.env.echotime_onboarding_api_key) keySource = 'echotime_onboarding_api_key';

// Debug: rādīt visus environment variables, kas satur "anthropic" vai "onboarding"
const debugEnvVars = Object.keys(process.env).filter(k => 
  k.toLowerCase().includes('anthropic') || 
  k.toLowerCase().includes('onboarding') ||
  k.toLowerCase().includes('claude') ||
  k.toLowerCase().includes('echo')
);
if (debugEnvVars.length > 0) {
  console.log(`🔍 Found related env vars: ${debugEnvVars.join(', ')}`);
  // Rādīt arī vērtību garumu (bet ne pašu vērtību - drošības pēc)
  debugEnvVars.forEach(k => {
    const val = process.env[k];
    if (val) {
      const preview = val.substring(0, 10) + '...' + val.substring(val.length - 4);
      console.log(`   ${k}: length=${val.length}, preview=${preview}`);
    }
  });
} else {
  console.log(`⚠️ No related env vars found! Checking all env vars...`);
  // Ja nav atrasts, rādīt visus env vars (pirmos 20)
  const allEnvVars = Object.keys(process.env).slice(0, 20);
  console.log(`   Sample env vars: ${allEnvVars.join(', ')}`);
}

console.log(`🔍 Anthropic API Key: ${hasAnthropicKey ? `found ✅ (${keySource})` : 'NOT found ❌'}`);
if (hasAnthropicKey) {
  const keyPreview = ANTHROPIC_API_KEY.substring(0, 10) + '...' + ANTHROPIC_API_KEY.substring(ANTHROPIC_API_KEY.length - 4);
  console.log(`   Key preview: ${keyPreview} (length: ${ANTHROPIC_API_KEY.length})`);
}
console.log(`🔍 Anthropic API: ${anthropic ? 'initialized ✅' : 'NOT configured ❌'}`);
if (LEARNING_MODE && anthropic) {
  console.log(`✅ Teacher-Student mode ready: model=${TEACHER_MODEL}, rate=${TEACHER_RATE}, thresholds=[${CONFIDENCE_THRESHOLD_LOW}-${CONFIDENCE_THRESHOLD_HIGH}]`);
} else if (LEARNING_MODE && !anthropic) {
  console.warn(`⚠️ Teacher-Student mode is ON but Anthropic API is NOT configured!`);
  console.warn(`   Please set ANTHROPIC_API_KEY or ECHOTIME_ONBOARDING_API_KEY in Railway variables.`);
  if (debugEnvVars.length > 0) {
    console.warn(`   Found similar env vars: ${debugEnvVars.join(', ')}`);
  }
}

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
  
  // Teacher-Student Learning: Gold log table
  db.run(`CREATE TABLE IF NOT EXISTS v3_gold_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id TEXT,
    session_id TEXT,
    asr_text TEXT,
    normalized_text TEXT,
    v3_result TEXT NOT NULL,
    teacher_result TEXT,
    decision TEXT NOT NULL,
    discrepancies TEXT,
    used_triggers TEXT,
    latency_ms TEXT,
    severity TEXT,
    am_pm_decision TEXT,
    desc_had_time_tokens_removed INTEGER DEFAULT 0,
    confidence_before REAL,
    confidence_after REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Add new columns if they don't exist (backward compatible)
  // SQLite doesn't support IF NOT EXISTS with ALTER TABLE, so we check first
  db.all(`PRAGMA table_info(v3_gold_log)`, (err, columns) => {
    if (err) {
      console.error('❌ Failed to check table info:', err);
      return;
    }
    
    const columnNames = columns.map(col => col.name);
    
    // Add columns only if they don't exist
    if (!columnNames.includes('am_pm_decision')) {
      db.run(`ALTER TABLE v3_gold_log ADD COLUMN am_pm_decision TEXT`, (err) => {
        if (err) console.error('❌ Failed to add am_pm_decision:', err);
      });
    }
    
    if (!columnNames.includes('desc_had_time_tokens_removed')) {
      db.run(`ALTER TABLE v3_gold_log ADD COLUMN desc_had_time_tokens_removed INTEGER DEFAULT 0`, (err) => {
        if (err) console.error('❌ Failed to add desc_had_time_tokens_removed:', err);
      });
    }
    
    if (!columnNames.includes('confidence_before')) {
      db.run(`ALTER TABLE v3_gold_log ADD COLUMN confidence_before REAL`, (err) => {
        if (err) console.error('❌ Failed to add confidence_before:', err);
      });
    }
    
    if (!columnNames.includes('confidence_after')) {
      db.run(`ALTER TABLE v3_gold_log ADD COLUMN confidence_after REAL`, (err) => {
        if (err) console.error('❌ Failed to add confidence_after:', err);
      });
    }
    
    // Telemetrija: hour policy metrics
    if (!columnNames.includes('hour_7_resolved_to')) {
      db.run(`ALTER TABLE v3_gold_log ADD COLUMN hour_7_resolved_to TEXT`, (err) => {
        if (err) console.error('❌ Failed to add hour_7_resolved_to:', err);
      });
    }
    
    if (!columnNames.includes('hour_6_override')) {
      db.run(`ALTER TABLE v3_gold_log ADD COLUMN hour_6_override INTEGER DEFAULT 0`, (err) => {
        if (err) console.error('❌ Failed to add hour_6_override:', err);
      });
    }
    
    if (!columnNames.includes('marker_detected')) {
      db.run(`ALTER TABLE v3_gold_log ADD COLUMN marker_detected TEXT`, (err) => {
        if (err) console.error('❌ Failed to add marker_detected:', err);
      });
    }
  });
  
  // Indexes for gold log
  db.run(`CREATE INDEX IF NOT EXISTS idx_gold_ts ON v3_gold_log(ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gold_user ON v3_gold_log(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gold_severity ON v3_gold_log(severity)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gold_decision ON v3_gold_log(decision)`);
  
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
      // Stundas 13-23 (vārdu skaitļi)
      ['trīspadsmitos', 13], ['trīspadsmit', 13], ['trīspadsmitiem', 13],
      ['četrpadsmitos', 14], ['četrpadsmit', 14], ['četrpadsmitiem', 14],
      ['piecpadsmitos', 15], ['piecpadsmit', 15], ['piecpadsmitiem', 15],
      ['sešpadsmitos', 16], ['sešpadsmit', 16], ['sešpadsmitiem', 16],
      ['septiņpadsmitos', 17], ['septiņpadsmit', 17], ['septiņpadsmitiem', 17],
      ['astoņpadsmitos', 18], ['astoņpadsmit', 18], ['astoņpadsmitiem', 18],
      ['deviņpadsmitos', 19], ['deviņpadsmit', 19], ['deviņpadsmitiem', 19],
      ['divdesmitos', 20], ['divdesmit', 20], ['divdesmitiem', 20],
      ['divdesmit viens', 21], ['divdesmit viensos', 21], ['divdesmit vienam', 21],
      ['divdesmit divi', 22], ['divdesmit divos', 22], ['divdesmit diviem', 22],
      ['divdesmit trīs', 23], ['divdesmit trijos', 23], ['divdesmit trijiem', 23],
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

      console.log(`🕐 Parser v3 parse() - nowISO: ${nowISO}, now: ${now.toISOString()}, day: ${now.getDay()} (0=Sun, 3=Wed, 5=Fri)`);
      
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

      // 4. Extract time (pass dateInfo and type for date-first precedence and contextual logic)
      const timeInfo = this.extractTime(lower, now, dateInfo.baseDate, dateInfo, type);
      
      // 5. Extract duration (for calendar events)
      const duration = this.extractDuration(lower);

      // 6. Build result
      return this.buildResult({
        type,
        text: normalized,
        lower,
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
        console.log(`📆 extractDate: found weekday "${word}" (ISO day ${targetIsoDay}), now: ${now.toISOString()}`);
        const date = this.getNextWeekday(now, targetIsoDay);
        console.log(`📆 extractDate: getNextWeekday returned: ${date.toISOString()}`);
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

    // 5. Check specific dates (7., 10. novembrī, septītajā novembrī, etc.)
    // Month names mapping
    const monthNames = {
      'janvār': 0, 'janvārī': 0,
      'februār': 1, 'februārī': 1,
      'mart': 2, 'martā': 2,
      'aprīl': 3, 'aprīlī': 3,
      'maij': 4, 'maijā': 4,
      'jūnij': 5, 'jūnijā': 5,
      'jūlij': 6, 'jūlijā': 6,
      'august': 7, 'augustā': 7,
      'septembr': 8, 'septembrī': 8,
      'oktobr': 9, 'oktobrī': 9,
      'novembr': 10, 'novembrī': 10,
      'decembr': 11, 'decembrī': 11
    };

    // Ordinal date words (septītajā, astotajā, trīspadsmitajā, etc.)
    const ordinalDates = {
      'pirmajā': 1, 'otrajā': 2, 'trešajā': 3, 'ceturtajā': 4, 'piektajā': 5,
      'sestajā': 6, 'septītajā': 7, 'astotajā': 8, 'devītajā': 9, 'desmitajā': 10,
      'vienpadsmitajā': 11, 'divpadsmitajā': 12, 'trīspadsmitajā': 13,
      'četrpadsmitajā': 14, 'piecpadsmitajā': 15, 'sešpadsmitajā': 16,
      'septiņpadsmitajā': 17, 'astoņpadsmitajā': 18, 'deviņpadsmitajā': 19,
      'divdesmitajā': 20, 'divdesmit pirmajā': 21, 'divdesmit otrajā': 22,
      'divdesmit trešajā': 23, 'divdesmit ceturtajā': 24, 'divdesmit piektajā': 25,
      'divdesmit sestajā': 26, 'divdesmit septītajā': 27, 'divdesmit astotajā': 28,
      'divdesmit devītajā': 29, 'trīsdesmitajā': 30, 'trīsdesmit pirmajā': 31
    };

    // Try numeric date pattern: "7.", "10.", "16." + month name
    // Match both full forms (novembrī, janvārī) and short forms (novembr, janvār)
    const numericDateMatch = lower.match(/(\d{1,2})\.\s*(janvār(?:ī|a)?|februār(?:ī|a)?|mart(?:ā|a)?|aprīl(?:ī|a)?|maij(?:ā|a)?|jūnij(?:ā|a)?|jūlij(?:ā|a)?|august(?:ā|a)?|septembr(?:ī|a)?|oktobr(?:ī|a)?|novembr(?:ī|a)?|decembr(?:ī|a)?)/i);
    if (numericDateMatch) {
      const day = parseInt(numericDateMatch[1], 10);
      const monthName = numericDateMatch[2].toLowerCase();
      
      // Find matching month - check direct match first, then find key that monthName starts with
      let month = monthNames[monthName];
      if (month === undefined) {
        // Try to find a key that monthName starts with (e.g., "novembr" should match "novembr" or "novembrī")
        const matchingKey = Object.keys(monthNames).find(k => monthName.startsWith(k) || k.startsWith(monthName));
        if (matchingKey) {
          month = monthNames[matchingKey];
        }
      }

      if (month !== undefined && day >= 1 && day <= 31) {
        const cur = new Date(now);
        let targetDate = new Date(cur.getFullYear(), month, day, 0, 0, 0, 0);

        // PAST-DRIFT GUARD: Ja absolūts datums iznāk pagātnē, nepieņem automātiski
        // Feature flag: ABSOLUTE_DATE_FIRST
        if (ABSOLUTE_DATE_FIRST && targetDate < cur) {
          // Ja frāzē "šogad/šomēnes" → atstāj šogad
          const hasThisYear = /šogad|šomēnes/i.test(lower);
          if (hasThisYear) {
            // Keep this year (might be future date this year)
            console.log(`📆 Past-drift guard: "šogad/šomēnes" detected, keeping this year`);
          } else {
            // Citādi prefer next year
            targetDate.setFullYear(cur.getFullYear() + 1);
            console.log(`📆 Past-drift guard: date in past, moving to next year: ${targetDate.toISOString()}`);
          }
        } else if (targetDate < cur) {
          // Fallback: move to next year if no flag
          targetDate.setFullYear(cur.getFullYear() + 1);
        }

        console.log(`📆 Numeric date parsed: day=${day}, monthName="${monthName}", monthNum=${month}, result=${targetDate.toISOString()}`);
        return {
          baseDate: targetDate,
          type: 'specific_date',
          day,
          month
        };
      }
    }

    // Try ordinal date pattern: "septītajā", "trīspadsmitajā" + month name
    // IMPORTANT: Ordinals = datuma dienas, NE minūtes (piecpadsmitajā = 15. diena, ne 15 minūtes)
    for (const [ordinal, day] of Object.entries(ordinalDates)) {
      if (lower.includes(ordinal)) {
        // Find month name after ordinal
        for (const [monthKey, month] of Object.entries(monthNames)) {
          if (lower.includes(monthKey)) {
            const cur = new Date(now);
            let targetDate = new Date(cur.getFullYear(), month, day, 0, 0, 0, 0);

            // PAST-DRIFT GUARD: Ja absolūts datums iznāk pagātnē, nepieņem automātiski
            // Feature flag: ABSOLUTE_DATE_FIRST
            if (ABSOLUTE_DATE_FIRST && targetDate < cur) {
              // Ja frāzē "šogad/šomēnes" → atstāj šogad
              const hasThisYear = /šogad|šomēnes/i.test(lower);
              if (hasThisYear) {
                // Keep this year (might be future date this year)
                console.log(`📆 Past-drift guard (ordinal): "šogad/šomēnes" detected, keeping this year`);
              } else {
                // Citādi prefer next year
                targetDate.setFullYear(cur.getFullYear() + 1);
                console.log(`📆 Past-drift guard (ordinal): date in past, moving to next year: ${targetDate.toISOString()}`);
              }
            } else if (targetDate < cur) {
              // Fallback: move to next year if no flag
              targetDate.setFullYear(cur.getFullYear() + 1);
            }

            console.log(`📆 extractDate: found ordinal date "${ordinal} ${monthKey}" → ${targetDate.toISOString()} (day=${day}, NOT minutes)`);
            return {
              baseDate: targetDate,
              type: 'specific_date',
              day,
              month
            };
          }
        }
      }
    }

    // 6. Default to today
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

    console.log(`🔄 getNextWeekday: current=${cur.toISOString()}, curDay=${cur.getDay()}, curIsoDay=${curIsoDay}, targetIsoDay=${targetIsoDay}`);

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

    console.log(`🔄 getNextWeekday: offset=${offset}, result will be ${cur.getDate() + offset} ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][cur.getDay()]}`);

    const result = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + offset, 0, 0, 0);
    return result;
  }

  extractTime(lower, now, baseDate, dateInfo = null, type = null) {
    const result = {
      hasExplicitTime: false,
      start: null,
      end: null,
      hour: null,
      minute: 0
    };

    // DATE-FIRST PRECEDENCE: Check if we have a specific date with numeric day
    // If dateInfo.type === 'specific_date', block any numeric hour parsing that could conflict
    // (e.g., "23. decembra" should NOT parse "23" as hour)
    const hasSpecificDate = dateInfo && (dateInfo.type === 'specific_date' || dateInfo.day);
    const dateDayNumber = hasSpecificDate ? (dateInfo.day || null) : null;

    // Helper: Apply PM conversion based on day-part context and HOUR_DEFAULTS_V1 policy
    // Returns: { hour, minute, rolloverDay?, am_pm_decision? }
    // New signature: needs dateInfo and type for contextual 7 o'clock logic
    const applyPMConversion = (hour, minute, lower, dateInfo = null, type = null) => {
      const originalHour = hour;
      let amPmDecision = null;
      
      // Lexicon for context detection
      const morningMarkers = /no rīta|rītos|rīta|agrā rīta|agri no rīta|brokast/i;
      const eveningMarkers = /vakarā|vēlu vakarā|vakariņas|vakariņu/i;
      const nightMarkers = /naktī|naktīs/i;
      const afternoonMarkers = /pēcpusdienā|pēc pusdienas|pēcpusdien/i;
      const businessWords = /sapulce|tikšanās|klients|banka|ārsts|vizīte|prezentācija|meeting|konference/i;
      const leisureWords = /kino|vakariņas|restorān|koncert|dzimšanas diena|ballīte|svētki/i;
      
      // Check for day-part markers (HIGHEST PRIORITY - step 0)
      const hasMorningMarker = morningMarkers.test(lower);
      const hasEveningMarker = eveningMarkers.test(lower);
      const hasNightMarker = nightMarkers.test(lower);
      const hasAfternoonMarker = afternoonMarkers.test(lower);
      
      // Check for relative date words
      const hasRīt = /\brīt\b/i.test(lower) && !hasMorningMarker; // "rīt" without "no rīta"
      const hasŠodien = /\bšodien\b/i.test(lower);
      
      // Check for intent type (reminder vs calendar)
      const isReminder = type === 'reminder' || /atgādin/i.test(lower);
      const isCalendar = type === 'calendar' || /tikšanās|sapulce|meeting/i.test(lower);
      
      // Validate hour is in valid range
      if (hour < 0 || hour > 23) {
        console.error(`❌ applyPMConversion: invalid hour ${hour}, keeping as is`);
        return { hour, minute, am_pm_decision: 'invalid' };
      }
      
      // STEP 0: Markers override everything (highest priority)
      if (hasNightMarker && hour >= 1 && hour < 12) {
        const newHour = hour + 12;
        amPmDecision = 'night_marker_override';
        telemetry.marker_detected = 'night';
        if (hour === 7) telemetry.hour_7_resolved_to = 'PM';
        console.log(`🔍 PM conversion: night marker OVERRIDE - ${hour} → ${newHour} (${hour} PM)`);
        return { hour: newHour, minute, am_pm_decision: amPmDecision, telemetry };
      }
      
      if (hasEveningMarker && hour >= 1 && hour < 12) {
        const newHour = hour + 12;
        amPmDecision = 'evening_marker_override';
        telemetry.marker_detected = 'evening';
        if (hour === 7) telemetry.hour_7_resolved_to = 'PM';
        console.log(`🔍 PM conversion: evening marker OVERRIDE - ${hour} → ${newHour} (${hour} PM)`);
        return { hour: newHour, minute, am_pm_decision: amPmDecision, telemetry };
      }
      
      if (hasAfternoonMarker && hour >= 1 && hour < 12) {
        const newHour = hour + 12;
        amPmDecision = 'afternoon_marker_override';
        telemetry.marker_detected = 'afternoon';
        if (hour === 7) telemetry.hour_7_resolved_to = 'PM';
        console.log(`🔍 PM conversion: afternoon marker - ${hour} → ${newHour} (${hour} PM)`);
        return { hour: newHour, minute, am_pm_decision: amPmDecision, telemetry };
      }
      
      if (hasMorningMarker) {
        telemetry.marker_detected = 'morning';
        // Morning marker: 1-11 stay AM, 6 and 7 become 06:00/07:00
        if (hour === 6) {
          amPmDecision = 'morning_marker_6am';
          telemetry.hour_6_override = true; // 6 → 06:00 (override default 18:00)
          console.log(`🔍 PM conversion: morning marker - 6 → 06:00 (AM)`);
          return { hour: 6, minute, am_pm_decision: amPmDecision, telemetry };
        }
        if (hour === 7) {
          amPmDecision = 'morning_marker_7am';
          telemetry.hour_7_resolved_to = 'AM';
          console.log(`🔍 PM conversion: morning marker - 7 → 07:00 (AM)`);
          return { hour: 7, minute, am_pm_decision: amPmDecision, telemetry };
        }
        // Other hours stay AM
        amPmDecision = 'morning_marker_keep_am';
        console.log(`🔍 PM conversion: morning marker - keeping ${hour} (AM)`);
        return { hour, minute, am_pm_decision: amPmDecision, telemetry };
      }
      
      // No markers detected
      telemetry.marker_detected = 'none';
      
      // STEP 1: Apply HOUR_DEFAULTS_V1 policy (if enabled and no markers)
      if (HOUR_DEFAULTS_V1 && !hasMorningMarker && !hasEveningMarker && !hasNightMarker && !hasAfternoonMarker) {
        // 1.1. Hours 1-6 → 13:00-18:00 (day/evening default)
        if (hour >= 1 && hour <= 6) {
          const newHour = hour + 12;
          amPmDecision = 'hour_defaults_v1_1to6_pm';
          // Note: hour 6 default is 18:00, so hour_6_override = false
          console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - ${hour} → ${newHour} (${hour} PM, day/evening default)`);
          return { hour: newHour, minute, am_pm_decision: amPmDecision, telemetry };
        }
        
        // 1.2. Hour 7 → contextual (special case)
        if (hour === 7) {
          // Rule 1: "rīt septiņos" → 07:00
          if (hasRīt) {
            amPmDecision = 'hour_defaults_v1_7_rīt_am';
            telemetry.hour_7_resolved_to = 'AM';
            console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - 7 → 07:00 (AM, "rīt" context)`);
            return { hour: 7, minute, am_pm_decision: amPmDecision, telemetry };
          }
          
          // Rule 2: "šodien septiņos" → 19:00 (if no morning marker)
          if (hasŠodien && !hasMorningMarker) {
            amPmDecision = 'hour_defaults_v1_7_šodien_pm';
            telemetry.hour_7_resolved_to = 'PM';
            console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - 7 → 19:00 (PM, "šodien" context)`);
            return { hour: 19, minute, am_pm_decision: amPmDecision, telemetry };
          }
          
          // Rule 3: Business words without "no rīta" → 07:00 (business meetings rarely at 19:00)
          if (businessWords.test(lower) && !hasMorningMarker) {
            amPmDecision = 'hour_defaults_v1_7_business_am';
            telemetry.hour_7_resolved_to = 'AM';
            console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - 7 → 07:00 (AM, business context)`);
            return { hour: 7, minute, am_pm_decision: amPmDecision, telemetry };
          }
          
          // Rule 4: Leisure words → 19:00
          if (leisureWords.test(lower)) {
            amPmDecision = 'hour_defaults_v1_7_leisure_pm';
            telemetry.hour_7_resolved_to = 'PM';
            console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - 7 → 19:00 (PM, leisure context)`);
            return { hour: 19, minute, am_pm_decision: amPmDecision, telemetry };
          }
          
          // Rule 5: Reminder intent → 07:00 (reminders often set for morning)
          if (isReminder) {
            amPmDecision = 'hour_defaults_v1_7_reminder_am';
            telemetry.hour_7_resolved_to = 'AM';
            console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - 7 → 07:00 (AM, reminder intent)`);
            return { hour: 7, minute, am_pm_decision: amPmDecision, telemetry };
          }
          
          // Rule 6: Calendar with business context → 07:00
          if (isCalendar && businessWords.test(lower)) {
            amPmDecision = 'hour_defaults_v1_7_calendar_business_am';
            telemetry.hour_7_resolved_to = 'AM';
            console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - 7 → 07:00 (AM, calendar business)`);
            return { hour: 7, minute, am_pm_decision: amPmDecision, telemetry };
          }
          
          // Default for hour 7: if no context, prefer AM (safer)
          amPmDecision = 'hour_defaults_v1_7_default_am';
          telemetry.hour_7_resolved_to = 'AM';
          console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - 7 → 07:00 (AM, default)`);
          return { hour: 7, minute, am_pm_decision: amPmDecision, telemetry };
        }
        
        // 1.3. Hours 8-11 → AM (08:00-11:00)
        if (hour >= 8 && hour < 12) {
          amPmDecision = 'hour_defaults_v1_8to11_am';
          console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - keeping ${hour} (AM, day time)`);
          return { hour, minute, am_pm_decision: amPmDecision, telemetry };
        }
        
        // 1.4. Hour 12 → 12:00 (noon)
        if (hour === 12) {
          amPmDecision = 'hour_defaults_v1_12_noon';
          console.log(`🔍 PM conversion: HOUR_DEFAULTS_V1 - 12 → 12:00 (noon)`);
          return { hour: 12, minute, am_pm_decision: amPmDecision, telemetry };
        }
      }
      
      // STEP 2: Fallback to old DAY_EVENING_DEFAULT logic (if HOUR_DEFAULTS_V1 is off)
      if (!HOUR_DEFAULTS_V1 && DAY_EVENING_DEFAULT && !hasMorningMarker && !hasEveningMarker && !hasNightMarker && !hasAfternoonMarker) {
        const hasNoMorning = !morningMarkers.test(lower);
        const hasNoNight = !nightMarkers.test(lower);
        
        if (hasNoMorning && hasNoNight) {
          if (hour >= 1 && hour <= 7) {
            const newHour = hour + 12;
            amPmDecision = 'day_evening_default_pm';
            console.log(`🔍 PM conversion: day/evening default (legacy) - ${hour} → ${newHour} (${hour} PM)`);
            return { hour: newHour, minute, am_pm_decision: amPmDecision };
          }
          if (hour >= 8 && hour < 12) {
            amPmDecision = 'day_evening_default_am';
            console.log(`🔍 PM conversion: day/evening default (legacy) - keeping ${hour} (AM)`);
            return { hour, minute, am_pm_decision: amPmDecision };
          }
        }
      }
      
      // STEP 3: Edge cases
      // "divpadsmitos vakarā" → midnight (00:00 next day)
      if (hasEveningMarker && hour === 12) {
        amPmDecision = 'midnight_rollover';
        console.log(`🔍 PM conversion: 12 vakarā → midnight (00:00 next day)`);
        return { hour: 0, minute, rolloverDay: true, am_pm_decision: amPmDecision };
      }
      
      // STEP 4: Default - keep hour as is
      const hourLabel = hour === 0 ? 'midnight' : hour === 12 ? 'noon' : hour < 12 ? 'AM' : '24h';
      amPmDecision = hour === 0 ? 'midnight' : hour === 12 ? 'noon' : hour < 12 ? 'default_am' : 'default_24h';
      console.log(`🔍 PM conversion: default - keeping hour=${hour} (${hourLabel})`);
      return { hour, minute, am_pm_decision: amPmDecision, telemetry };
    };

    // 0. FIRST: Check dynamic relative time patterns (pēc X minūtēm/stundām) - HIGHEST priority
    const relMinMatch = lower.match(/pēc\s+(\d+)\s*min/);
    const relHourMatch = lower.match(/pēc\s+(\d+)\s*stund/);
    const relWordMatch = lower.match(/pēc\s+(pusotras|stundas|pusstundas)/);
    // Word-based minutes: "pēc desmit minūtēm", "pēc divdesmit minūtēm"
    const relMinWordMatch = lower.match(/pēc\s+(pieci|desmit|piecpadsmit|divdesmit|divdesmit\s+pieci|trīsdesmit|četrdesmit|piecdesmit)\s*min/);
    // Word-based hours: "pēc divām stundām", "pēc trim stundām"
    const relHourWordMatch = lower.match(/pēc\s+(vienas?|divām|trim|četrām|piecām)\s*stund/);

    if (relMinMatch || relHourMatch || relWordMatch || relMinWordMatch || relHourWordMatch) {
      let offsetMs = 0;

      if (relMinMatch) {
        const mins = parseInt(relMinMatch[1], 10);
        offsetMs = mins * 60 * 1000;
        console.log(`🔍 extractTime: dynamic relative time - +${mins} minutes (numeric)`);
      } else if (relMinWordMatch) {
        // Convert word to number
        const word = relMinWordMatch[1].replace(/\s+/g, ' '); // normalize spaces
        const minuteMap = {
          'pieci': 5, 'desmit': 10, 'piecpadsmit': 15, 'divdesmit': 20,
          'divdesmit pieci': 25, 'trīsdesmit': 30, 'četrdesmit': 40, 'piecdesmit': 50
        };
        const mins = minuteMap[word] || 10;
        offsetMs = mins * 60 * 1000;
        console.log(`🔍 extractTime: dynamic relative time - "${word}" = +${mins} minutes (word)`);
      } else if (relHourMatch) {
        const hours = parseInt(relHourMatch[1], 10);
        offsetMs = hours * 60 * 60 * 1000;
        console.log(`🔍 extractTime: dynamic relative time - +${hours} hours (numeric)`);
      } else if (relHourWordMatch) {
        // Convert word to number
        const word = relHourWordMatch[1];
        const hourMap = {
          'vienas': 1, 'viena': 1, 'divām': 2, 'trim': 3, 'četrām': 4, 'piecām': 5
        };
        const hours = hourMap[word] || 1;
        offsetMs = hours * 60 * 60 * 1000;
        console.log(`🔍 extractTime: dynamic relative time - "${word}" = +${hours} hours (word)`);
      } else if (relWordMatch) {
        const word = relWordMatch[1];
        const mins = word === 'pusstundas' ? 30 : word === 'pusotras' ? 90 : 60;
        offsetMs = mins * 60 * 1000;
        console.log(`🔍 extractTime: dynamic relative time - ${word} = +${mins} minutes`);
      }

      const futureDate = new Date(now.getTime() + offsetMs);
      const endDate = new Date(futureDate.getTime() + 60 * 60 * 1000); // +1h default duration

      return {
        hasExplicitTime: true,
        start: futureDate,
        end: endDate,
        hour: futureDate.getHours(),
        minute: futureDate.getMinutes(),
        isRelativeTime: true
      };
    }

    // 1. SECOND: Check interval (no 9 līdz 11 OR no diviem līdz četriem)
    // Try numeric interval first
    let intervalMatch = lower.match(/no\s+(\d{1,2})(?::(\d{2}))?\s+līdz\s+(\d{1,2})(?::(\d{2}))?/);
    let sh = null, sm = 0, eh = null, em = 0;
    
    if (intervalMatch) {
      sh = parseInt(intervalMatch[1], 10);
      sm = intervalMatch[2] ? parseInt(intervalMatch[2], 10) : 0;
      eh = parseInt(intervalMatch[3], 10);
      em = intervalMatch[4] ? parseInt(intervalMatch[4], 10) : 0;
    } else {
      // Try word-based interval (no diviem līdz četriem)
      const intervalWordMatch = lower.match(/no\s+(\w+)\s+līdz\s+(\w+)/);
      if (intervalWordMatch) {
        const startWord = intervalWordMatch[1];
        const endWord = intervalWordMatch[2];
        
        // Find hour words for start and end
        for (const [word, value] of this.hourWords) {
          if (startWord.includes(word) || word.includes(startWord)) {
            sh = value;
            break;
          }
        }
        for (const [word, value] of this.hourWords) {
          if (endWord.includes(word) || word.includes(endWord)) {
            eh = value;
            break;
          }
        }
        
        // If both found, treat as interval
        if (sh !== null && eh !== null) {
          console.log(`🔍 extractTime: found word interval - start=${sh}, end=${eh}`);
        } else {
          sh = null;
          eh = null;
        }
      }
    }
    
    if (sh !== null && eh !== null) {
      // INTERVĀLU LOĢIKA: Ja abi gali < 8 un nav daypart → abiem +12h
      // Ja start < end < 12 un nav daypart → atstāj AM
      // D. FIX: "no desmitiem līdz diviem" → beigas kā 14:00, nevis 02:00
      const hasDaypart = /(no rīta|rītos|vakarā|naktī|pusdienlaikā|pēcpusdienā)/i.test(lower);
      
      // Ja abi gali < 8 un nav daypart → abiem +12h (piem., "no diviem līdz četriem" → 14:00–16:00)
      if (sh >= 1 && sh < 8 && eh >= 1 && eh < 8 && !hasDaypart) {
        console.log(`🔍 Interval: both ends < 8 and no daypart → +12h: ${sh}→${sh+12}, ${eh}→${eh+12}`);
        sh = sh + 12;
        eh = eh + 12;
      }
      // Ja viens gals < 8 un nav daypart → +12h tikai tam (piem., "no desmitiem līdz diviem" → 10:00–14:00)
      else if (!hasDaypart) {
        if (sh >= 1 && sh < 8 && eh >= 8) {
          // Start < 8, end >= 8 → +12h tikai start
          console.log(`🔍 Interval: start < 8, end >= 8, no daypart → +12h to start: ${sh}→${sh+12}, ${eh}→${eh}`);
          sh = sh + 12;
        } else if (eh >= 1 && eh < 8 && sh >= 8) {
          // End < 8, start >= 8 → +12h tikai end (piem., "no desmitiem līdz diviem" → 10:00–14:00)
          console.log(`🔍 Interval: end < 8, start >= 8, no daypart → +12h to end: ${sh}→${sh}, ${eh}→${eh+12}`);
          eh = eh + 12;
        }
      }
      // Ja start < end < 12 un nav daypart → atstāj AM (piem., "no desmitiem līdz vienpadsmitiem" → 10:00–11:00)
      else if (sh >= 8 && sh < 12 && eh >= 8 && eh < 12 && sh < eh && !hasDaypart) {
        console.log(`🔍 Interval: start < end < 12 and no daypart → keep AM: ${sh}:00–${eh}:00`);
        // Keep as is (AM)
      }
      
      // Apply PM conversion to interval times
      const startConverted = applyPMConversion(sh, sm, lower, dateInfo, type);
      const endConverted = applyPMConversion(eh, em, lower, dateInfo, type);
      
      // Store am_pm_decision and telemetry (use start's decision/telemetry)
      result._am_pm_decision = startConverted.am_pm_decision || endConverted.am_pm_decision || null;
      result._telemetry = startConverted.telemetry || endConverted.telemetry || null;
      
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
        isInterval: true,
        _am_pm_decision: result._am_pm_decision,
        _telemetry: result._telemetry
      };
    }

    // 2. SECOND: Check numeric time (HH:MM) - higher priority than day-parts
    const timeMatch = lower.match(/\b(\d{1,2}):(\d{2})\b/);
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10);
      const m = parseInt(timeMatch[2], 10);
      
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        // BUSINESS DEFAULT: weekday + meeting activity + early hour (1-7) + no daypart → PM
        // Feature flag: WEEKDAY_EARLY_PM
        const isWeekdayNum = dateInfo && dateInfo.type === 'weekday';
        const isMeetingActivityNum = /(tikšanās|sapulce|zoom|prezentācija|meeting|konference|teātris|koncerts|pasākums)/i.test(lower);
        const isEarlyHourNum = h >= 1 && h <= 7;
        const hasDaypartNum = /(no rīta|rītos|vakarā|naktī|pusdienlaikā|pēcpusdienā)/i.test(lower);
        let businessDefaultAppliedNum = false;
        
        if (WEEKDAY_EARLY_PM && isWeekdayNum && isMeetingActivityNum && isEarlyHourNum && !hasDaypartNum) {
          const newHour = h + 12;
          businessDefaultAppliedNum = true;
          console.log(`🔍 Business default: weekday + meeting + early hour (${h}) + no daypart → ${newHour} (${h} PM)`);
          h = newHour;
        }
        
        // Apply PM conversion based on day-part context
        const converted = applyPMConversion(h, m, lower, dateInfo, type);
        h = converted.hour;
        
          // Store am_pm_decision and telemetry
          if (businessDefaultAppliedNum) {
            result._am_pm_decision = 'business_default_pm';
          } else {
            result._am_pm_decision = converted.am_pm_decision || null;
          }
          result._telemetry = converted.telemetry || null;
        
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
    // IMPORTANT: Block if this number matches a date day (date-first precedence)
    // B. FIX: "12." jūk starp dienu un 12:00 - bloķēt, ja tas ir datuma daļa
    if (!timeMatch) {
      const hourMatch = lower.match(/\b(\d{1,2})\b/);
      if (hourMatch) {
        let h = parseInt(hourMatch[1], 10);
        
        // DATE-FIRST PRECEDENCE: If we have a specific date and this number matches the day, skip it
        // (e.g., "23. decembra" → "23" is the day, not hour 23:00)
        // (e.g., "12. novembrī" → "12" is the day, not hour 12:00)
        // B. FIX: Also check if "12." is followed by month name (e.g., "12. novembrī")
        // Check if "12." is part of a date pattern (12. + month name) - even if not yet parsed as specific_date
        const isDatePattern = h === 12 && lower.match(/\b12\.\s*(janvār|februār|mart|aprīl|maij|jūnij|jūlij|august|septembr|oktobr|novembr|decembr)/i);
        
        if (hasSpecificDate && dateDayNumber !== null && h === dateDayNumber) {
          console.log(`🔍 extractTime: blocking hour=${h} (matches date day ${dateDayNumber} - date-first precedence)`);
          // Skip this match - it's part of the date, not a time
        } else if (isDatePattern) {
          console.log(`🔍 extractTime: blocking hour=12 (matches date pattern "12. [month]" - date-first precedence)`);
          // Skip this match - it's part of the date, not a time
        } else if (h >= 0 && h <= 23) {
          // BUSINESS DEFAULT: weekday + meeting activity + early hour (1-7) + no daypart → PM
          // Feature flag: WEEKDAY_EARLY_PM
          const isWeekdaySingle = dateInfo && dateInfo.type === 'weekday';
          const isMeetingActivitySingle = /(tikšanās|sapulce|zoom|prezentācija|meeting|konference|teātris|koncerts|pasākums)/i.test(lower);
          const isEarlyHourSingle = h >= 1 && h <= 7;
          const hasDaypartSingle = /(no rīta|rītos|vakarā|naktī|pusdienlaikā|pēcpusdienā)/i.test(lower);
          let businessDefaultAppliedSingle = false;
          
          if (WEEKDAY_EARLY_PM && isWeekdaySingle && isMeetingActivitySingle && isEarlyHourSingle && !hasDaypartSingle) {
            const newHour = h + 12;
            businessDefaultAppliedSingle = true;
            console.log(`🔍 Business default: weekday + meeting + early hour (${h}) + no daypart → ${newHour} (${h} PM)`);
            h = newHour;
          }
          
          // Apply PM conversion based on day-part context
          const converted = applyPMConversion(h, 0, lower, dateInfo, type);
          h = converted.hour;
          
          // Store am_pm_decision and telemetry
          if (businessDefaultAppliedSingle) {
            result._am_pm_decision = 'business_default_pm';
          } else {
            result._am_pm_decision = converted.am_pm_decision || null;
          }
          result._telemetry = converted.telemetry || null;
          
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
      
        // BUSINESS DEFAULT: weekday + meeting activity + early hour (1-7) + no daypart → PM
        // (e.g., "Pirmdien divos Zoom tikšanās" → 14:00, not 02:00)
        // Feature flag: WEEKDAY_EARLY_PM
        const isWeekday = dateInfo && dateInfo.type === 'weekday';
        const isMeetingActivity = /(tikšanās|sapulce|zoom|prezentācija|meeting|konference|teātris|koncerts|pasākums)/i.test(lower);
        const isEarlyHour = h >= 1 && h <= 7;
        const hasDaypart = /(no rīta|rītos|vakarā|naktī|pusdienlaikā|pēcpusdienā)/i.test(lower);
        let businessDefaultApplied = false;
        
        if (WEEKDAY_EARLY_PM && isWeekday && isMeetingActivity && isEarlyHour && !hasDaypart) {
          const newHour = h + 12;
          businessDefaultApplied = true;
          console.log(`🔍 Business default: weekday + meeting + early hour (${h}) + no daypart → ${newHour} (${h} PM)`);
          h = newHour;
        }
      
      // Apply PM conversion based on day-part context
      const converted = applyPMConversion(h, m, lower, dateInfo, type);
      const originalH = h;
      h = converted.hour;
      m = converted.minute;
      
      // Store am_pm_decision and telemetry (override with business_default if applied)
      if (businessDefaultApplied) {
        result._am_pm_decision = 'business_default_pm';
      } else {
        result._am_pm_decision = converted.am_pm_decision || null;
      }
      result._telemetry = converted.telemetry || null;
      
      console.log(`🔍 PM conversion: original=${originalH}, context="${lower}", after=${h}, rolloverDay=${converted.rolloverDay || false}, am_pm_decision=${result._am_pm_decision}`);
      
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
    let foundHourWord = null;
    
    // Check hour words - but skip if followed by "minūtēm" (e.g., "desmit minūtēm" = minutes, not hours)
    // EXCEPTION: if preceded by "pēc" (e.g., "pēc desmit minūtēm"), don't skip - it's relative time
    for (const [word, value] of this.hourWords) {
      if (lower.includes(word)) {
        // Check if this word is part of "X minūtēm" pattern (minutes, not hours)
        const wordIndex = lower.indexOf(word);
        const afterWord = lower.substring(wordIndex + word.length);
        const beforeWord = lower.substring(0, wordIndex);

        // If "minūtēm" appears after word AND "pēc" is NOT before it, skip it
        if (/^\s*minūt(ēm|ēs|u)/.test(afterWord)) {
          // Check if "pēc" precedes this pattern (relative time)
          if (/pēc\s*$/.test(beforeWord)) {
            // This is "pēc X minūtēm" - don't skip, let relative time handler deal with it
            console.log(`🔍 extractWordTime: found "pēc ${word} minūtēm" - skipping (relative time pattern)`);
            continue;
          }
          console.log(`🔍 extractWordTime: skipping hour word "${word}" (part of "X minūtēm" pattern)`);
          continue;
        }
        h = value;
        foundHourWord = word;
        console.log(`🔍 extractWordTime: found hour word "${word}" = ${value} in "${lower}"`);
        break;
      }
    }
    
    // Check minute words (only if hour found)
    // BUT: ignore minute words that are part of the hour word (e.g., "desmit" in "desmitos")
    if (h !== null) {
      for (const [word, value] of this.minuteWords) {
        // Skip if this minute word is contained in the hour word (e.g., "desmit" in "desmitos")
        if (foundHourWord && foundHourWord.includes(word)) {
          console.log(`🔍 extractWordTime: skipping minute word "${word}" (part of hour word "${foundHourWord}")`);
          continue;
        }
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
    
    // Get date parts in Europe/Riga timezone
    const tz = "Europe/Riga";
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit"
    });
    const partsArr = dtf.formatToParts(baseDate);
    const parts = Object.fromEntries(partsArr.map(p => [p.type, p.value]));
    
    // Get current offset for this date in Europe/Riga
    const offsetDtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      timeZoneName: "shortOffset"
    });
    const offsetParts = offsetDtf.formatToParts(baseDate);
    const offsetStr = offsetParts.find(p => p.type === 'timeZoneName')?.value || '+02:00';
    
    // Normalize offset to +HH:MM format
    const offsetMatch = offsetStr.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    let offset = '+02:00'; // Default
    if (offsetMatch) {
      const sign = offsetMatch[1];
      const hours = offsetMatch[2].padStart(2, '0');
      const minutes = offsetMatch[3] || '00';
      offset = `${sign}${hours}:${minutes}`;
    }
    
    // Create ISO string with specified hour/minute in Europe/Riga timezone
    const dateStr = `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`;
    
    // Parse the ISO string (this will create a Date object representing the correct time)
    const date = new Date(dateStr);
    
    // Validate result
    if (isNaN(date.getTime())) {
      console.error('❌ setTime: invalid result date, hour:', hour, 'minute:', minute, 'baseDate:', baseDate);
      return new Date(); // Fallback to now
    }
    
    return date;
  }

  /**
   * Clean reminder text for display - removes meta-info, keeps action
   * @param {string} text - Original user intent text
   * @returns {string} - Cleaned display text
   */
  cleanReminderText(text) {
    if (!text || typeof text !== 'string') return text;
    
    let cleaned = text.trim();
    const original = cleaned;
    
    // Extract deadline info (līdz X) before removing dates
    let deadlineInfo = null;
    const deadlineMatch = cleaned.match(/\blīdz\s+(\d{1,2}\.\s*(?:janvār|februār|mart|aprīl|maij|jūnij|jūlij|august|septembr|oktobr|novembr|decembr)(?:ī|a|ā)?|\d{1,2}\.\d{1,2}\.|\d{1,2}\.\s*\d{1,2})/i);
    if (deadlineMatch) {
      // Format deadline: "15. novembrī" → "15.11." or "15.11" → "15.11."
      let deadline = deadlineMatch[1].trim();
      // If it's "15. novembrī", convert to "15.11."
      const monthNames = {
        'janvār': '01', 'janvārī': '01', 'janvāra': '01',
        'februār': '02', 'februārī': '02', 'februāra': '02',
        'mart': '03', 'martā': '03', 'marta': '03',
        'aprīl': '04', 'aprīlī': '04', 'aprīla': '04',
        'maij': '05', 'maijā': '05', 'maija': '05',
        'jūnij': '06', 'jūnijā': '06', 'jūnija': '06',
        'jūlij': '07', 'jūlijā': '07', 'jūlija': '07',
        'august': '08', 'augustā': '08', 'augusta': '08',
        'septembr': '09', 'septembrī': '09', 'septembra': '09',
        'oktobr': '10', 'oktobrī': '10', 'oktobra': '10',
        'novembr': '11', 'novembrī': '11', 'novembra': '11',
        'decembr': '12', 'decembrī': '12', 'decembra': '12'
      };
      const monthMatch = deadline.match(/(\d{1,2})\.\s*([a-zāēīūō]+)/i);
      if (monthMatch) {
        const day = monthMatch[1];
        const monthName = monthMatch[2].toLowerCase();
        const monthNum = monthNames[monthName];
        if (monthNum) {
          deadline = `${day}.${monthNum}.`;
        }
      } else if (!deadline.endsWith('.')) {
        deadline = deadline + '.';
      }
      deadlineInfo = deadline;
    }
    
    // 1. Remove reminder keywords (atgādini, atgādinājums, etc.)
    cleaned = cleaned.replace(/\b(atgādini|atgādinājums|atgādināt|atgādinājumu|atgādiniet|atgādināšu|atgādināsim|atgādināju|atgādināja)\b/gi, '');
    
    // 2. Remove relative time phrases (pēc X minūtēm/stundām/dienām)
    cleaned = cleaned.replace(/\bpēc\s+(\d+|vienas?|divām|trim|četrām|piecām|sešām|septiņām|astoņām|deviņām|desmit|vienpadsmit|divpadsmit|trīspadsmit|četrpadsmit|piecpadsmit|sešpadsmit|septiņpadsmit|astoņpadsmit|deviņpadsmit|divdesmit)\s+(minūtēm|min|stundām|stundas|dienām|dienas|stundu|dienu)\b/gi, '');
    
    // 3. Remove relative dates (rīt, parīt, šodien, vakar) - these are trigger conditions
    cleaned = cleaned.replace(/\b(rīt|rītdien|parīt|parītdien|šodien|vakar|nākamnedēļ|nākamajā nedēļā)\b/gi, '');
    
    // 4. Remove weekdays (trešdien, pirmdien, etc.) - trigger conditions
    cleaned = cleaned.replace(/\b(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien)(a|u|ā)?\b/gi, '');
    
    // 5. Remove absolute time markers (pulksten, plkst., etc.)
    cleaned = cleaned.replace(/\b(pulksten|pulkstenis|pulkstens|plkst\.?|pl\.)\b/gi, '');
    
    // 6. Remove numeric times (HH:MM, HH.MM, 10.00, etc.)
    cleaned = cleaned.replace(/\b\d{1,2}[.:]\d{2}\b/g, '');
    cleaned = cleaned.replace(/\b\d{1,2}\.\d{2}\b/g, ''); // 10.00 format
    
    // 7. Remove time words (desmitos, divos, trijos, etc.)
    const timeWordPattern = /\b(vienā|divos|trijos|četros|piecos|sešos|septiņos|astoņos|deviņos|desmitos|vienpadsmitos|divpadsmitos|vienam|diviem|trijiem|četriem|pieciem|sešiem|septiņiem|astoņiem|deviņiem|desmitiem|vienpadsmitiem|divpadsmitiem)\b/gi;
    cleaned = cleaned.replace(timeWordPattern, '');
    
    // 8. Remove specific numeric dates (15. novembrī, 2025-11-15) - but keep if part of "līdz" phrase
    // First, mark "līdz X" phrases to preserve
    const līdzPattern = /\blīdz\s+(\d{1,2}\.\s*(?:janvār|februār|mart|aprīl|maij|jūnij|jūlij|august|septembr|oktobr|novembr|decembr)(?:ī|a|ā)?|\d{1,2}\.\d{1,2}\.|\d{1,2}\.\s*\d{1,2})/gi;
    const līdzMatches = [...cleaned.matchAll(līdzPattern)];
    // Temporarily replace "līdz X" with placeholder
    let placeholderIndex = 0;
    const placeholders = [];
    cleaned = cleaned.replace(līdzPattern, (match) => {
      const placeholder = `__LIDZ_PLACEHOLDER_${placeholderIndex}__`;
      placeholders.push(match);
      placeholderIndex++;
      return placeholder;
    });
    
    // Now remove dates
    cleaned = cleaned.replace(/\b\d{1,2}\.\s*(janvār|februār|mart|aprīl|maij|jūnij|jūlij|august|septembr|oktobr|novembr|decembr)(ī|a|ā)?\b/gi, '');
    cleaned = cleaned.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '');
    cleaned = cleaned.replace(/\b\d{1,2}\.\s*\d{1,2}\.\b/g, ''); // 15.11. format
    
    // Restore "līdz X" placeholders (will be handled by deadlineInfo)
    placeholders.forEach((match, idx) => {
      cleaned = cleaned.replace(`__LIDZ_PLACEHOLDER_${idx}__`, '');
    });
    
    // 9. Remove helper words (man, lūdzu, etc.)
    cleaned = cleaned.replace(/\b(man|lūdzu|lūdzu,|lūdzu\.|vai|varbūt|vēlāk|tad)\b/gi, '');
    
    // 10. Remove colons/dashes after "atgādinājums:" or "atgādini -"
    cleaned = cleaned.replace(/^[:\-–—]\s*/g, '');
    cleaned = cleaned.replace(/\s*[:\-–—]\s*/g, ' ');
    
    // 11. Clean up spaces and punctuation
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/^[.,;:]\s*/g, '');
    cleaned = cleaned.replace(/\s*[.,;:]\s*$/g, '');
    
    // 12. Add deadline info in parentheses if present
    if (deadlineInfo) {
      cleaned = cleaned.replace(/\blīdz\s+/gi, ''); // Remove "līdz" word itself
      cleaned = cleaned.trim();
      if (cleaned && !cleaned.includes(`(${deadlineInfo})`)) {
        cleaned = `${cleaned} (līdz ${deadlineInfo})`;
      }
    }
    
    // 13. Final cleanup
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    // 14. Fallback: if empty or too short, return original (or less aggressive cleaning)
    if (!cleaned || cleaned.length < 3) {
      // Try less aggressive: just remove "atgādini" keywords
      let fallback = original.replace(/\b(atgādini|atgādinājums|atgādināt|atgādinājumu|atgādiniet)\b/gi, '').trim();
      fallback = fallback.replace(/^[:\-–—]\s*/g, '').trim();
      if (fallback && fallback.length >= 3) {
        cleaned = fallback;
      } else {
        cleaned = original; // Last resort: return original
      }
    }
    
    // 15. Capitalize first letter (for display)
    if (cleaned && cleaned.length > 0) {
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
    
    return cleaned;
  }

  buildResult({ type, text, lower, dateInfo, timeInfo, duration, langHint, now }) {
    // For reminders, use special cleaning that removes meta-info (atgādini, pēc X min, etc.)
    // For calendar events, use standard cleaning that keeps contextual info
    let cleanDescription;
    let semanticTagsKept = {
      relativeDate: false,
      weekday: false,
      daypart: false,
      relativeTime: false
    };
    
    if (type === 'reminder') {
      cleanDescription = this.cleanReminderText(text);
    } else {
      // Clean description - remove ONLY structured time/date info, KEEP contextual info
      cleanDescription = text;
      
      // Track what we're keeping for logging
      
      // SAGLABĀT relatīvos datumus (rīt, šodien, parīt, nākamnedēļ)
    // Check if we have relative dates - if yes, mark them to keep
    if (/\b(rīt|rītdien|šodien|parīt|parītdien|nākamnedēļ|nākamajā nedēļā)\b/gi.test(cleanDescription)) {
      semanticTagsKept.relativeDate = true;
      // Keep these words - don't remove them
    }
    
    // SAGLABĀT nedēļas dienas (pirmdien, trešdien, svētdien)
    if (/\b(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien)(a|u|ā)?\b/gi.test(cleanDescription)) {
      semanticTagsKept.weekday = true;
      // Keep these words - don't remove them
    }
    
    // SAGLABĀT diennakts daļas (no rīta, vakarā, naktī, pusdienlaikā)
    if (/\b(no rīta|rītos|rīta|agrā rīta|agri no rīta|pusdienlaikā|pusdienās|pēcpusdienā|pēc pusdienas|vakarā|vakaros|naktī|naktīs|pusnaktī|pēc darba)\b/gi.test(cleanDescription)) {
      semanticTagsKept.daypart = true;
      // Keep these words - don't remove them
    }
    
    // SAGLABĀT relatīvos laikus (pēc X stundām, pēc X minūtēm)
    if (/\b(pēc\s+(\d+|vienas?|divām|trim|četrām|piecām)\s+(stundām|minūtēm|stundas|minūtes))\b/gi.test(cleanDescription)) {
      semanticTagsKept.relativeTime = true;
      // Keep these phrases - don't remove them
    }
    
    // NOŅEM tikai strukturētos laikus/datumus (kas jau ir start/end laukos)
    // Remove: "pulksten", "pulkstenis", "pulkstens" (these are structure words, not context)
    cleanDescription = cleanDescription.replace(/\bpulksten(is|s)?\b/gi, '');
    
    // Remove: time words (desmitos, divos, trijos, etc.) - these are parsed to start/end
    const timeWordPattern = /\b(vienā|divos|trijos|četros|piecos|sešos|septiņos|astoņos|deviņos|desmitos|vienpadsmitos|divpadsmitos|vienam|diviem|trijiem|četriem|pieciem|sešiem|septiņiem|astoņiem|deviņiem|desmitiem|vienpadsmitiem|divpadsmitiem)\b/gi;
    cleanDescription = cleanDescription.replace(timeWordPattern, '');
    
    // Remove: numeric times (14:00, 14.00, etc.) - these are parsed to start/end
    cleanDescription = cleanDescription.replace(/\b\d{1,2}[.:]\d{2}\b/g, '');
    
    // Remove: specific numeric dates (15. novembrī, 2025-11-15) - these are parsed to start/end
    cleanDescription = cleanDescription.replace(/\b\d{1,2}\.\s*(janvār|februār|mart|aprīl|maij|jūnij|jūlij|august|septembr|oktobr|novembr|decembr)(ī|a|ā)?\b/gi, '');
    cleanDescription = cleanDescription.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '');
    
    // Clean up multiple spaces and trim
    cleanDescription = cleanDescription.replace(/\s+/g, ' ').trim();
    
    // Normalize punctuation artifacts: remove trailing dots/commas after words (e.g., "rīt ." → "rīt")
    // Remove dots/commas that are followed by nothing or only spaces
    cleanDescription = cleanDescription.replace(/\s+([.,;:])\s*$/g, ''); // trailing punctuation
    cleanDescription = cleanDescription.replace(/\s+([.,;:])\s+/g, ' '); // punctuation between words
    cleanDescription = cleanDescription.replace(/\s+/g, ' ').trim(); // final cleanup
    
    // If description is empty after cleaning, use original text
    if (!cleanDescription || cleanDescription.length < 3) {
      cleanDescription = text;
      }
    }
    
    // Log semantic tags kept for monitoring
    console.log(`📝 Description cleaning: kept semantic tags:`, semanticTagsKept);
    
    const result = {
      type,
      lang: langHint,
      description: cleanDescription, // For reminders: cleaned display text; for calendar: contextual text
      user_intent_text: text, // Original user intent text (for audit, debug, learning)
      _semanticTagsKept: semanticTagsKept // For monitoring/logging
    };
    
    // For reminders, also set reminder_display_text (alias for description)
    if (type === 'reminder') {
      result.reminder_display_text = cleanDescription;
    }

    // If no explicit time info
    if (!timeInfo.hasExplicitTime && !dateInfo.hasExactTime) {
      // Pure reminder without time
      result.hasTime = false;
      result.start = this.toRigaISO(dateInfo.baseDate);

      // Dynamic confidence calculation
      let confidence = 0.85; // base
      const confidenceBefore = confidence; // Store for logging
      
      // Boost for explicit day
      if (dateInfo.type === 'relative_day' || dateInfo.type === 'weekday') confidence += 0.05;
      // Boost for explicit type keywords
      if (/(tikšanās|sapulce|atgādini|reminder|meeting)/i.test(lower)) confidence += 0.03;
      
      // Store for logging
      result._confidence_before = confidenceBefore;
      result._confidence_after = confidence;
      
      // Cap at 0.95
      result.confidence = Math.min(0.95, confidence);

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
    // C. FIX: Same weekday check un TZ - izmantot pareizo timezone salīdzināšanai
    // Check if it's today (either isToday flag or same weekday)
    // Use Europe/Riga timezone for date comparison to avoid TZ issues
    const tz = "Europe/Riga";
    let startDateInRiga = null;
    let nowInRiga = null;
    
    if (startDate) {
      const dtf = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      const startParts = dtf.formatToParts(startDate);
      const startPartsObj = Object.fromEntries(startParts.map(p => [p.type, p.value]));
      startDateInRiga = {
        year: parseInt(startPartsObj.year),
        month: parseInt(startPartsObj.month),
        day: parseInt(startPartsObj.day)
      };
    }
    
    const nowDtf = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const nowParts = nowDtf.formatToParts(now);
    const nowPartsObj = Object.fromEntries(nowParts.map(p => [p.type, p.value]));
    nowInRiga = {
      year: parseInt(nowPartsObj.year),
      month: parseInt(nowPartsObj.month),
      day: parseInt(nowPartsObj.day)
    };
    
    const isToday = dateInfo.isToday || 
      (dateInfo.type === 'weekday' && 
       startDateInRiga && 
       startDateInRiga.day === nowInRiga.day && 
       startDateInRiga.month === nowInRiga.month && 
       startDateInRiga.year === nowInRiga.year);
    
    // Store original time before checking (use getHours/getMinutes, not UTC, since setTime already handles TZ)
    const originalHour = startDate ? startDate.getHours() : (timeInfo.hour || 9);
    const originalMinute = startDate ? startDate.getMinutes() : (timeInfo.minute || 0);
    
    console.log(`🔄 Same weekday check: isToday=${isToday}, type=${dateInfo.type}, startDate=${startDate?.toISOString()}, now=${now.toISOString()}, timePassed=${startDate && startDate < now}, TZ=${tz}`);
    
    if (isToday && startDate && startDate < now) {
      // If time has passed today, move to next occurrence
      if (dateInfo.type === 'weekday' && dateInfo.targetIsoDay) {
        // For weekdays, get next occurrence (7 days later)
        // Only move to next week if time has actually passed
        console.log(`🔄 Same weekday: time has passed, moving to next week. Original time: ${originalHour}:${originalMinute}`);
        const nextWeekday = new Date(now);
        nextWeekday.setDate(nextWeekday.getDate() + 7);
        startDate = this.getNextWeekday(nextWeekday, dateInfo.targetIsoDay);
        // Preserve the original time (from startDate, not timeInfo which might be wrong)
        startDate.setHours(originalHour, originalMinute, 0, 0);
        endDate = new Date(startDate.getTime() + (duration || 60) * 60 * 1000);
        console.log(`🔄 Same weekday: moved to next week, date=${startDate.toISOString()}, time=${originalHour}:${originalMinute}`);
      } else if (dateInfo.isToday) {
        // For other "today" cases, move to tomorrow with same time
        startDate = new Date(startDate);
        startDate.setDate(startDate.getDate() + 1);
        endDate = new Date(startDate.getTime() + (duration || 60) * 60 * 1000);
      }
    } else if (isToday && startDate && startDate >= now) {
      // Time has not passed yet, keep today's date
      console.log(`🔄 Same weekday: time has NOT passed, keeping today. startDate=${startDate.toISOString()}`);
    }

    result.start = this.toRigaISO(startDate);

    if (type === 'calendar') {
      result.end = this.toRigaISO(endDate);
    } else {
      result.hasTime = true;
    }

    // Dynamic confidence calculation (with explicit time)
    let confidence = 0.85; // base

    // Boost for explicit time
    if (timeInfo.hasExplicitTime || dateInfo.hasExactTime || timeInfo.isRelativeTime) {
      confidence += 0.07;
    }

    // Boost for explicit day
    if (dateInfo.type === 'relative_day' || dateInfo.type === 'weekday') {
      confidence += 0.05;
    }

    // Boost for explicit type keywords
    if (/(tikšanās|sapulce|atgādini|reminder|meeting)/i.test(lower)) {
      confidence += 0.03;
    }

    // Store confidence BEFORE re-kalibrācija (pēc visiem boostiem, bet pirms plauzibilitātes pielāgojumiem)
    const confidenceBefore = confidence;

    // CONFIDENCE RE-KALIBRĀCIJA (pēc plauzibilitātes)
    const isWeekday = dateInfo.type === 'weekday';
    const isMeetingActivity = /(tikšanās|sapulce|zoom|prezentācija|meeting|konference|teātris|koncerts|pasākums)/i.test(lower);
    const isEarlyHour = timeInfo.hour >= 1 && timeInfo.hour <= 7;
    const hasDaypart = /(no rīta|rītos|vakarā|naktī|pusdienlaikā|pēcpusdienā)/i.test(lower);
    const weekdayEarlyHourWithoutDaypart = isWeekday && isMeetingActivity && isEarlyHour && !hasDaypart;
    
    // E. FIX: Tokenu tīrītājs - neizmet atslēgvārdus, kas pazemina confidence
    // "pulksten" ir strukturēts vārds (nav konteksts), tāpēc to var noņemt bez confidence pazemināšanas
    // Confidence pazemināšana tikai, ja tiek noņemti KONTEKSTU vārdi (weekday, daypart, utt.)
    const hadStructuredTimeTokens = /(pulksten|desmitos|divos|trijos|četros|piecos|sešos|septiņos|astoņos|deviņos|vienpadsmitos|divpadsmitos|\d{1,2}[.:]\d{2})/i.test(text);
    const hasStructuredTimeTokensInDesc = /(pulksten|desmitos|divos|trijos|četros|piecos|sešos|septiņos|astoņos|deviņos|vienpadsmitos|divpadsmitos|\d{1,2}[.:]\d{2})/i.test(result.description);
    // Check if contextual tokens were removed (weekday, daypart, relative date)
    const hadContextualTokens = /(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien|rīt|šodien|parīt|no rīta|vakarā|naktī)/i.test(text);
    const hasContextualTokensInDesc = /(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien|rīt|šodien|parīt|no rīta|vakarā|naktī)/i.test(result.description);
    
    // Confidence pazemināšana tikai, ja tiek noņemti KONTEKSTU vārdi (nevis strukturēti laika vārdi)
    const descHadContextualTokensRemoved = hadContextualTokens && !hasContextualTokensInDesc;
    const descHadTimeTokensRemoved = hadStructuredTimeTokens && !hasStructuredTimeTokensInDesc;
    
    // Check if absolute date detected but relative path used
    const absoluteDateDetected = dateInfo.type === 'specific_date';
    const relativePathUsed = dateInfo.type === 'relative' || dateInfo.type === 'weekday';
    const absoluteDateWithRelativePath = false; // This would be set if we detect conflict
    
    // Confidence adjustments
    if (weekdayEarlyHourWithoutDaypart) {
      confidence -= 0.35;
      console.log(`📊 Confidence adjustment: weekday_early_hour_without_daypart -0.35`);
    }
    // E. FIX: Pazemināt confidence tikai, ja tiek noņemti KONTEKSTU vārdi (nevis strukturēti laika vārdi)
    if (descHadContextualTokensRemoved) {
      confidence -= 0.25;
      console.log(`📊 Confidence adjustment: desc_had_contextual_tokens_removed -0.25`);
    }
    // Strukturētu laika vārdu noņemšana (pulksten, desmitos) nav problēma - tie jau ir start/end laukos
    // Bet saglabāt flag, lai redzētu, kas tika noņemts
    if (absoluteDateWithRelativePath) {
      confidence -= 0.20;
      console.log(`📊 Confidence adjustment: absolute_date_with_relative_path -0.20`);
    }
    
    // Store for later (teacher_agreed will be set in Teacher validate mode)
    result._confidence_before = confidenceBefore;
    result._confidence_after = confidence;
    result._desc_had_time_tokens_removed = descHadTimeTokensRemoved || descHadContextualTokensRemoved; // Store both for logging
    result._weekday_early_hour_without_daypart = weekdayEarlyHourWithoutDaypart;
    
    // Store am_pm_decision and telemetry from timeInfo if available
    if (timeInfo && timeInfo._am_pm_decision) {
      result._am_pm_decision = timeInfo._am_pm_decision;
    }
    if (timeInfo && timeInfo._telemetry) {
      result._telemetry = timeInfo._telemetry;
    }

    // Cap at 0.95, min at 0.1
    confidence = Math.max(0.1, Math.min(0.95, confidence));
    
    // If confidence_after < 0.80 → trigger Teacher validate (if not already triggered)
    if (confidence < 0.80) {
      result._low_confidence = true;
    }
    
    result.confidence = confidence;
    console.log(`📊 Confidence: before=${confidenceBefore.toFixed(2)}, after=${confidence.toFixed(2)}, adjustments=${(confidenceBefore - confidence).toFixed(2)}`);

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

// Export class for testing
export { LatvianCalendarParserV3 };

/**
 * Parse Latvian calendar/reminder text using Parser V3
 * @param {string} text - Input text
 * @param {string} nowISO - Current time ISO string
 * @param {string} langHint - Language hint (default: 'lv')
 * @returns {Object|null} Parsed result
 */
/* ===== Teacher-Student Learning Functions ===== */

/**
 * Parse with Teacher (Claude) - Gold standard parser
 */
async function parseWithTeacher(text, nowISO, langHint = 'lv') {
  if (!anthropic) {
    throw new Error('Anthropic API key not configured');
  }
  
  const tmr = new Date(Date.now() + 24 * 3600 * 1000);
  const tomorrowISO = toRigaISO(new Date(tmr.getFullYear(), tmr.getMonth(), tmr.getDate(), 0, 0, 0));
  
  // A. FIX: Saglabāt weekday info Teacher promptā
  // Extract weekday from text if present, to help Teacher preserve it
  const weekdayMatch = text.match(/\b(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien)(a|u|ā)?\b/i);
  const weekdayHint = weekdayMatch ? `\n\nSVARĒGI: Tekstā ir nedēļas diena "${weekdayMatch[0]}". Saglabā to description laukā!` : '';
  
  const teacherPrompt = SYSTEM_PROMPT + `\n\nSVARĒGI: Atgriez TIKAI derīgu JSON objektu pēc shēmas. Nav markdown, nav \`\`\`json\`\`\`, tikai tīrs JSON ar type, lang, description, start, hasTime (vai end calendar gadījumā).\n\nTagadējais datums un laiks: ${nowISO} (Europe/Riga).\nRītdienas datums: ${tomorrowISO}${weekdayHint}`;
  
  try {
    const response = await anthropic.messages.create({
      model: TEACHER_MODEL,
      max_tokens: 1024,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `currentTime=${nowISO}\ntomorrowExample=${tomorrowISO}\nTeksts: ${text}`
        }
      ],
      system: teacherPrompt
    });
    
    const content = response.content[0].text || '{}';
    const parsed = JSON.parse(content);
    
    // Validate
    if (!isValidCalendarJson(parsed)) {
      throw new Error('Teacher returned invalid JSON');
    }
    
    return parsed;
  } catch (error) {
    console.error('❌ Teacher parsing failed:', error.message);
    throw error;
  }
}

/**
 * Detect triggers that require Teacher validation
 */
function detectTriggers(text, lower) {
  const triggers = [];
  
  // AM/PM trigger
  if (STRICT_TRIGGERS.includes('am_pm')) {
    const amPmPattern = /\b(vienā|divos|trijos|četros|piecos|sešos|septiņos|astoņos|deviņos|desmitos|vienpadsmitos)\b.*\b(vakarā|vēlu|naktī|pēcpusdienā|no rīta|rītos)\b/gi;
    if (amPmPattern.test(lower)) {
      triggers.push('am_pm');
    }
  }
  
  // Interval trigger
  if (STRICT_TRIGGERS.includes('interval')) {
    if (/no\s+(\d+|vienam|diviem|trijiem|četriem|pieciem|sešiem|septiņiem|astoņiem|deviņiem|desmitiem|vienpadsmitiem|divpadsmitiem)\s+līdz\s+(\d+|vienam|diviem|trijiem|četriem|pieciem|sešiem|septiņiem|astoņiem|deviņiem|desmitiem|vienpadsmitiem|divpadsmitiem)/gi.test(lower)) {
      triggers.push('interval');
    }
  }
  
  // Date range trigger (no X. mēneša līdz Y. mēnesim)
  if (/no\s+\d{1,2}\.\s*(janvār|februār|mart|aprīl|maij|jūnij|jūlij|august|septembr|oktobr|novembr|decembr)(?:ī|a|ā)?\s+līdz\s+\d{1,2}\.\s*(janvār|februār|mart|aprīl|maij|jūnij|jūlij|august|septembr|oktobr|novembr|decembr)(?:ī|a|ā)?/i.test(lower)) {
    triggers.push('date_range');
  }
  
  // Mixed numerics trigger (datums ar punktu + stundas vārdi - augsts kļūdas risks)
  const hasDateWithDot = /\d{1,2}\.\s*(janvār|februār|mart|aprīl|maij|jūnij|jūlij|august|septembr|oktobr|novembr|decembr)/i.test(lower);
  const hasTimeWord = /\b(vienā|divos|trijos|četros|piecos|sešos|septiņos|astoņos|deviņos|desmitos|vienpadsmitos|divpadsmitos)\b/i.test(lower);
  if (hasDateWithDot && hasTimeWord) {
    triggers.push('mixed_numerics');
  }
  
  // Weekday + early hour + meeting trigger (ja biznesa heuristika neizšķir)
  const hasWeekday = /(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien)/i.test(lower);
  const hasEarlyHour = /\b(vienā|divos|trijos|četros|piecos|sešos|septiņos)\b/i.test(lower);
  const hasMeeting = /(tikšanās|sapulce|zoom|prezentācija|meeting|konference)/i.test(lower);
  const hasDaypart = /(no rīta|rītos|vakarā|naktī|pusdienlaikā|pēcpusdienā)/i.test(lower);
  if (hasWeekday && hasEarlyHour && hasMeeting && !hasDaypart) {
    triggers.push('weekday_early_hour_meeting');
  }
  
  // Relative multi trigger
  if (STRICT_TRIGGERS.includes('relative_multi')) {
    const relativePattern = /\b(pēc\s+(\d+|vienas?|divām|trim|četrām|piecām)\s+(stundām|minūtēm|stundas|minūtes))\b.*\b(rīt|parīt|šodien|trešdien|piektdien)\b/gi;
    if (relativePattern.test(lower)) {
      triggers.push('relative_multi');
    }
  }
  
  return triggers;
}

/**
 * Compare V3 and Teacher results
 */
function compareResults(v3Result, teacherResult) {
  const discrepancies = {
    time: false,
    date: false,
    place: false,
    severity: 'low',
    tags: []
  };
  
  // Compare time
  if (v3Result.start && teacherResult.start) {
    const v3Date = new Date(v3Result.start);
    const teacherDate = new Date(teacherResult.start);
    const hoursDiff = Math.abs((v3Date.getTime() - teacherDate.getTime()) / (1000 * 60 * 60));
    
    if (hoursDiff >= 2) {
      discrepancies.time = true;
      discrepancies.severity = 'high';
      discrepancies.tags.push('time_large_diff');
    } else if (hoursDiff >= 1) {
      discrepancies.time = true;
      discrepancies.severity = 'mid';
      discrepancies.tags.push('time_medium_diff');
    } else if (hoursDiff > 0) {
      discrepancies.time = true;
      discrepancies.severity = 'low';
      discrepancies.tags.push('time_small_diff');
    }
    
    // Check AM/PM issue (12 hour difference)
    if (Math.abs(hoursDiff - 12) < 0.5) {
      discrepancies.tags.push('am_pm');
      discrepancies.severity = 'high';
    }
  }
  
  // Compare date
  if (v3Result.start && teacherResult.start) {
    const v3Date = new Date(v3Result.start);
    const teacherDate = new Date(teacherResult.start);
    const daysDiff = Math.abs((v3Date.getTime() - teacherDate.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysDiff >= 1) {
      discrepancies.date = true;
      discrepancies.severity = 'high';
      discrepancies.tags.push('date_large_diff');
    } else if (daysDiff > 0) {
      discrepancies.date = true;
      if (discrepancies.severity === 'low') discrepancies.severity = 'mid';
      discrepancies.tags.push('date_diff');
    }
  }
  
  // Compare description for place names (simple heuristic)
  const v3Desc = (v3Result.description || '').toLowerCase();
  const teacherDesc = (teacherResult.description || '').toLowerCase();
  
  // Extract location-like words (pie, ar, uz, etc.)
  const locationPattern = /\b(pie|ar|uz|dārznīcībā|veikalā|baznīcā|skolā|darbs|darbā)\b/gi;
  const v3Locations = (v3Desc.match(locationPattern) || []).sort().join(',');
  const teacherLocations = (teacherDesc.match(locationPattern) || []).sort().join(',');
  
  if (v3Locations !== teacherLocations && (v3Locations || teacherLocations)) {
    discrepancies.place = true;
    if (discrepancies.severity === 'low') discrepancies.severity = 'mid';
    discrepancies.tags.push('place_diff');
  }
  
  return {
    hasDiscrepancy: discrepancies.time || discrepancies.date || discrepancies.place,
    discrepancies
  };
}

/**
 * Save gold log entry to database
 */
function saveGoldLog(entry) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO v3_gold_log 
       (ts, user_id, session_id, asr_text, normalized_text, v3_result, teacher_result, decision, discrepancies, used_triggers, latency_ms, severity, am_pm_decision, desc_had_time_tokens_removed, confidence_before, confidence_after, hour_7_resolved_to, hour_6_override, marker_detected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.ts || new Date().toISOString(),
        entry.user_id || null,
        entry.session_id || null,
        entry.asr_text || null,
        entry.normalized_text || null,
        JSON.stringify(entry.v3_result),
        entry.teacher_result ? JSON.stringify(entry.teacher_result) : null,
        entry.decision,
        JSON.stringify(entry.discrepancies || {}),
        JSON.stringify(entry.used_triggers || []),
        JSON.stringify(entry.latency_ms || {}),
        entry.discrepancies?.severity || 'low',
        entry.am_pm_decision || null,
        entry.desc_had_time_tokens_removed ? 1 : 0,
        entry.confidence_before || null,
        entry.confidence_after || null,
        // Telemetrija: hour policy metrics
        entry.telemetry?.hour_7_resolved_to || null,
        entry.telemetry?.hour_6_override ? 1 : 0,
        entry.telemetry?.marker_detected || null
      ],
      function(err) {
        if (err) {
          console.error('❌ Failed to save gold log:', err);
          reject(err);
        } else {
          resolve(this.lastID);
        }
      }
    );
  });
}

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

⚠️ KRITISKS NOTEIKUMS: JA TEKSTS IR NESAPROTAMS VAI NESKAIDRS:
- ATGRIEZ TO TĀDU PAŠU (NEMAINĪTU)
- NEKAD neizdomi jaunu nozīmi
- NEKAD neinterpretē sliktu transkripciju kā citu vārdu
- Piemērs: "da su mai zeng" → "da su mai zeng" (NE "dažādi suņi")
- Ja šaubies par nozīmi → atgriez oriģinālu

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

// Log transcript flow for debugging - PILNĀ TEKSTA PLŪSMA
function logTranscriptFlow(req, res, raw, norm, analyzedText, needsAnalysis, score, out) {
  const requestId = req.requestId.slice(-8);
  const isError = res.statusCode >= 400;
  const debugMode = process.env.DEBUG_TRANSCRIPT === 'true';
  const alwaysLogFull = process.env.LOG_FULL_TRANSCRIPT === 'true'; // Vienmēr logē pilnu tekstu
  
  // V3 parser rezultāts (pirms GPT description check)
  const v3Description = out.description_before || out.description;
  const v3Confidence = out.confidence || out.v3_confidence || 'N/A';
  
  // GPT description check rezultāts
  const gptDescriptionUsed = out.desc_gpt_used || false;
  const gptDescriptionMode = out.desc_gpt_mode || 'off';
  const finalDescription = out.description || 'N/A';
  
  // PILNS TEKSTA PLŪSMA LOG (vienmēr)
  console.log(`\n📊 [${requestId}] === TEKSTA PLŪSMA ===`);
  console.log(`🎤 [1] Whisper (raw):        "${raw}"`);
  console.log(`🔧 [2] Normalized:          "${norm}"`);
  if (needsAnalysis) {
    console.log(`🤖 [3] GPT Analysis:         "${analyzedText}" (score: ${score.toFixed(2)})`);
  } else {
    console.log(`✅ [3] GPT Analysis:         SKIP (score: ${score.toFixed(2)} >= 0.6)`);
  }
  console.log(`🧭 [4] V3 Parser:            "${v3Description}" (confidence: ${v3Confidence})`);
  if (gptDescriptionUsed) {
    console.log(`📝 [5] GPT Description:      "${finalDescription}" (mode: ${gptDescriptionMode})`);
  } else {
    console.log(`📝 [5] GPT Description:      SKIP (mode: ${gptDescriptionMode})`);
  }
  console.log(`📤 [6] Client Final:         "${finalDescription}" (type: ${out.type})`);
  if (out.start) console.log(`   └─ Start: ${out.start}`);
  if (out.end) console.log(`   └─ End: ${out.end}`);
  console.log(`📊 [${requestId}] ========================\n`);
  
  // Kompakts log (backward compatible)
  const whisperShort = raw.length > 50 ? raw.slice(0, 50) + '...' : raw;
  const analyzedShort = analyzedText.length > 50 ? analyzedText.slice(0, 50) + '...' : analyzedText;
  const finalShort = finalDescription.length > 50 ? finalDescription.slice(0, 50) + '...' : finalDescription;
  
  let logLine = `📝 [${requestId}] W:"${whisperShort}"`;
  if (needsAnalysis) {
    logLine += ` → GPT:"${analyzedShort}"`;
  }
  logLine += ` → Client:${out.type}:"${finalShort}"`;
  // console.log(logLine); // Komentēts, jo augšā ir pilnāks log
  
  // Detalizēts JSON log (ja DEBUG_TRANSCRIPT vai error)
  if (debugMode || isError || alwaysLogFull) {
    console.log(JSON.stringify({
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      transcriptFlow: {
        whisper_raw: raw,
        normalized: norm,
        analyzed: analyzedText,
        analysisApplied: needsAnalysis,
        qualityScore: score,
        v3Parser: {
          description: v3Description,
          confidence: v3Confidence,
          type: out.type,
          start: out.start,
          end: out.end,
          hasTime: out.hasTime
        },
        gptDescriptionCheck: {
          used: gptDescriptionUsed,
          mode: gptDescriptionMode,
          before: out.description_before,
          after: finalDescription
        },
        clientFinal: {
          type: out.type,
          description: finalDescription,
          start: out.start,
          end: out.end,
          hasTime: out.hasTime,
          items: out.items
        },
        semanticTagsKept: out._semanticTagsKept || {}
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
  const processingStart = Date.now();
  console.log(`🧭 Parser v3 attempting parse: "${analyzedText}"`);
  console.log(`📅 nowISO being used: ${nowISO} (from ${fields.currentTime ? 'client' : 'server'})`);
  const v3StartTime = Date.now();
  const parsed = parseWithV3(analyzedText, nowISO, langHint);
  const v3Latency = Date.now() - v3StartTime;
  
  // Validate Parser V3 result - check if time makes sense
  let shouldUseParser = parsed && parsed.confidence >= 0.8;
  if (shouldUseParser && parsed.start) {
    try {
      const startDate = new Date(parsed.start);
      if (isNaN(startDate.getTime())) {
        console.warn(`⚠️ Parser V3 returned invalid start date: ${parsed.start}, falling back to LLM`);
        shouldUseParser = false;
      } else {
        // Check if time is reasonable (not in past for "today" or "rīt", not too far in future)
        const now = new Date(nowISO);
        const hoursDiff = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60);
        
        // If time is more than 7 days in past, it's likely wrong
        if (hoursDiff < -168) {
          console.warn(`⚠️ Parser V3 returned time ${hoursDiff.toFixed(1)} hours in past: ${parsed.start}, falling back to LLM`);
          shouldUseParser = false;
        }
        // If time is more than 1 year in future, it's likely wrong
        else if (hoursDiff > 8760) {
          console.warn(`⚠️ Parser V3 returned time ${hoursDiff.toFixed(1)} hours in future: ${parsed.start}, falling back to LLM`);
          shouldUseParser = false;
        }
      }
    } catch (e) {
      console.warn(`⚠️ Parser V3 validation error: ${e.message}, falling back to LLM`);
      shouldUseParser = false;
    }
  }
  
  // Teacher-Student Learning Mode: Paralēlā parsēšana un salīdzināšana
  let teacherResult = null;
  let comparison = null;
  let decision = 'v3';
  const latencyMs = { v3: v3Latency, teacher: 0, total: 0 };
  
  // Detect triggers
  const lower = analyzedText.toLowerCase();
  const usedTriggers = detectTriggers(analyzedText, lower);
  
  // Determine if we need Teacher
  const needsTeacher = LEARNING_MODE && anthropic && (
    // Strict triggers always require Teacher
    usedTriggers.length > 0 ||
    // Low confidence requires Teacher
    !parsed || !parsed.confidence || parsed.confidence < CONFIDENCE_THRESHOLD_LOW ||
    // Medium confidence (0.50-0.79) requires validation
    (parsed && parsed.confidence >= CONFIDENCE_THRESHOLD_LOW && parsed.confidence < CONFIDENCE_THRESHOLD_HIGH) ||
    // Sample rate for high confidence (0.8+)
    (parsed && parsed.confidence >= CONFIDENCE_THRESHOLD_HIGH && Math.random() < TEACHER_RATE)
  );
  
  // Ja Parser v3 atgriež objektu ar pietiekamu confidence (≥0.8) UN validācija iziet, izmanto to bez LLM
  if (shouldUseParser) {
    
    console.log(`🧭 Parser v3 used (confidence: ${parsed.confidence}): type=${parsed.type}, start=${parsed.start}, end=${parsed.end || 'none'}`);
    
    // Teacher-Student: Paralēlā parsēšana (ja nepieciešams)
    if (needsTeacher) {
      const teacherStart = Date.now();
      try {
        console.log(`👨‍🏫 Teacher parsing (triggers: ${usedTriggers.join(', ') || 'sampling'})...`);
        teacherResult = await parseWithTeacher(analyzedText, nowISO, langHint);
        latencyMs.teacher = Date.now() - teacherStart;
        
        // Compare results
        comparison = compareResults(parsed, teacherResult);
        
        // Decision logic
        if (usedTriggers.length > 0 || parsed.confidence < CONFIDENCE_THRESHOLD_LOW) {
          // Strict triggers or low confidence → Teacher primary
          decision = 'teacher_primary';
          console.log(`👨‍🏫 Teacher primary (triggers: ${usedTriggers.join(', ')}, confidence: ${parsed.confidence})`);
        } else if (parsed.confidence >= CONFIDENCE_THRESHOLD_LOW && parsed.confidence < CONFIDENCE_THRESHOLD_HIGH) {
          // Medium confidence → Teacher validate
          if (comparison.hasDiscrepancy && comparison.discrepancies.severity !== 'low') {
            decision = 'teacher_validate';
            console.log(`👨‍🏫 Teacher validate (discrepancy detected, severity: ${comparison.discrepancies.severity})`);
          } else {
            decision = 'v3';
            console.log(`🧭 V3 kept (no significant discrepancy)`);
          }
        } else {
          // High confidence → sample, keep V3 unless major discrepancy
          if (comparison.hasDiscrepancy && comparison.discrepancies.severity === 'high') {
            decision = 'teacher_validate';
            console.log(`👨‍🏫 Teacher validate (high severity discrepancy)`);
          } else {
            decision = 'v3';
          }
        }
        
        // Save gold log
        try {
          await saveGoldLog({
            ts: new Date().toISOString(),
            user_id: userId,
            session_id: req.requestId,
            asr_text: raw,
            normalized_text: norm,
            v3_result: parsed,
            teacher_result: teacherResult,
            decision: decision,
            discrepancies: comparison.discrepancies,
            used_triggers: usedTriggers,
            latency_ms: latencyMs,
            am_pm_decision: parsed._am_pm_decision || null,
            desc_had_time_tokens_removed: parsed._desc_had_time_tokens_removed || false,
            confidence_before: parsed._confidence_before || null,
            confidence_after: parsed._confidence_after || parsed.confidence || null,
            telemetry: parsed._telemetry || null
          });
          console.log(`📊 Gold log saved (decision: ${decision})`);
        } catch (logError) {
          console.warn(`⚠️ Failed to save gold log: ${logError.message}`);
        }
      } catch (teacherError) {
        console.warn(`⚠️ Teacher parsing failed: ${teacherError.message}, using V3`);
        latencyMs.teacher = Date.now() - teacherStart;
        decision = 'v3';
        // Still save gold log with V3 only
        try {
          await saveGoldLog({
            ts: new Date().toISOString(),
            user_id: userId,
            session_id: req.requestId,
            asr_text: raw,
            normalized_text: norm,
            v3_result: parsed,
            teacher_result: null,
            decision: 'v3',
            discrepancies: null,
            used_triggers: usedTriggers,
            latency_ms: latencyMs,
            am_pm_decision: parsed._am_pm_decision || null,
            desc_had_time_tokens_removed: parsed._desc_had_time_tokens_removed || false,
            confidence_before: parsed._confidence_before || null,
            confidence_after: parsed._confidence_after || parsed.confidence || null,
            telemetry: parsed._telemetry || null
          });
        } catch (logError) {
          // Ignore log errors
        }
      }
    }
    
    // Use Teacher result if decision requires it
    let finalResult = parsed;
    let teacherAgreed = false;
    if (decision === 'teacher_primary' || decision === 'teacher_validate') {
      if (teacherResult) {
        // Check if Teacher agrees with V3 (no significant discrepancies)
        if (decision === 'teacher_validate' && comparison && !comparison.hasDiscrepancy) {
          teacherAgreed = true;
          console.log(`📊 Teacher agreed: no discrepancies, confidence will be boosted +0.15`);
        }
        finalResult = teacherResult;
        
        // A. FIX: Saglabāt weekday info no V3, ja Teacher to nav saglabājis
        // Ja V3 atrada weekday un Teacher description nav weekday, saglabāt V3 weekday info
        const v3HasWeekday = parsed.description && /(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien)/i.test(parsed.description);
        const teacherHasWeekday = finalResult.description && /(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien)/i.test(finalResult.description);
        if (v3HasWeekday && !teacherHasWeekday) {
          // Saglabāt weekday no V3 description
          const weekdayMatch = parsed.description.match(/\b(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien)(a|u|ā)?\b/i);
          if (weekdayMatch) {
            const weekday = weekdayMatch[0];
            // Pievienot weekday Teacher description, ja tas nav jau tur
            if (!finalResult.description.includes(weekday)) {
              finalResult.description = `${weekday} ${finalResult.description}`.trim();
              console.log(`🔧 Preserved weekday "${weekday}" from V3 in Teacher result`);
            }
          }
        }
        
        // Preserve confidence metadata from V3 and apply teacher_agreed boost
        if (parsed._confidence_before) finalResult._confidence_before = parsed._confidence_before;
        if (teacherAgreed && parsed._confidence_after) {
          // Teacher agreed boost: +0.15
          finalResult._confidence_after = Math.min(0.95, parsed._confidence_after + 0.15);
          finalResult.confidence = finalResult._confidence_after;
          console.log(`📊 Teacher agreed: confidence boosted +0.15 → ${finalResult._confidence_after.toFixed(2)}`);
        } else if (parsed._confidence_after) {
          finalResult._confidence_after = parsed._confidence_after;
        }
        if (parsed._desc_had_time_tokens_removed !== undefined) finalResult._desc_had_time_tokens_removed = parsed._desc_had_time_tokens_removed;
        if (parsed._am_pm_decision) finalResult._am_pm_decision = parsed._am_pm_decision;
        console.log(`✅ Using Teacher result (${decision})`);
      } else {
        console.warn(`⚠️ Teacher result unavailable, using V3`);
      }
    }
    
    // GPT pārbaude teksta kvalitātei - ar feature flag sistēmu
    let finalDescription = finalResult.description;
    const descriptionBefore = finalDescription;
    
    // Feature flags: DESC_GPT_ENABLED (default: off for testing) and DESC_GPT_MODE (off|conservative|aggressive)
    const descGptEnabled = process.env.DESC_GPT_ENABLED === 'true';
    const descGptMode = (process.env.DESC_GPT_MODE || 'off').toLowerCase();
    
    // Determine if GPT should be used
    const shouldUseGpt = descGptEnabled && (descGptMode === 'conservative' || descGptMode === 'aggressive');
    
    if (shouldUseGpt) {
      try {
        console.log(`🤖 GPT checking description quality (mode: ${descGptMode}): "${finalDescription}"`);
        
        // Build prompt based on mode
        let systemPrompt;
        if (descGptMode === 'conservative') {
          // Conservative mode: preserve context, only improve grammar/styling
          systemPrompt = `Tu esi latviešu valodas eksperts. Uzlabo šo teksta aprakstu, saglabājot svarīgo kontekstu:

⚠️ AIZLIEĒ JĀNOŅEM:
- NEKAD neliec ārā/nenovāc relatīvos laikus (rīt, šodien, parīt, nākamnedēļ)
- NEKAD neliec ārā nedēļas dienas (pirmdien, trešdien, svētdien)
- NEKAD neliec ārā diennakts daļas (no rīta, vakarā, naktī, pusdienlaikā)
- NEKAD neliec ārā relatīvos laikus (pēc X stundām, pēc X minūtēm)
- NEKAD neliec ārā lokācijas (dārznīcībā, pie vectētiņa)
- NEKAD neliec ārā personu vārdus (ar Juri, ar valdi)

✅ ATĻAUTS:
- Labot gramatiku un pareizrakstību
- Saīsināt liekvārdību (bet saglabāt nozīmi)
- Normalizēt vārdu galotnes
- Uzlabot stilu un skaidrību

Kontrole: Ja teksts satur laika/relatīva konteksta vārdus, saglabā tos. Atgriez TIKAI uzlaboto tekstu, bez skaidrojumiem.`;
        } else {
          // Aggressive mode: similar but allows more editing
          systemPrompt = `Tu esi latviešu valodas eksperts. Uzlabo šo teksta aprakstu:

⚠️ SAGLABĀT:
- Relatīvos laikus (rīt, šodien, parīt, nākamnedēļ)
- Nedēļas dienas (pirmdien, trešdien, svētdien)
- Diennakts daļas (no rīta, vakarā, naktī, pusdienlaikā)
- Lokācijas un personu vārdus

✅ UZLABOT:
- Gramatiku, pareizrakstību, stilu
- Skaidrību un skaidrību

Atgriez TIKAI uzlaboto tekstu, bez skaidrojumiem.`;
        }
        
      const descriptionCheck = await safeCreate(
        buildParams({
          model: DEFAULT_TEXT_MODEL,
          messages: [
              { role: "system", content: systemPrompt },
            { role: "user", content: `Uzlabo šo aprakstu: "${finalDescription}"` }
          ],
          max: 200,
          temperature: 0
        })
      );
      const improvedDescription = (descriptionCheck.choices?.[0]?.message?.content || finalDescription).trim();
        
        // Validate that GPT didn't remove time/context words (conservative mode only)
        if (descGptMode === 'conservative') {
          const hadRelativeDate = /\b(rīt|rītdien|šodien|parīt|parītdien|nākamnedēļ|nākamajā nedēļā)\b/gi.test(descriptionBefore);
          const hadWeekday = /\b(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien)(a|u|ā)?\b/gi.test(descriptionBefore);
          const hadDaypart = /\b(no rīta|rītos|vakarā|naktī|pusdienlaikā)\b/gi.test(descriptionBefore);
          
          const hasRelativeDate = /\b(rīt|rītdien|šodien|parīt|parītdien|nākamnedēļ|nākamajā nedēļā)\b/gi.test(improvedDescription);
          const hasWeekday = /\b(pirmdien|otrdien|trešdien|ceturtdien|piektdien|sestdien|svētdien)(a|u|ā)?\b/gi.test(improvedDescription);
          const hasDaypart = /\b(no rīta|rītos|vakarā|naktī|pusdienlaikā)\b/gi.test(improvedDescription);
          
          // If GPT removed time context, keep original
          if ((hadRelativeDate && !hasRelativeDate) || (hadWeekday && !hasWeekday) || (hadDaypart && !hasDaypart)) {
            console.warn(`⚠️ GPT removed time context, keeping original description`);
            finalDescription = descriptionBefore;
          } else if (improvedDescription && improvedDescription.length > 0 && improvedDescription !== finalDescription) {
            console.log(`✅ GPT improved description: "${finalDescription}" → "${improvedDescription}"`);
            finalDescription = improvedDescription;
          } else {
            console.log(`ℹ️ GPT kept description unchanged`);
          }
        } else {
          // Aggressive mode: trust GPT
      if (improvedDescription && improvedDescription.length > 0 && improvedDescription !== finalDescription) {
        console.log(`✅ GPT improved description: "${finalDescription}" → "${improvedDescription}"`);
        finalDescription = improvedDescription;
      } else {
        console.log(`ℹ️ GPT kept description unchanged`);
          }
      }
    } catch (descError) {
      console.warn(`⚠️ GPT description check failed: ${descError.message}, using Parser V3 description`);
      // Keep original description from Parser V3
      }
    } else {
      console.log(`ℹ️ GPT description check disabled (DESC_GPT_ENABLED=${descGptEnabled}, mode=${descGptMode})`);
    }
    
    // Log description changes for monitoring (with semantic tags)
    const semanticTagsKept = parsed._semanticTagsKept || {};
    if (descriptionBefore !== finalDescription) {
      console.log(`📝 Description changed: "${descriptionBefore}" → "${finalDescription}"`);
      console.log(`📝 Semantic tags kept:`, semanticTagsKept);
    } else {
      console.log(`📝 Description unchanged: "${finalDescription}"`);
      console.log(`📝 Semantic tags kept:`, semanticTagsKept);
    }
    
    finalResult.description = finalDescription;
    finalResult.description_before = descriptionBefore; // For monitoring
    finalResult.desc_gpt_used = shouldUseGpt; // For monitoring
    finalResult.desc_gpt_mode = descGptMode; // For monitoring
    finalResult.raw_transcript = raw;
    finalResult.normalized_transcript = norm;
    finalResult.analyzed_transcript = analyzedText;
    finalResult.analysis_applied = needsAnalysis;
    finalResult.confidence = score;
    
    // Teacher-Student metadata
    if (LEARNING_MODE) {
      finalResult.learning_mode = {
        decision: decision,
        v3_confidence: parsed.confidence,
        teacher_used: teacherResult !== null,
        has_discrepancy: comparison?.hasDiscrepancy || false,
        discrepancy_severity: comparison?.discrepancies?.severity || null,
        triggers: usedTriggers,
        latency_ms: latencyMs
      };
    }
    if (finalResult.type === 'shopping' && shoppingStyleList) {
      finalResult.description = finalResult.description || 'Pirkumu saraksts';
    }
    // Kvotu skaitīšana un atbilde kā zemāk (kopējam no success ceļa)
    u.daily.used += 1;
    operationsTotal.inc({ status: "success", plan: limits.plan }, 1);
    await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed);
    databaseOperations.inc({ operation: "update", table: "quota_usage" }, 1);
    quotaUsage.inc({ plan: limits.plan, type: "daily" }, 1);
    if (limits.plan === "pro") { quotaUsage.inc({ plan: limits.plan, type: "monthly" }, 1); }
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
    finalResult.requestId = req.requestId;
    latencyMs.total = Date.now() - processingStart;
    audioProcessingTime.observe({ status: "success" }, latencyMs.total);
    
    // Log transcript flow
    logTranscriptFlow(req, res, raw, norm, analyzedText, needsAnalysis, score, finalResult);
    
    return res.json(finalResult);
  } else {
    // V3 confidence < 0.8 or validation failed
    console.log(`🧭 Parser v3 returned ${parsed ? `low confidence (${parsed.confidence || 0})` : 'null'}, falling back to LLM`);
    
    // Teacher-Student: If LEARNING_MODE is on and V3 has medium confidence, try Teacher first
    if (LEARNING_MODE && anthropic && parsed && parsed.confidence >= CONFIDENCE_THRESHOLD_LOW) {
      const teacherStart = Date.now();
      try {
        console.log(`👨‍🏫 Teacher parsing (V3 confidence ${parsed.confidence} < 0.8)...`);
        teacherResult = await parseWithTeacher(analyzedText, nowISO, langHint);
        latencyMs.teacher = Date.now() - teacherStart;
        
        // Compare and use Teacher
        comparison = compareResults(parsed, teacherResult);
        decision = 'teacher_primary';
        
        // Save gold log
        try {
          await saveGoldLog({
            ts: new Date().toISOString(),
            user_id: userId,
            session_id: req.requestId,
            asr_text: raw,
            normalized_text: norm,
            v3_result: parsed,
            teacher_result: teacherResult,
            decision: decision,
            discrepancies: comparison.discrepancies,
            used_triggers: usedTriggers,
            latency_ms: latencyMs,
            am_pm_decision: parsed._am_pm_decision || null,
            desc_had_time_tokens_removed: parsed._desc_had_time_tokens_removed || false,
            confidence_before: parsed._confidence_before || null,
            confidence_after: parsed._confidence_after || parsed.confidence || null,
            telemetry: parsed._telemetry || null
          });
        } catch (logError) {
          // Ignore
        }
        
        // Use Teacher result
        const finalResult = teacherResult;
        finalResult.raw_transcript = raw;
        finalResult.normalized_transcript = norm;
        finalResult.analyzed_transcript = analyzedText;
        finalResult.analysis_applied = needsAnalysis;
        finalResult.confidence = score;
        finalResult.learning_mode = {
          decision: decision,
          v3_confidence: parsed.confidence,
          teacher_used: true,
          has_discrepancy: comparison.hasDiscrepancy,
          discrepancy_severity: comparison.discrepancies.severity,
          triggers: usedTriggers,
          latency_ms: latencyMs
        };
        finalResult.quota = {
          plan: limits.plan,
          dailyLimit: normalizeDaily(limits.dailyLimit),
          dailyUsed: u.daily.used + 1,
          dailyRemaining: limits.dailyLimit >= 999999 ? null : Math.max(0, limits.dailyLimit - u.daily.used - 1),
          dailyGraceLimit: GRACE_DAILY,
          dailyGraceUsed: u.daily.graceUsed
        };
        if (limits.plan === 'pro') {
          finalResult.quota.monthlyLimit = limits.monthlyLimit;
          finalResult.quota.monthlyUsed = u.monthly.used + 1;
          finalResult.quota.monthlyRemaining = Math.max(0, limits.monthlyLimit - u.monthly.used - 1);
        }
        finalResult.requestId = req.requestId;
        u.daily.used += 1;
        await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed);
        latencyMs.total = Date.now() - processingStart;
        audioProcessingTime.observe({ status: "success" }, latencyMs.total);
        logTranscriptFlow(req, res, raw, norm, analyzedText, needsAnalysis, score, finalResult);
        return res.json(finalResult);
      } catch (teacherError) {
        console.warn(`⚠️ Teacher parsing failed: ${teacherError.message}, falling back to LLM`);
        // Continue to LLM fallback
      }
    }
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
