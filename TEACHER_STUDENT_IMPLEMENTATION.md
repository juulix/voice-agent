# ✅ Teacher-Student Learning Mode - Implementācija

**Status:** ✅ MVP implementēts

---

## 📦 Atkarības

**Pievienot package.json:**
```bash
npm install @anthropic-ai/sdk
```

Vai manuāli pievienot `package.json`:
```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.27.0"
  }
}
```

---

## 🔧 Environment Variables (Railway)

```bash
# Teacher-Student Learning Mode
LEARNING_MODE=on
TEACHER_MODEL=claude-sonnet-4-20250514
TEACHER_RATE=0.3
CONFIDENCE_THRESHOLD_HIGH=0.8
CONFIDENCE_THRESHOLD_LOW=0.5
STRICT_TRIGGERS=am_pm,interval,relative_multi

# Claude API Key
ANTHROPIC_API_KEY=sk-ant-...  # vai ECHOTIME_ONBOARDING_API_KEY
```

---

## ✅ Implementēts

### 1. **Claude API Client** ✅
- Pievienots `@anthropic-ai/sdk` import
- Konfigurācija ar `ANTHROPIC_API_KEY` vai `ECHOTIME_ONBOARDING_API_KEY`

### 2. **Feature Flags** ✅
- `LEARNING_MODE` - ieslēdz/vienāk learning mode
- `TEACHER_MODEL` - Claude modelis (default: claude-sonnet-4-20250514)
- `TEACHER_RATE` - sampling rate (default: 0.3 = 30%)
- `CONFIDENCE_THRESHOLD_HIGH/LOW` - sliekšņi (default: 0.8/0.5)
- `STRICT_TRIGGERS` - triggeri (default: am_pm,interval,relative_multi)

### 3. **Teacher Parsing** ✅
- `parseWithTeacher()` - parsē ar Claude
- Izmanto `SYSTEM_PROMPT` (tāds pats kā GPT fallback)
- Atgriež tādu pašu JSON struktūru kā V3

### 4. **Trigger Detection** ✅
- `detectTriggers()` - atpazīst AM/PM, intervālus, relatīvos laikus
- AM/PM: "trijos vakarā", "deviņos no rīta"
- Interval: "no desmitiem līdz četriem"
- Relative multi: "pēc divām stundām rīt"

### 5. **Result Comparison** ✅
- `compareResults()` - salīdzina V3 un Teacher
- Time discrepancy: ≥2h = high, ≥1h = mid, >0h = low
- Date discrepancy: ≥1 day = high, >0 = mid
- Place discrepancy: salīdzina lokācijas vārdus
- AM/PM detection: 12h atšķirība = high severity

### 6. **Decision Logic** ✅
- **Strict triggers OR confidence < 0.5** → `teacher_primary`
- **Confidence 0.50-0.79** → `teacher_validate` (ja ir discrepancy)
- **Confidence ≥ 0.8** → sample ar `TEACHER_RATE`, `v3` (ja nav high discrepancy)

### 7. **Gold Log Database** ✅
- `v3_gold_log` tabula ar indeksiem
- Saglabā: V3 result, Teacher result, decision, discrepancies, triggers, latency
- Automātiski saglabā katru Teacher izsaukumu

### 8. **Paralēlā Parsēšana** ✅
- V3 parsē vienmēr
- Teacher parsē tikai, ja `needsTeacher === true`
- Salīdzina un izlemj, kuru rezultātu izmantot

---

## 📊 Gold Log Shēma

```sql
CREATE TABLE v3_gold_log (
  id INTEGER PRIMARY KEY,
  ts DATETIME,
  user_id TEXT,
  session_id TEXT,
  asr_text TEXT,
  normalized_text TEXT,
  v3_result TEXT,        -- JSON
  teacher_result TEXT,   -- JSON
  decision TEXT,         -- v3|teacher_validate|teacher_primary
  discrepancies TEXT,    -- JSON
  used_triggers TEXT,    -- JSON array
  latency_ms TEXT,       -- JSON {v3, teacher, total}
  severity TEXT,         -- low|mid|high
  created_at DATETIME
);
```

---

## 🔍 Logging

**Console logs:**
```
🧭 Parser v3 attempting parse: "..."
🧭 Parser v3 used (confidence: 0.95): type=calendar, start=...
👨‍🏫 Teacher parsing (triggers: am_pm, sampling)...
👨‍🏫 Teacher primary (triggers: am_pm, confidence: 0.95)
📊 Gold log saved (decision: teacher_primary)
✅ Using Teacher result (teacher_primary)
```

---

## 📈 KPI Queries (vēlāk)

```sql
-- Discrepancy rate
SELECT 
  COUNT(*) FILTER (WHERE discrepancies::json->>'time' = 'true' OR discrepancies::json->>'date' = 'true') * 100.0 / COUNT(*) as discrepancy_rate
FROM v3_gold_log
WHERE ts > datetime('now', '-7 days');

-- AM/PM error rate
SELECT 
  COUNT(*) FILTER (WHERE discrepancies::json->'tags' @> '["am_pm"]') * 100.0 / COUNT(*) as am_pm_error_rate
FROM v3_gold_log
WHERE ts > datetime('now', '-7 days');

-- High severity rate
SELECT 
  COUNT(*) FILTER (WHERE severity = 'high') * 100.0 / COUNT(*) as high_severity_rate
FROM v3_gold_log
WHERE ts > datetime('now', '-7 days');
```

---

## 🚀 Nākamie soļi

1. ✅ **Pievienot `@anthropic-ai/sdk` dependency** (jāinstalē)
2. ✅ **Railway Environment Variables** (jāiestata)
3. ⏳ **Testēt ar reāliem datiem**
4. ⏳ **KPI Dashboard** (opcionāli)

---

**Status:** ✅ Gatavs testēšanai!

