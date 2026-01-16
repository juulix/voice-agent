# Parser V3 Test Examples

## 10 testa piemēri

### 1. Vienkāršs laiks ar datumu
**Frāze:** "Rīt 10:00"
**Sagaidāms:** `calendar`, start: 2025-11-06T10:00:00+02:00

### 2. Vārdisks laiks
**Frāze:** "Rīt desmitos"
**Sagaidāms:** `calendar`, start: 2025-11-06T10:00:00+02:00

### 3. Vārdisks laiks ar minūtēm
**Frāze:** "Rīt deviņos trīsdesmit"
**Sagaidāms:** `calendar`, start: 2025-11-06T09:30:00+02:00

### 4. Nedēļas diena
**Frāze:** "Pirmdien 15:00"
**Sagaidāms:** `calendar`, start: 2025-11-10T15:00:00+02:00 (nākamā pirmdiena)

### 5. Diennakts daļa
**Frāze:** "Rīt no rīta"
**Sagaidāms:** `calendar`, start: 2025-11-06T09:00:00+02:00

### 6. Intervāls
**Frāze:** "No 9 līdz 11 rīt"
**Sagaidāms:** `calendar`, start: 09:00, end: 11:00

### 7. Shopping
**Frāze:** "Nopirkt piens, maize, olas"
**Sagaidāms:** `shopping`, items: "piens, maize, olas"

### 8. Relatīvs laiks
**Frāze:** "Pēc stundas"
**Sagaidāms:** `reminder`, start: ~1h no tagad

### 9. Pusdeviņos (edge case)
**Frāze:** "Pusdeviņos rīt"
**Sagaidāms:** `calendar`, start: 2025-11-06T08:30:00+02:00

### 10. Sarežģīts
**Frāze:** "Sapulce ar Jāni rīt desmitos Zoom"
**Sagaidāms:** `calendar`, start: 2025-11-06T10:00:00+02:00

