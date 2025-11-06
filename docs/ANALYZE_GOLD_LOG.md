# 📊 V3 Gold Log Analīze

## 🎯 Kāpēc šis dokuments?

Lai redzētu, kā Teacher-Student sistēma strādā:
- Cik daudz tiek izmantots V3 vs Teacher (Claude)
- Kādi ir discrepancy rates
- Kā sistēma mācās
- Kādi ir confidence levels
- Kādi ir AM/PM decisions

---

## 🛠️ Kā izmantot

### **Opcija 1: Node.js skripts (ieteicams)**

```bash
# Lokāli
cd /Users/ojars/Documents/GitHub/voice-agent
node analyze-gold-log.js

# Ar custom DB path
DB_PATH=/path/to/quota.db node analyze-gold-log.js
```

**Output piemērs:**
```
📊 V3 Gold Log Analyzer
============================================================
Database: /app/quota.db

📈 TOTAL REQUESTS: 150

🎯 DECISION BREAKDOWN:
   v3                   120 (80.00%)
   teacher_validate      25 (16.67%)
   teacher_primary        5 (3.33%)

👨‍🏫 TEACHER INVOCATION RATE: 20.00%
   Total invoked: 30 / 150

⚠️  DISCREPANCY STATISTICS:
   Total with discrepancies: 12 / 150 (8.00%)
   Severity breakdown:
     high           2 (16.7%)
     mid            5 (41.7%)
     low            5 (41.7%)

📊 CONFIDENCE STATISTICS:
   Average: 0.875
   Range: 0.450 - 0.950
   Low (<0.5): 3
   Medium (0.5-0.8): 15
   High (>=0.8): 132
...
```

### **Opcija 2: SQL vaicājumi**

```bash
# Railway shell
railway shell

# SQLite
sqlite3 quota.db < analyze-gold-log.sql

# Vai atsevišķi
sqlite3 quota.db "SELECT decision, COUNT(*) FROM v3_gold_log GROUP BY decision;"
```

### **Opcija 3: Railway Dashboard**

1. Railway Dashboard → Service → "Deployments"
2. Find latest deployment
3. "View Logs" → "Shell"
4. Run: `sqlite3 quota.db` un izpildi vaicājumus

---

## 📊 Galvenie KPIs

### **1. Teacher Invocation Rate**
- **Mērķis:** 20-30% (ne pārāk daudz, bet pietiekami, lai mācītos)
- **Formula:** `teacher_invoked / total_requests * 100`

### **2. Discrepancy Rate**
- **Mērķis:** < 10%
- **Formula:** `with_discrepancies / total_requests * 100`

### **3. High Severity Rate**
- **Mērķis:** < 2%
- **Formula:** `high_severity / total_discrepancies * 100`

### **4. Agreement Rate**
- **Mērķis:** > 70% (kad Teacher tiek izsaukts, vairums gadījumu saskan ar V3)
- **Formula:** `agreed / teacher_invoked * 100`

### **5. Average Confidence**
- **Mērķis:** > 0.80
- **Formula:** `AVG(confidence_after)`

---

## 🔍 Kā sistēma mācās

### **1. Gold Log saglabāšana**

Katru reizi, kad sistēma parsē tekstu:
- ✅ V3 rezultāts tiek saglabāts
- ✅ Teacher rezultāts tiek saglabāts (ja izsaukts)
- ✅ Decision (v3/teacher_validate/teacher_primary) tiek saglabāts
- ✅ Discrepancies tiek saglabāti (ja ir)
- ✅ Confidence (before/after) tiek saglabāts
- ✅ Triggers tiek saglabāti
- ✅ AM/PM decision tiek saglabāts

### **2. Discrepancy analīze**

Kad V3 un Teacher nesaskan:
- ✅ Tiek identificēts, kurš lauks atšķiras (time/date/place)
- ✅ Tiek noteikts severity (high/mid/low)
- ✅ Tiek pievienoti tags (am_pm, time_large_diff, utt.)
- ✅ Tiek saglabāts gold log

### **3. Confidence re-kalibrācija**

Pēc plauzibilitātes:
- ✅ Confidence tiek pazemināts, ja ir problēmas
- ✅ Confidence tiek paaugstināts, ja Teacher saskan ar V3
- ✅ Ja confidence < 0.80 → trigger Teacher validate

### **4. Mācīšanās no datiem**

**Manuāla analīze:**
1. Pārskatīt high severity discrepancies
2. Identificēt sistēmiskas kļūdas
3. Uzlabot V3 parser loģiku
4. Testēt uzlabojumus

**Automātiska analīze (nākotnē):**
- Grupēt discrepancies pēc tipa
- Ģenerēt priekšlikumus V3 uzlabošanai
- A/B testing ar uzlabojumiem

---

## 📈 Piemēri vaicājumu

### **Cik daudz Teacher tiek izmantots?**

```sql
SELECT 
  COUNT(*) as total,
  COUNT(CASE WHEN teacher_result IS NOT NULL THEN 1 END) as teacher_count,
  ROUND(COUNT(CASE WHEN teacher_result IS NOT NULL THEN 1 END) * 100.0 / COUNT(*), 2) as rate
FROM v3_gold_log;
```

### **Kādi ir top AM/PM decisions?**

```sql
SELECT 
  am_pm_decision,
  COUNT(*) as count
FROM v3_gold_log
WHERE am_pm_decision IS NOT NULL
GROUP BY am_pm_decision
ORDER BY count DESC;
```

### **Kādi ir high severity discrepancies?**

```sql
SELECT 
  ts,
  asr_text,
  decision,
  JSON_EXTRACT(discrepancies, '$.severity') as severity
FROM v3_gold_log
WHERE JSON_EXTRACT(discrepancies, '$.severity') = 'high'
ORDER BY ts DESC
LIMIT 10;
```

### **Kā mainās confidence pēc re-kalibrācijas?**

```sql
SELECT 
  AVG(confidence_before) as avg_before,
  AVG(confidence_after) as avg_after,
  AVG(confidence_after - confidence_before) as avg_adjustment
FROM v3_gold_log
WHERE confidence_before IS NOT NULL 
  AND confidence_after IS NOT NULL;
```

---

## 🚀 Nākamie soļi

1. **Periodiska analīze:** Pievienot cron job, kas ikdienas ģenerē report
2. **Dashboard:** Izveidot web dashboard ar real-time statistiku
3. **Alerts:** Pievienot alerts, ja discrepancy rate > 15%
4. **Automātiska uzlabošana:** Ģenerēt priekšlikumus no discrepancies

---

## 📝 Piezīmes

- Gold log tiek saglabāts katru reizi, kad sistēma parsē tekstu
- Ja Teacher nav izsaukts, `teacher_result` būs `NULL`
- Ja nav discrepancies, `discrepancies` būs `{}` vai `null`
- Confidence tiek saglabāts gan `before`, gan `after` re-kalibrācijas

