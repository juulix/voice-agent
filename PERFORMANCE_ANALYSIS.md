# 🚀 Servera ātruma analīze un optimizācijas ieteikumi

**Datums:** 2025-01-XX  
**Mērķis:** Identificēt un uzlabot servera atbildes laiku, nesamazinot kvalitāti

---

## 📊 Pašreizējā plūsma (secīga)

```
1. Auth check (0-5ms)
2. Idempotency check (0-2ms)
3. getUserUsage() - DB query (5-20ms)
4. Busboy multipart parsing (10-50ms)
5. VAD validation (0-1ms)
6. Whisper transcription (500-3000ms) ⏱️ GALVENAIS IEROBEŽOJUMS
7. Normalization + quality score (1-5ms)
8. parseWithGPT41() - GPT API call (300-1500ms) ⏱️ OTRAIS IEROBEŽOJUMS
9. updateQuotaUsage() - DB update (5-20ms)
10. Response (0-5ms)
```

**Kopējais laiks:** ~800-4500ms (vidēji ~2000ms)

---

## 🎯 Identificētie optimizācijas iespējas

### 1. ⚡ **Prompt optimizācija** (HIGH IMPACT, LOW RISK)

**Problēma:**
- System prompt ir ļoti garš (~2000+ tokens)
- GPT-4.1-mini apstrāde aizņem vairāk laika ar garākiem promptiem
- Daudz piemēru, kas var būt pārāk detalizēti

**Pašreizējais prompt:**
- ~530 rindas koda
- 6 detalizēti piemēri ar JSON
- Daudz atkārtojošas informācijas

**Optimizācija:**
```javascript
// SAMAZINĀT no ~2000 tokens uz ~800-1000 tokens
// - Noņemt atkārtojošos piemērus (pietiek ar 2-3)
// - Saīsināt instrukcijas, saglabājot kritiskos punktus
// - Izmantot kompaktāku formātu
```

**Paredzamais ietaupījums:** 200-500ms (10-25% ātrāk)  
**Risks:** Zems - tikai prompta optimizācija, loģika paliek tāda pati  
**Kvalitāte:** Nav ietekmes - GPT saprot arī saīsinātus promptus

---

### 2. 🔄 **Paralelizācija: Quota update** (MEDIUM IMPACT, LOW RISK)

**Problēma:**
- `updateQuotaUsage()` tiek izsaukts pēc GPT parsēšanas
- Lietotājs gaida, kamēr DB tiek atjaunināts pirms atbildes

**Optimizācija:**
```javascript
// Atjaunināt kvotu ASINHRONI (nebloķēt atbildi)
await updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed);

// MAINĪT UZ:
updateQuotaUsage(userId, limits.plan, u.daily.used, u.daily.graceUsed)
  .catch(err => console.error('Quota update failed:', err));
// Nav await - atbildi nosūtam uzreiz
```

**Paredzamais ietaupījums:** 5-20ms (mazs, bet kumulatīvi)  
**Risks:** Zems - ja DB update neizdodas, tas nav kritisks  
**Kvalitāte:** Nav ietekmes

---

### 3. 📝 **GPT max_tokens optimizācija** (LOW-MEDIUM IMPACT, NO RISK)

**Problēma:**
- `max_tokens: 500` - pārāk daudz, mūsu JSON ir ~100-200 tokens
- GPT var izmantot vairāk laika, lai ģenerētu garāku atbildi

**Optimizācija:**
```javascript
max_tokens: 300  // Pietiek ar mazu rezervi
```

**Paredzamais ietaupījums:** 50-150ms (3-8% ātrāk)  
**Risks:** Nav - mūsu JSON struktūra ir fiksēta un īsa  
**Kvalitāte:** Nav ietekmes - tikai ierobežo maksimālo garumu

---

### 4. 🗄️ **Database query optimizācija** (LOW-MEDIUM IMPACT, MEDIUM RISK)

**Problēma:**
- `getUserUsage()` veic 2-3 secīgus DB vaicājumus
- SQLite ar WAL režīmu jau ir optimizēts, bet var uzlabot

**Optimizācija:**
```javascript
// Izmantot UPSERT (INSERT ... ON CONFLICT) vienā vaicājumā
db.run(`
  INSERT INTO quota_usage (user_id, plan, day_key, month_key, daily_used, daily_grace_used, monthly_used)
  VALUES (?, ?, ?, ?, 0, 0, 0)
  ON CONFLICT(user_id, day_key) DO UPDATE SET plan = excluded.plan
`, [userId, limits.plan, today, mKey]);
```

**Paredzamais ietaupījums:** 2-10ms (mazs)  
**Risks:** Vidējs - jāpārbauda SQLite versija (3.24.0+)  
**Kvalitāte:** Nav ietekmes

---

### 5. 🎤 **Whisper retry optimizācija** (LOW IMPACT, LOW RISK)

**Problēma:**
- Retry loģika ar exponential backoff (500ms, 1000ms, 2000ms)
- Ja Whisper neizdodas, lietotājs gaida ilgi

**Optimizācija:**
```javascript
// Samazināt retry skaitu no 3 uz 2 (retry 1x, nevis 2x)
const transcriptionMaxRetries = 2; // No 3 uz 2

// Vai arī samazināt backoff laiku
const delay = 300 * Math.pow(2, transcriptionRetryCount - 1); // No 500ms uz 300ms
```

**Paredzamais ietaupījums:** 0-2000ms (tikai ja ir kļūdas)  
**Risks:** Zems - retry joprojām darbojas, bet ātrāk  
**Kvalitāte:** Nav ietekmes - retry joprojām notiek

---

### 6. 🔍 **Idempotency cache optimizācija** (LOW IMPACT, NO RISK)

**Problēma:**
- In-memory cache nav optimizēts
- Nav TTL cleanup mehānisma

**Optimizācija:**
```javascript
// Pievienot TTL cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of idempotency.entries()) {
    if (value.expires < now) {
      idempotency.delete(key);
    }
  }
}, 60000); // Katru minūti
```

**Paredzamais ietaupījums:** 0ms (tikai memory cleanup)  
**Risks:** Nav  
**Kvalitāte:** Nav ietekmes

---

## 📈 Prioritāšu saraksts

### 🔴 **HIGH PRIORITY** (lielākais ietekme, mazākais risks)

1. **Prompt optimizācija** (200-500ms ietaupījums)
   - Viegli implementējams
   - Nav koda izmaiņu loģikā
   - Nav kvalitātes ietekmes

2. **GPT max_tokens samazināšana** (50-150ms ietaupījums)
   - Vienas rindas izmaiņa
   - Nav risku

### 🟡 **MEDIUM PRIORITY** (vidēja ietekme)

3. **Paralelizācija: Quota update** (5-20ms ietaupījums)
   - Neliels ietaupījums, bet kumulatīvi
   - Viegli implementējams

4. **Whisper retry optimizācija** (0-2000ms, tikai ja kļūdas)
   - Palīdz tikai retry scenārijos
   - Viegli implementējams

### 🟢 **LOW PRIORITY** (maza ietekme)

5. **Database query optimizācija** (2-10ms ietekme)
   - Neliels ietaupījums
   - Prasa pārbaudi

6. **Idempotency cache cleanup** (0ms, tikai memory)
   - Nav ātruma ietekmes
   - Tikai memory optimizācija

---

## 🎯 Ieteicamā implementācijas secība

### Fāze 1: Quick Wins (0 risks, ~250-650ms ietaupījums)
1. ✅ Samazināt `max_tokens` no 500 uz 300
2. ✅ Optimizēt system prompt (samazināt no ~2000 uz ~800-1000 tokens)

### Fāze 2: Paralelizācija (low risk, ~5-20ms ietaupījums)
3. ✅ Quota update paralelizācija

### Fāze 3: Retry optimizācija (low risk, 0-2000ms ja kļūdas)
4. ✅ Whisper retry optimizācija

### Fāze 4: Database (medium risk, 2-10ms ietekme)
5. ⚠️ Database query optimizācija (pēc pārbaudes)

---

## 📊 Paredzamais kopējais ietaupījums

**Optimistisks scenārijs (visas optimizācijas):**
- Prompt: -400ms
- max_tokens: -100ms
- Quota parallel: -15ms
- Retry (ja kļūdas): -1000ms
- **KOPĀ: ~-1515ms (75% ātrāk)**

**Reālistisks scenārijs (tikai Fāze 1-2):**
- Prompt: -300ms
- max_tokens: -75ms
- Quota parallel: -10ms
- **KOPĀ: ~-385ms (19% ātrāk)**

**Pessimistisks scenārijs (tikai Fāze 1):**
- Prompt: -200ms
- max_tokens: -50ms
- **KOPĀ: ~-250ms (12.5% ātrāk)**

---

## ⚠️ Kas NAV ieteicams (risks > benefit)

1. ❌ **Whisper streaming** - nav iespējams ar pašreizējo API
2. ❌ **Response streaming** - nav nepieciešams, mūsu atbildes ir mazas
3. ❌ **Redis cache** - pārāk sarežģīti, mazs benefit
4. ❌ **Connection pooling** - SQLite nav optimizēts tam
5. ❌ **GPT temperature palielināšana** - samazina kvalitāti

---

## 🧪 Testēšanas plāns

Pēc katras optimizācijas:
1. ✅ Testēt ar 10-20 reāliem audio failiem
2. ✅ Pārbaudīt, ka kvalitāte nav pasliktinājusies
3. ✅ Mērīt vidējo atbildes laiku
4. ✅ Pārbaudīt error handling

---

## 📝 Secinājumi

**Galvenie ierobežojumi:**
1. Whisper transcription (500-3000ms) - **nevar optimizēt** (API ierobežojums)
2. GPT-4.1-mini parsing (300-1500ms) - **var optimizēt** (prompt + max_tokens)

**Ieteicamā pieeja:**
- Sākt ar **Fāze 1** (prompt + max_tokens) - lielākais ietaupījums, nav risku
- Pēc tam **Fāze 2** (paralelizācija) - mazs ietaupījums, bet viegli
- **Fāze 3-4** tikai ja nepieciešams papildu ietaupījums

**Paredzamais rezultāts:** 12-20% ātrāka atbilde bez kvalitātes samazināšanas



