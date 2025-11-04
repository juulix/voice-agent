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
// Models that don't support temperature parameter (only default 1)
const FIXED_TEMP_MODELS = new Set([
  "gpt-4o-mini-transcribe",
  "gpt-5-mini",
  "gpt-realtime",
  // Add other fixed-temp models here as needed
]);

/**
 * Build OpenAI API parameters with automatic temperature handling
 * @param {Object} params - API parameters
 * @param {string} params.model - Model name
 * @param {Array} params.messages - Messages array
 * @param {string} [params.system] - System message (alternative to messages)
 * @param {boolean} [params.json=false] - Use JSON response format
 * @param {number} [params.max=300] - Max completion tokens
 * @param {number|null} [params.temperature=0] - Temperature (0-2), null to omit
 * @returns {Object} OpenAI API parameters
 */
function buildParams({ model, messages, system, json = false, max = 300, temperature = 0 }) {
  const p = {
    model,
    max_completion_tokens: max,
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

  if (json) p.response_format = { type: "json_object" };

  // Only include temperature if the model allows it
  if (!FIXED_TEMP_MODELS.has(model) && temperature != null) {
    p.temperature = temperature;
  }

  return p;
}

/**
 * Safe OpenAI API call with automatic temperature retry
 * @param {Object} params - OpenAI API parameters
 * @returns {Promise} OpenAI API response
 */
async function safeCreate(params) {
  try {
    return await openai.chat.completions.create(params);
  } catch (e) {
    const msg = e?.error?.message || e?.message || "";
    if (msg.includes("temperature") && msg.includes("Only the default (1) value is supported")) {
      // Retry without temperature parameter
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
function parseWithCode(text, nowISO, langHint) {
  try {
    const tz = "Europe/Riga";
    const now = new Date(nowISO);
    const t = (text || "").trim();
    const lower = t.toLowerCase();

    // Shopping detection
    const isShopping = /(nopirkt|pirkt|iepirk|veikal)/i.test(lower);
    if (isShopping) {
      // Extract items by splitting on commas/semicolons and removing trigger words
      const rawItems = t
        .replace(/\b(nopirkt|pirkt|iepirkt|iepirkums|veikal[sa]?|veikalam)\b/gi, "")
        .split(/[;,]/)
        .map(s => s.trim())
        .filter(Boolean);
      const items = rawItems.join(", ");
      return { type: 'shopping', lang: (langHint || 'lv'), items, description: 'Pirkumu saraksts' };
    }

    // Helpers for day words
    const dayMap = {
      'pirmdien': 1, 'pirmdiena': 1, 'pirmdienu': 1,
      'otrdien': 2, 'otrdiena': 2, 'otrdienu': 2,
      'trešdien': 3, 'trešdiena': 3, 'trešdienu': 3,
      'ceturtdien': 4, 'ceturtdiena': 4, 'ceturtdienu': 4,
      'piektdien': 5, 'piektdiena': 5, 'piektdienu': 5,
      'sestdien': 6, 'sestdiena': 6, 'sestdienu': 6,
      'svētdien': 7, 'svētdiena': 7, 'svētdienu': 7
    };

    function nextWeekdayDate(current, targetIsoDay) {
      const cur = new Date(current);
      const curIsoDay = ((cur.getDay() + 6) % 7) + 1; // 1..7
      let offset = targetIsoDay - curIsoDay;
      if (offset <= 0) offset += 7;
      const d = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + offset, 0, 0, 0);
      return d;
    }

    function applyTime(baseDate, hh, mm) {
      const d = new Date(baseDate);
      d.setHours(hh, mm || 0, 0, 0);
      return d;
    }

    // Dayparts
    const hasMorning = /\bno rīta\b/.test(lower);
    const hasNoon = /\bpusdienlaikā\b/.test(lower);
    const hasAfternoon = /\bpēcpusdienā\b/.test(lower);
    const hasEvening = /\bvakarā\b/.test(lower);
    const hasNight = /\bnaktī\b/.test(lower);

    // Time patterns (numeric)
    const mHHMM = lower.match(/\b(\d{1,2}):(\d{2})\b/);
    const mHH = lower.match(/\b(\d{1,2})\b/);
    const isPusdevinos = /pusdeviņos|pusdeviņi|pus deviņos/.test(lower);

    // Time patterns (word-based hours and minutes)
    // Atpazīst arī "pulksten divos", "pulkstenīs divos", "plkst divos"
    const hourWords = [
      ['vienpadsmit', 11], ['divpadsmit', 12],
      ['vienos', 1], ['divos', 2], ['trijos', 3], ['četros', 4], ['piecos', 5], ['sešos', 6], ['septiņos', 7], ['astoņos', 8], ['deviņos', 9], ['desmitos', 10],
      ['viens', 1], ['divi', 2], ['trīs', 3], ['četri', 4], ['pieci', 5], ['seši', 6], ['septiņi', 7], ['astoņi', 8], ['deviņi', 9], ['desmit', 10]
    ];
    const minuteWords = [
      ['trīsdesmit', 30], ['divdesmit', 20], ['piecpadsmit', 15], ['desmit', 10], ['pieci', 5]
    ];
    function extractWordTime(l) {
      let h = null, m = 0;
      // Remove "pulksten", "pulkstenīs", "plkst", "plkst." before matching
      const cleaned = l.replace(/\b(pulksten|pulkstenīs|plkst\.?)\b/gi, '').trim();
      for (const [w, val] of hourWords) {
        if (cleaned.includes(w)) { h = val; break; }
      }
      for (const [w, val] of minuteWords) {
        if (cleaned.includes(w)) { m = val; break; }
      }
      return h != null ? { h, m } : null;
    }
    const wordTime = extractWordTime(lower);
    let startDate = null; let endDate = null;

    // Relative day (atpazīt arī vārda formas "rīta", "parīt")
    let baseDay = new Date(now);
    if (/\b(rīt|rītdien|rīta)\b/.test(lower)) {
      baseDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    } else if (/\b(parīt|parītdien)\b/.test(lower)) {
      baseDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0);
    } else if (/\bšodien\b/.test(lower)) {
      baseDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    } else {
      const dayWord = Object.keys(dayMap).find(w => lower.includes(w));
      if (dayWord) {
        baseDay = nextWeekdayDate(now, dayMap[dayWord]);
      }
    }

    // Interval: "no 9 līdz 11" or "no 09:00 līdz 11:00"
    const mInterval = lower.match(/no\s+(\d{1,2})(?::(\d{2}))?\s+līdz\s+(\d{1,2})(?::(\d{2}))?/);
    if (mInterval) {
      const sh = parseInt(mInterval[1], 10); const sm = mInterval[2] ? parseInt(mInterval[2], 10) : 0;
      const eh = parseInt(mInterval[3], 10); const em = mInterval[4] ? parseInt(mInterval[4], 10) : 0;
      startDate = applyTime(baseDay, sh, sm);
      endDate = applyTime(baseDay, eh, em);
    } else if (isPusdevinos) {
      startDate = applyTime(baseDay, 8, 30);
      endDate = applyTime(baseDay, 9, 30);
    } else if (wordTime) {
      // Prioritizēt vārdiskos laikus (desmitos, deviņos trīsdesmit) pirms skaitliskajiem
      startDate = applyTime(baseDay, wordTime.h, wordTime.m);
      endDate = applyTime(baseDay, ((wordTime.h + 1) % 24), wordTime.m);
    } else if (mHHMM) {
      const hh = parseInt(mHHMM[1], 10); const mm = parseInt(mHHMM[2], 10);
      startDate = applyTime(baseDay, hh, mm);
      endDate = applyTime(baseDay, hh + 1, mm);
    } else if (mHH) {
      const hh = parseInt(mHH[1], 10);
      if (hh >= 0 && hh <= 23) {
        startDate = applyTime(baseDay, hh, 0);
        endDate = applyTime(baseDay, (hh + 1) % 24, 0);
      }
    }

    // Ja nav konkrēta laika, bet ir diennakts daļa, lietot defaults
    if (!startDate) {
      if (hasMorning && !wordTime && !mHHMM && !mHH) {
        startDate = applyTime(baseDay, 9, 0);
        endDate = applyTime(baseDay, 10, 0);
      } else if (hasNoon) {
        startDate = applyTime(baseDay, 12, 0);
        endDate = applyTime(baseDay, 13, 0);
      } else if (hasAfternoon) {
        startDate = applyTime(baseDay, 15, 0);
        endDate = applyTime(baseDay, 16, 0);
      } else if (hasEvening) {
        startDate = applyTime(baseDay, 19, 0);
        endDate = applyTime(baseDay, 20, 0);
      } else if (hasNight) {
        startDate = applyTime(baseDay, 22, 0);
        endDate = applyTime(baseDay, 23, 0);
      }
    }

    if (startDate) {
      const startISO = toRigaISO(startDate);
      const endISO = toRigaISO(endDate || new Date(startDate.getTime() + 60 * 60 * 1000));
      // Heuristic type: if text mentions atgādināt/reminder
      const isReminder = /(atgādin|reminder)/i.test(lower);
      const out = isReminder
        ? { type: 'reminder', lang: (langHint || 'lv'), start: startISO, description: t, hasTime: true }
        : { type: 'calendar', lang: (langHint || 'lv'), start: startISO, end: endISO, description: t };
      return out;
    }

    return null;
  } catch (_e) {
    return null;
  }
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

/* ===== Deterministiskais LV parsētājs ===== */

const SYSTEM_PROMPT = `Tu esi deterministisks latviešu dabiskās valodas parsētājs, kas no īsa teikuma izvada TIKAI TĪRU JSON vienā no trim formām: calendar, reminder vai shopping. Atbilde bez skaidrojumiem, bez teksta ārpus JSON. Temperatūra = 0.

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
              model: "gpt-5-mini",
              messages: [
                { role: "system", content: LV_COMBINED_ANALYSIS_PROMPT },
                { role: "user", content: norm }
              ],
              max: 200,
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
    const nowISO = fields.currentTime || toRigaISO(new Date());
    const tmr = new Date(Date.now() + 24 * 3600 * 1000);
    const tomorrowISO = fields.tomorrowExample || toRigaISO(new Date(tmr.getFullYear(), tmr.getMonth(), tmr.getDate(), 0, 0, 0));

  const userMsg = `currentTime=${nowISO}\ntomorrowExample=${tomorrowISO}\nTeksts: ${analyzedText}`;

  // Feature flags via headers or allowlists (no app update required)
  const headerParserV2 = (req.header("X-Parser") || "").toLowerCase() === "v2";
  const headerQcV2 = (req.header("X-Text-QC") || "").toLowerCase() === "v2";
  const headerShoppingList = (req.header("X-Shopping-Style") || "").toLowerCase() === "list";

  const allowDevices = (process.env.FEATURE_ALLOWLIST_DEVICE_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const allowUsers = (process.env.FEATURE_ALLOWLIST_USER_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const deviceIdHdr = req.header("X-Device-Id") || "";
  const userIdHdr = req.header("X-User-Id") || "";
  const allowlisted = (allowDevices.includes(deviceIdHdr) || allowUsers.includes(userIdHdr));

  const parserV2 = headerParserV2 || allowlisted;
  const qcV2 = headerQcV2 || allowlisted;
  const shoppingStyleList = headerShoppingList || allowlisted;

  // Parsēšana uz JSON (ar v2 kodā, ja ieslēgts; citādi LLM)
  if (qcV2) {
    // hasCommonErrors v2: no diacritics/lowercase heuristics; rely on concrete fixes + score
    // Already achieved by not altering analyzedText here; we just log the mode
    console.log(`🧪 QC v2 enabled`);
  }

  if (parserV2) {
    console.log(`🧭 Parser v2 attempting parse: "${analyzedText}"`);
    const parsed = parseWithCode(analyzedText, nowISO, langHint);
    if (parsed) {
      console.log(`🧭 Parser v2 used: type=${parsed.type}, start=${parsed.start}, end=${parsed.end || 'none'}`);
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
      console.log(`🧭 Parser v2 returned null, falling back to LLM`);
    }
  }

  // Ja v2 neizdevās vai nav ieslēgts – krītam atpakaļ uz LLM
  console.log(`🤖 LLM fallback: parsing with GPT for "${analyzedText.substring(0, 50)}..."`);
  let chat;
  const maxRetries = 2;
  let retryCount = 0;
  
  try {
    while (retryCount <= maxRetries) {
      try {
        chat = await safeCreate(
          buildParams({
            model: "gpt-5-mini",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMsg }
            ],
            json: true,
            max: 300,
            temperature: 0
          })
        );
        console.log(`✅ LLM response received`);
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
      out = JSON.parse(content);
      
      // Validate that out has required fields
      if (!out.type || (!out.description && !out.items)) {
        console.warn(`⚠️ LLM returned invalid JSON, missing type or description. Content: ${content.substring(0, 100)}`);
        // Create fallback reminder
        out = { type: "reminder", lang: langHint || "lv", start: nowISO, description: analyzedText || norm, hasTime: false };
      }
    } catch (parseError) {
      console.error(`❌ JSON parse error: ${parseError.message}`);
      // Create fallback reminder
      out = { type: "reminder", lang: langHint || "lv", start: nowISO, description: analyzedText || norm, hasTime: false };
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
