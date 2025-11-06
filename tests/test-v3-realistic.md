# Parser V3 Realistic Test Examples

## Reālistiski testa piemēri (kā cilvēki tiešām runā)

### 1. Tikšanās ar laiku
**Frāze:** "Rīt desmitos tikšanās"
**Sagaidāms:** `calendar`, start: 2025-11-06T10:00:00+02:00

### 2. Tikšanās ar personu
**Frāze:** "Rīt desmitos tikšanās ar Jāni"
**Sagaidāms:** `calendar`, start: 2025-11-06T10:00:00+02:00, description: "Tikšanās ar Jāni"

### 3. Sapulce ar laiku un vietu
**Frāze:** "Sapulce ar Jāni rīt desmitos Zoom"
**Sagaidāms:** `calendar`, start: 2025-11-06T10:00:00+02:00

### 4. Tikšanās ar vārdisko laiku
**Frāze:** "Rīt deviņos tikšanās"
**Sagaidāms:** `calendar`, start: 2025-11-06T09:00:00+02:00

### 5. Tikšanās ar nedēļas dienu
**Frāze:** "Pirmdien tikšanās ar Jāni"
**Sagaidāms:** `calendar`, start: nākamā pirmdiena (ar default laiku vai no rīta)

### 6. Shopping ar vairākiem produktiem
**Frāze:** "Nopirkt piens, maize, olas"
**Sagaidāms:** `shopping`, items: "piens, maize, olas"

### 7. Atgādinājums ar laiku
**Frāze:** "Atgādināt man rīt desmitos"
**Sagaidāms:** `reminder`, start: 2025-11-06T10:00:00+02:00

### 8. Tikšanās ar diennakts daļu
**Frāze:** "Rīt no rīta tikšanās ar Jāni"
**Sagaidāms:** `calendar`, start: 2025-11-06T09:00:00+02:00

### 9. Intervāls ar kontekstu
**Frāze:** "No 9 līdz 11 rīt tikšanās"
**Sagaidāms:** `calendar`, start: 09:00, end: 11:00

### 10. Relatīvs laiks ar kontekstu
**Frāze:** "Pēc stundas atgādināt man"
**Sagaidāms:** `reminder`, start: ~1h no tagad

