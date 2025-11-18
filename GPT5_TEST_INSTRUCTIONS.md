# GPT-5 mini un GPT-5 nano testa instrukcijas

## ✅ Izmaiņas

1. **Pievienoti testa endpointi:**
   - `POST /test-parse-gpt5-mini` - testē GPT-5 mini
   - `POST /test-parse-gpt5-nano` - testē GPT-5 nano

2. **Parametru noņemšana:**
   - ✅ `temperature` - noņemts GPT-5 modeļiem (tie izmanto fiksētu vērtību)
   - ✅ `top_p` - nav izmantots (nav jānoņem)
   - ✅ `logprobs` - nav izmantots (nav jānoņem)
   - ✅ `frequency_penalty` - nav izmantots (nav jānoņem)
   - ✅ `presence_penalty` - nav izmantots (nav jānoņem)

3. **Saglabātie parametri:**
   - ✅ `response_format: { type: "json_object" }` - saglabāts
   - ✅ `max_tokens: 1000` - saglabāts
   - ✅ Visi system un user prompti - identiski GPT-4.1 mini

## 🧪 Testa piemēri

### Testēt GPT-5 mini:

```bash
curl -X POST http://localhost:3000/test-parse-gpt5-mini \
  -H "Content-Type: application/json" \
  -d '{"text": "Rīt pulksten divos tikšanās ar Jāni"}'
```

### Testēt GPT-5 nano:

```bash
curl -X POST http://localhost:3000/test-parse-gpt5-nano \
  -H "Content-Type: application/json" \
  -d '{"text": "Rīt pulksten divos tikšanās ar Jāni"}'
```

### Salīdzināt ar GPT-4.1 mini (baseline):

```bash
curl -X POST http://localhost:3000/test-parse \
  -H "Content-Type: application/json" \
  -d '{"text": "Rīt pulksten divos tikšanās ar Jāni"}'
```

## 📊 Pārbaudāmie aspekti

### 1. JSON struktūra
- ✅ Vai izvade ir tīrs JSON (bez markdown)?
- ✅ Vai nav papildu teksta pirms/pēc JSON?

### 2. Lauku konsekvence
- ✅ `title` / `description` - vai tiek ģenerēts konsekventi?
- ✅ `time` / `start` - vai laiks ir pareizs?
- ✅ `type` - vai tips (reminder/calendar/shopping) ir pareizs?

### 3. Uzvedības atšķirības
- ⚠️ GPT-5 mini/nano var būt nedaudz mazāk determinēti (neliels stohastiskums)
- ⚠️ Atbildes laiks var būt par 20–40% ātrāks
- ⚠️ Izmaksas var būt 2–5× zemākas

### 4. Reģionālie ierobežojumi
- ⚠️ Dažos reģionos (EU datu centri) nano modelis var vēl nebūt aktīvs
- Ja API atgriež "model not found", testu izlaiž

## 🔍 Testa scenāriji

### Scenārijs 1: Vienkāršs reminder
```json
{"text": "Rīt pulksten deviņos atgādini man zvanīt mammai"}
```
**Paredzamais rezultāts:**
- `type: "reminder"`
- `description: "Atgādinājums zvanīt mammai"` vai līdzīgs
- `start: "2025-XX-XXT09:00:00+02:00"` (rīt 9:00)
- `hasTime: true`

### Scenārijs 2: Calendar ar datumu
```json
{"text": "20. novembrī pulksten 14 budžeta izskatīšana"}
```
**Paredzamais rezultāts:**
- `type: "calendar"`
- `description: "Budžeta izskatīšana"`
- `start: "2025-11-20T14:00:00+02:00"`
- `end: "2025-11-20T15:00:00+02:00"` (automātiski +1h)

### Scenārijs 3: Shopping list
```json
{"text": "pievieno piens, maize, olas"}
```
**Paredzamais rezultāts:**
- `type: "shopping"`
- `items: "piens, maize, olas"`

### Scenārijs 4: Vairāki reminder (multi-item)
```json
{"text": "uztaisi trīs atgādinājumus: rīt plkst 9, pirmdien plkst 14, trešdien plkst 18"}
```
**Paredzamais rezultāts:**
- `type: "reminders"`
- `reminders: [...]` (masīvs ar 3 reminder objektiem)

## 📝 Rezultātu salīdzināšana

Pēc katra testa salīdzini:

1. **Struktūra:** Vai JSON struktūra ir identiska GPT-4.1 mini?
2. **Lauki:** Vai visi lauki (`title`, `time`, `type`) ir pareizi?
3. **Kvalitāte:** Vai izvade ir tikpat laba vai labāka?
4. **Ātrums:** Cik ilgi aizņēma API izsaukums?
5. **Izmaksas:** Cik maksāja (ja ir piekļuve OpenAI izmaksu logiem)?

## ⚠️ Svarīgi

- **Nemaini esošos promptus** - visi system un user prompti paliek tie paši
- **Neatbalstīti parametri** - GPT-5 mini/nano neatbalsta `temperature`, `top_p`, `logprobs`, `frequency_penalty`, `presence_penalty`
- **JSON izvade** - `response_format: { type: "json_object" }` darbojas arī GPT-5 modeļiem
- **Reģionālie ierobežojumi** - ja modelis nav pieejams, API atgriezīs 404 ar `model_not_found` kļūdu

## 🚀 Nākamie soļi

1. Testēt abus modeļus ar dažādiem ievades tekstiem
2. Salīdzināt rezultātus ar GPT-4.1 mini baseline
3. Novērtēt ātrumu un izmaksas
4. Ja rezultāti ir labi, var apsvērt pārslēgšanos uz GPT-5 mini/nano production









