# 🚂 Railway Setup - Teacher-Student Learning Mode

## ✅ Status no logiem

**Kas darbojas:**
- ✅ Serveris startējies
- ✅ V3 parser darbojas
- ✅ Parsēšana veiksmīga

**Kas NAV darbojas:**
- ❌ Teacher-Student mode nav aktivizēts (nav "👨‍🏫 Teacher parsing" logu)

---

## 🔧 Railway Environment Variables

**Lai aktivizētu Teacher-Student mode, iestatīt Railway:**

### 1. Atvērt Railway Dashboard
- Ej uz: https://railway.app
- Izvēlies projektu → Service → Variables

### 2. Pievienot Environment Variables

```bash
# ⚠️ OBLIGĀTI - Aktivizē Teacher-Student mode
LEARNING_MODE=on

# ⚠️ OBLIGĀTI - Claude API Key
ANTHROPIC_API_KEY=sk-ant-...  # vai izmantot ECHOTIME_ONBOARDING_API_KEY ja tā jau ir

# Opcionāli - Konfigurācija (default vērtības jau ir)
TEACHER_MODEL=claude-sonnet-4-20250514
TEACHER_RATE=0.3
CONFIDENCE_THRESHOLD_HIGH=0.8
CONFIDENCE_THRESHOLD_LOW=0.5
STRICT_TRIGGERS=am_pm,interval,relative_multi
```

### 3. Pārbaudīt

**Pēc restart, logiem jābūt:**
```
✅ Voice agent running on 8080
👨‍🏫 Teacher parsing (triggers: am_pm, sampling)...
📊 Gold log saved (decision: teacher_primary)
```

**Ja nav:**
- ❌ `LEARNING_MODE` nav `'on'` → iestatīt `LEARNING_MODE=on`
- ❌ `ANTHROPIC_API_KEY` nav iestatīts → pievienot API key
- ❌ `anthropic` ir `null` → pārbaudīt API key formātu

---

## 🔑 Claude API Key

**Kur iegūt:**
1. Ej uz: https://console.anthropic.com/
2. Settings → API Keys
3. Create Key → kopēt `sk-ant-...`

**Vai izmantot esošo:**
- Ja jau ir `ECHOTIME_ONBOARDING_API_KEY` Railway → var izmantot to pašu
- Vai pievienot kā `ANTHROPIC_API_KEY`

---

## 📊 Kā pārbaudīt, vai darbojas

### 1. **Testēt ar triggeri:**
```
"Rīt deviņos tikšanās ar Juri vakarā"
```
**Paredzētais rezultāts:**
- 🔍 Detekts `am_pm` trigger
- 👨‍🏫 Teacher parsing izsaukts
- 📊 Gold log saglabāts

### 2. **Pārbaudīt logus:**
```bash
# Railway logiem jābūt:
👨‍🏫 Teacher parsing (triggers: am_pm)...
👨‍🏫 Teacher primary (triggers: am_pm, confidence: 0.95)
📊 Gold log saved (decision: teacher_primary)
```

### 3. **Pārbaudīt datubāzi:**
```sql
SELECT COUNT(*) FROM v3_gold_log;
SELECT decision, COUNT(*) FROM v3_gold_log GROUP BY decision;
```

---

## ⚠️ Troubleshooting

### **Problēma: Teacher nav izsaukts**

**Iespējamie iemesli:**
1. `LEARNING_MODE` nav `'on'` → iestatīt `LEARNING_MODE=on`
2. `ANTHROPIC_API_KEY` nav iestatīts → pievienot API key
3. `anthropic` ir `null` → pārbaudīt API key formātu
4. Nav triggernu → Teacher izsaukts tikai ar triggeri vai low confidence

**Debug:**
```javascript
// Pievienot index.js pēc līnijas 19:
console.log('🔍 Learning Mode:', LEARNING_MODE);
console.log('🔍 Anthropic:', anthropic ? 'initialized' : 'null');
console.log('🔍 Teacher Model:', TEACHER_MODEL);
```

### **Problēma: Teacher izsaukts, bet fails**

**Iespējamie iemesli:**
1. Claude API key nav derīgs → pārbaudīt console.anthropic.com
2. Claude API rate limit → pagaidīt vai pārbaudīt quota
3. Network error → pārbaudīt Railway network

**Debug:**
- Skatīt logus: `⚠️ Teacher parsing failed: ...`
- Pārbaudīt Claude API status: https://status.anthropic.com/

---

## 📝 Summary

**Lai aktivizēt Teacher-Student mode:**
1. ✅ Pievienot `LEARNING_MODE=on` Railway
2. ✅ Pievienot `ANTHROPIC_API_KEY=sk-ant-...` Railway
3. ✅ Restart Railway service
4. ✅ Pārbaudīt logus

**Status:** ⏳ Gaida Railway environment variables iestatīšanu

