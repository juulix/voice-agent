# 🧪 Servera testēšana bez telefona

## Vienkāršākais veids (curl):

```bash
# Testē ar tekstu
curl -X POST http://localhost:8080/test-parse \
  -H "Content-Type: application/json" \
  -d '{"text": "Rīt pulksten divos tikšanās ar Jāni."}' | jq
```

## Izmantojot testa skriptu:

```bash
# Testē visus standarta scenārijus
./test.sh

# Testē ar custom tekstu
./test.sh "Rīt pulksten divos tikšanās ar Jāni."
```

## Testa scenāriji:

1. **Rīt pulksten divos** - `"Rīt pulksten divos tikšanās ar Jāni."`
2. **Rīt pulksten vienos** - `"Rīt pulksten vienos tikšanās ar Montu."`
3. **Shopping** - `"Nopirkt desu, pieniņu, balto vīnu."`
4. **Multi-reminder** - `"Atgādini man rītnos rīta desmitos iznest miskasti."`

## Production serveris (Railway):

```bash
# Aizstāj ar savu Railway URL
export SERVER_URL="https://your-railway-app.up.railway.app"
./test.sh "Rīt pulksten divos tikšanās ar Jāni."
```

## Kā tas strādā:

1. `/test-parse` endpoint pieņem tīru tekstu (bez audio faila)
2. Izmanto to pašu parsēšanas loģiku kā `/ingest-audio`
3. Parser v2 vienmēr ieslēgts testos
4. Ja Parser v2 neparsē, izmanto LLM fallback
5. Atgriež to pašu JSON struktūru kā `/ingest-audio`

## Rezultāts:

```json
{
  "type": "reminder",
  "lang": "lv",
  "start": "2025-11-05T14:00:00+02:00",
  "description": "Tikšanās ar Jāni.",
  "hasTime": true,
  "raw_transcript": "Rīt pulksten divos tikšanās ar Jāni.",
  "test_mode": true
}
```

