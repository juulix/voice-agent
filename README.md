
# Voice Agent (audio → text → JSON)

Minimal Node.js server:
- POST /ingest-audio  (multipart/form-data: file=<audio>)
- Uses OpenAI Whisper (gpt-4o-mini-transcribe) and GPT-4.1-mini to return structured JSON.

## Run locally
1) Node 18+
2) `npm i`
3) Set env:
   - `OPENAI_API_KEY=...`
   - optional `APP_BEARER_TOKEN=secret123`
4) `npm start`

## Test
curl example:
curl -X POST http://localhost:3000/ingest-audio   -H "Authorization: Bearer secret123"   -F "file=@sample.m4a"
