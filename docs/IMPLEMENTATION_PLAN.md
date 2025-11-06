# Implementation Plan: V3 Parser Precision Improvements

## Status: Analysis & Planning

### ✅ JAU IZVEIDOTS (no iepriekšējām izmaiņām):
1. ✅ Description cleaning ar normalizāciju (artefakti)
2. ✅ Datums vs. stunda disambigējums (date-first precedence)
3. ✅ AM/PM konflikts (evening > morning override)
4. ✅ Biznesa default (weekday + meeting + early hour → PM)
5. ✅ Teacher trigeri (date_range, mixed_numerics, weekday_early_hour_meeting)
6. ✅ 12:00 marķējums (noon, nevis AM)

### ⚠️ VĒL JĀVEIC:

#### 1. Feature Flags (rollback plāns)
- `DAY_EVENING_DEFAULT=on|off` (default: on)
- `ABSOLUTE_DATE_FIRST=on|off` (default: on)
- `WEEKDAY_EARLY_PM=on|off` (default: on)

#### 2. Vārdu skaitļi 13-23 (stundas)
- Pievienot hourWords mapē: trīspadsmitos, četrpadsmitos, piecpadsmitos, sešpadsmitos, septiņpadsmitos, astoņpadsmitos, deviņpadsmitos, divdesmit viens, divdesmit divi, divdesmit trīs
- "rīt astoņpadsmit nulles nulles" → 18:00, tips=calendar

#### 3. Dienas/Vakara prioritāte (plašāka heuristika)
- Ja nav "no rīta" un nav "naktī" → pieņem dienu/vakaru
- Ja stunda ∈ [1..7] un nav daypart → +12h (ne tikai biznesa)
- Ja stunda ∈ [8..11] → atstāj AM
- Ja stunda ≥ 12 → atstāj kā ir

#### 4. Intervālu loģika
- Ja abi gali < 8 un nav daypart → abiem +12h
- Ja start < end < 12 un nav daypart → atstāj AM

#### 5. Confidence re-kalibrācija
- −0.35 ja weekday_early_hour_without_daypart + aktivitāte
- −0.25 ja desc_had_time_tokens_removed
- −0.20 ja absolute_date_detected && relative_path_used
- +0.15 ja teacher_agreed

#### 6. Gold Log papildinājumi
- Pievienot laukus: `am_pm_decision`, `desc_had_time_tokens_removed`, `confidence_before`, `confidence_after`
- ALTER TABLE pievienot kolonnas (backward compatible)

#### 7. Past-drift guard
- Ja absolūts datums iznāk pagātnē → nepieņem automātiski
- Ja frāzē "šogad/šomēnes" → atstāj šogad
- Citādi prefer next year vai atgriez precisējošu statusu

#### 8. Ordinals (piecpadsmitajā = 15. diena, ne minūtes)
- Jāpārbauda, ka ordinals tiek parsēti kā datuma dienas, ne stundas/minūtes

---

## Implementation Order

1. Feature flags (atbalsta struktūra)
2. Vārdu skaitļi 13-23 (vienkāršs pievienojums)
3. Dienas/Vakara prioritāte (paplašina esošo)
4. Intervālu loģika (uzlabo esošo)
5. Confidence re-kalibrācija (jauns slānis)
6. Gold log papildinājumi (DB izmaiņas)
7. Past-drift guard (uzlabo extractDate)
8. Ordinals fix (pārbaude)

