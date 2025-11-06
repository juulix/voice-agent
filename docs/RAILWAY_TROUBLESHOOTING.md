# 🔧 Railway Troubleshooting - Teacher-Student Mode

## ✅ Status

**Kas darbojas:**
- ✅ Teksta plūsma logēšana (Whisper → V3 → GPT → Client)
- ✅ Kods meklē `ANTHROPIC_API_KEY` un `echotime-onboarding-api-key`
- ✅ API key ir derīgs (curl tests izdevās)

**Kas NAV darbojas:**
- ❌ Railway nav restartējis servisu pēc environment variable izmaiņām
- ❌ Logi nav redzami (varbūt serviss nav darbojas)

---

## 🔍 Pārbaude

### 1. **Railway Dashboard**

Ej uz: https://railway.app → Service → Variables

**Pārbaudīt:**
- ✅ `ANTHROPIC_API_KEY` ir iestatīts?
- ✅ `LEARNING_MODE=ON` ir iestatīts?
- ✅ Vērtības ir saglabātas?

### 2. **Railway Restart**

**Opcija A: Automātisks restart**
- Railway restartē automātiski, kad mainās environment variables
- Bet var būt aizņemts 1-2 minūtes

**Opcija B: Manuāls restart**
- Railway Dashboard → Service → Settings → Restart

### 3. **Pārbaudīt Logs**

**Railway Dashboard → Service → Logs**

**Paredzētie logi:**
```
🔍 Teacher-Student Learning Mode: ON
🔍 Found related env vars: ANTHROPIC_API_KEY
   ANTHROPIC_API_KEY: length=72, preview=sk-ant-api...AAA
🔍 Anthropic API Key: found ✅ (ANTHROPIC_API_KEY)
🔍 Anthropic API: initialized ✅
✅ Teacher-Student mode ready: model=claude-sonnet-4-20250514...
```

---

## ⚠️ Ja nav logu

**Iespējamie iemesli:**
1. **Serviss nav darbojas** → Pārbaudīt Railway Dashboard → Service status
2. **Nav restartējis** → Restart servisu manuāli
3. **Nepareizs laika periods** → Izvēlēties "Last 24 hours" vai "All time"
4. **Nav deployment** → Pārbaudīt Railway Dashboard → Deployments

---

## 🚀 Quick Fix

**Ja `ANTHROPIC_API_KEY` ir iestatīts:**
1. Restart Railway servisu (manuāli)
2. Pagaidīt 1-2 minūtes
3. Pārbaudīt logus

**Paredzētais rezultāts:**
- ✅ Teacher-Student mode aktivizēts
- ✅ Anthropic API inicializēts
- ✅ Logi rāda "Teacher-Student mode ready"

---

## 📊 Pēc Aktivizācijas

**Kad Teacher-Student mode darbojas, logiem būs:**
```
👨‍🏫 Teacher parsing (triggers: am_pm, sampling)...
👨‍🏫 Teacher primary (triggers: am_pm, confidence: 0.95)
📊 Gold log saved (decision: teacher_primary)
✅ Using Teacher result (teacher_primary)
```

**Ja nav triggeri:**
- Teacher izsaukts tikai ar sampling (30% no high confidence)
- Vai arī ar low/medium confidence

---

**Status:** ⏳ Gaida Railway restart

