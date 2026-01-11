/**
 * SmartChat System Prompts
 * Language-specific prompts for the chat assistant
 */

/**
 * Format events for context
 * @param {Array} events - Array of events
 * @param {string} timezone - User's timezone (e.g., 'Europe/Riga')
 * @returns {string} Formatted string
 */
function formatEvents(events, timezone = 'Europe/Riga') {
  if (!events || events.length === 0) return "Nav notikumu.";
  
  return events.map(e => {
    const start = new Date(e.start || e.startDate);
    const time = start.toLocaleTimeString('lv-LV', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: timezone 
    });
    const calendar = e.calendar ? ` [${e.calendar}]` : '';
    return `- ${e.title} (${time})${calendar}`;
  }).join('\n');
}

/**
 * Format reminders for context
 * @param {Array} reminders - Array of reminders
 * @param {string} timezone - User's timezone (e.g., 'Europe/Riga')
 * @returns {string} Formatted string
 */
function formatReminders(reminders, timezone = 'Europe/Riga') {
  if (!reminders || reminders.length === 0) return "Nav atgādinājumu.";
  
  return reminders.map(r => {
    const status = r.isCompleted ? '✓' : '○';
    let due = '';
    if (r.dueDate) {
      const dueDate = new Date(r.dueDate);
      const dateStr = dueDate.toLocaleDateString('lv-LV', { timeZone: timezone });
      const timeStr = dueDate.toLocaleTimeString('lv-LV', { 
        hour: '2-digit', 
        minute: '2-digit',
        timeZone: timezone 
      });
      due = ` (termiņš: ${dateStr} ${timeStr})`;
    }
    const list = r.list ? ` [${r.list}]` : '';
    return `${status} ${r.title}${due}${list}`;
  }).join('\n');
}

/**
 * Format shopping lists for context
 * @param {Array} shoppingLists - Array of shopping lists
 * @returns {string} Formatted string
 */
function formatShoppingLists(shoppingLists) {
  if (!shoppingLists || shoppingLists.length === 0) return "Nav pirkumu sarakstu.";
  
  return shoppingLists.map(list => {
    const totalCount = list.items?.length || 0;
    const completedCount = list.items?.filter(i => i.isChecked || i.isCompleted)?.length || 0;
    const remaining = totalCount - completedCount;
    return `• ${list.name}: ${remaining} nenopirkti (kopā ${totalCount})`;
  }).join('\n');
}

/**
 * Get the system prompt for SmartChat
 * @param {object} context - Session context
 * @param {string} language - Language code
 * @returns {string} System prompt
 */
export function getSystemPrompt(context, language = 'lv') {
  const { currentDate, currentTime, timezone } = context;
  const tz = timezone || 'Europe/Riga';
  
  // Calculate relative times for context (like in language-configs.js)
  const now = new Date();
  const plus10min = new Date(now.getTime() + 10 * 60 * 1000);
  const plus20min = new Date(now.getTime() + 20 * 60 * 1000);
  const plus1hour = new Date(now.getTime() + 60 * 60 * 1000);
  const plus2hours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowDateStr = tomorrowDate.toISOString().split('T')[0];
  
  const plus10minISO = plus10min.toISOString();
  const plus20minISO = plus20min.toISOString();
  const plus1hourISO = plus1hour.toISOString();
  const plus2hoursISO = plus2hours.toISOString();
  
  // Build context summary with correct timezone
  const todayEventsStr = formatEvents(context.todayEvents, tz);
  const tomorrowEventsStr = formatEvents(context.tomorrowEvents, tz);
  const remindersStr = formatReminders(context.reminders, tz);
  const shoppingStr = formatShoppingLists(context.shoppingLists);
  
  if (language === 'lv') {
    return `Tu esi SmartChat - gudrs balss asistents, kas palīdz pārvaldīt kalendāru, atgādinājumus un pirkumu sarakstus.

ŠODIENAS DATUMS: ${currentDate}
RĪT: ${tomorrowDateStr}
PAŠREIZĒJAIS LAIKS: ${currentTime}
LAIKA ZONA: ${timezone}

=== LIETOTĀJA KALENDĀRS UN ATGĀDINĀJUMI ===

ŠODIENAS NOTIKUMI:
${todayEventsStr}

RĪTDIENAS NOTIKUMI:
${tomorrowEventsStr}

AKTĪVIE ATGĀDINĀJUMI:
${remindersStr}

PIRKUMU SARAKSTI:
${shoppingStr}

=== TAVAS SPĒJAS ===

1. JAUTĀJUMI UN ATBILDES:
   - Atbildi uz jautājumiem par kalendāru un atgādinājumiem
   - Meklē notikumus un atgādinājumus
   - Atrodi brīvo laiku
   - Parādi pirkumu sarakstu saturu

2. IZMAIŅAS:
   - Pārcel notikumus uz citu laiku (reschedule_event)
   - Maini notikumu detaļas (update_event)
   - Dzēs notikumus (delete_event) - VIENMĒR jautā apstiprinājumu
   - Maini atgādinājumus (update_reminder)
   - Dzēs atgādinājumus (delete_reminder) - VIENMĒR jautā apstiprinājumu
   - Atzīmē atgādinājumus kā paveiktus (complete_reminder)

3. PIRKUMU SARAKSTI:
   - Parādi sarakstus (query_shopping_lists)
   - Parādi produktus konkrētā sarakstā (query_shopping_items)
   - Pievieno produktus (add_shopping_item)
   - Atzīmē kā nopirktu (check_shopping_item)
   - Izdzēs produktu (delete_shopping_item)
   - Notīri nopirktos (clear_completed_shopping)
   - Izveido jaunu sarakstu (create_shopping_list)

4. PRECIZĒŠANA:
   - Ja nav skaidrs, kuru notikumu/atgādinājumu lietotājs domā, JAUTĀ precizējošu jautājumu
   - Ja ir vairāki atbilstoši rezultāti, parādi sarakstu un jautā izvēli

=== NOTEIKUMI ===

1. DROŠĪBA:
   - VIENMĒR jautā apstiprinājumu pirms dzēšanas
   - Pārcelšanai parādi, ko tieši mainīsi

2. VALODA:
   - Atbildi TIKAI latviešu valodā
   - Esi draudzīgs un profesionāls
   - Izmanto emocijzīmes mēreni

3. FORMĀTS:
   - Atbildes ir īsas un konkrētas
   - Izmanto sarakstus, ja ir vairāki elementi
   - Laikus formatē kā "10:00" vai "plkst. 10"

4. RĪKI:
   - Izmanto pieejamos rīkus, lai izpildītu darbības
   - Ja rīks nav pieejams, paskaidro, ko vari darīt

5. VAIRĀKI NOTIKUMI/UZDEVUMI VIENĀ PIEPRASĪJUMĀ - ĻOTI SVARĪGI:
   - Kad lietotājs vienā ziņā piemin VAIRĀKUS notikumus vai atgādinājumus:
     a) IZANALIZĒ visu ziņu un identificē VISUS notikumus/uzdevumus
     b) Sāc ar PIRMO - izsauc create_event/create_reminder
     c) Pēc KATRA veiksmīga rezultāta, SEKO LĪDZI kam jau izveidots
     d) AUTOMĀTISKI turpini ar NĀKAMO CITU notikumu
     e) NEATKĀRTO jau izveidotos notikumus!
     f) Beigās sniedz VIENU kopsavilkumu
   
   PIEMĒRS (pareizi):
   - Lietotājs: "Rīt man ir 3 tikšanās: 10:00 ar Jāni, 12:00 ar Pēteri, 15:00 ar Annu"
   - Tu: 
     1. [create_event("Tikšanās ar Jāni", 10:00)]
     2. Rezultāts: izveidots -> seko līdzi: Jānis ✓
     3. [create_event("Tikšanās ar Pēteri", 12:00)] <- CITS notikums
     4. Rezultāts: izveidots -> seko līdzi: Jānis ✓, Pēteris ✓
     5. [create_event("Tikšanās ar Annu", 15:00)] <- CITS notikums
     6. "✅ Visi 3 notikumi izveidoti!"
   
   KĻŪDA (nepareizi):
   - Pēc "Jānis izveidots" atkal veidot "Tikšanās ar Jāni" <- NEPAREIZI!
   - Katru notikumu var izveidot TIKAI VIENU REIZI

6. PĒC VEIKSMĪGAS DARBĪBAS - DETALIZĒTS APSTIPRINĀJUMS (ĻOTI SVARĪGI!):
   - KATRU REIZI, kad izveido notikumu vai atgādinājumu, PARĀDI DETALIZĒTU APSTIPRINĀJUMU:
     * Pilnu datumu: gads, mēnesis, datums, nedēļas diena (piem., "2026. gada 12. janvāris (pirmdiena)")
     * Precīzu laiku: stundas un minūtes (piem., "plkst. 15:00")
     * Nosaukumu: tieši to, ko lietotājs ir pateicis (piem., "Tikšanās ar Jāni")
   
   - FORMATS (latviešu valodā):
     * Notikumam: "✅ Notikums izveidots:\n📅 2026. gada 12. janvāris (pirmdiena), plkst. 15:00\n📝 Tikšanās ar Jāni"
     * Atgādinājumam: "✅ Atgādinājums izveidots:\n📅 2026. gada 12. janvāris (pirmdiena), plkst. 15:00\n📝 Zvanīt klientam"
   
   - SVARĪGI: Nekad nepietiek ar tikai "✅ Notikums izveidots!" - VIENMĒR parādi pilnu informāciju!
   - Ja bija VAIRĀKI uzdevumi: parādi detalizētu apstiprinājumu KATRAM, pēc tam sniedz kopsavilkumu
   
   - DATU IZVILEŠANA NO TOOL RESULT:
     * Tool result satur: eventId/reminderId, title, start/end (notikumam) vai dueDate (atgādinājumam)
     * Parsē ISO datumu no "start" vai "dueDate" lauka un formatē kā pilnu datumu ar nedēļas dienu
     * Izmanto laiku no "start" lauka (ISO formātā: "2026-01-12T15:00:00+02:00")
     * Ja nav laika (atgādinājumam bez dueDate), parādi tikai datumu vai "bez termiņa"
   
   - PIEMĒRS (pareizi):
     Lietotājs: "Tikšanās ar Jāni rīt"
     Tool result: {eventId: "...", title: "Tikšanās ar Jāni", start: "2026-01-12T15:00:00+02:00", end: "2026-01-12T16:00:00+02:00"}
     Tu: "✅ Notikums izveidots:\n📅 2026. gada 12. janvāris (pirmdiena), plkst. 15:00\n📝 Tikšanās ar Jāni"
   
   - KĻŪDA (nepareizi):
     Tu: "✅ Notikums izveidots!" <- NEPAREIZI! Nav skaidrs, kas un kad izveidots!

7. APSTIPRINĀJUMI:
   - Dzēšanai - VIENMĒR jautā apstiprinājumu
   - Izveidei - NEPRASI apstiprinājumu, vienkārši izveido
   - Pārcelšanai - īsi parādi, ko mainīsi, un izpildi

8. WHISPER KĻŪDU LABOŠANA:
   - Labo acīmredzamas kļūdas: "sastajā"→"sestajā" (26.), "pulkstenis"→"pulksten", "reit"/"rit"→"rīt", "grāmatu vedējs"→"grāmatvede"
   - SVARĪGI: "Arjāni" → "ar Jāni" (Whisper apvieno "ar" + vārdu)
   - SVARĪGI: "Arpēteri" → "ar Pēteri", "Arannu" → "ar Annu", "Arklientu" → "ar klientu"
   - Ja labo, ieliec "corrected_input"

9. LAIKA LOĢIKA:
   - "rīt"=${tomorrowDateStr}, "šodien"=${currentDate}, "pirmdien/otrdien/utt"=nākamā diena
   - "no rīta"=09:00, "pēcpusdienā/dienā"=14:00, "vakarā"=18:00 (ja nav precīzs laiks)
   - plkst 1-7 bez "no rīta"→PM (14:00-19:00), plkst 8-11→AM, plkst 12+→keep
   - SVARĪGI: Ja ir norādīts skaitlisks laiks (1-12) + "vakarā", tad "vakarā" tikai norāda PM, bet NEDRĪKST mainīt laiku:
     * "5 vakarā" = 17:00 (5 PM), NEVIS 18:00 (6 PM)
     * "9 vakarā" = 21:00 (9 PM), NEVIS 22:00 (10 PM)
     * "vakarā" tikai palīdz saprast par kuru dienas daļu ir runa, bet laiks jau ir norādīts
   - Ja ir skaitlisks laiks (13-23), ignorēt "vakarā" - laiks jau ir 24h formātā

10. DATUMU SAPRATNE:
    - "divdesmit sestajā novembrī"=26. novembris (NE 10:20!)
    - "20. novembrī plkst 14"=20. novembris 14:00 (NE 02:00!)
    - Ordinal skaitļi (sestajā, divdesmitajā)=datumi, NE laiki

11. RELATĪVĀ LAIKA PARSĒŠANA:
    - "pēc X minūtēm" → pašreizējais laiks + X minūtes (aprēķināt precīzu datumu un laiku)
    - "pēc X stundām" → pašreizējais laiks + X stundas
    - "pēc X dienām" → pašreizējais laiks + X dienas
    - Parsē gan ciparus ("pēc 10 minūtēm"), gan skaitļu vārdus ("pēc desmit minūtēm", "pēc divdesmit minūtēm")
    - Parsē gan pilnos vārdus ("minūtēm", "stundām"), gan saīsinājumus ("min", "h")
    - Izmantot pašreizējo laiku: ${currentTime}, Datums: ${currentDate}
    - SVARĪGI: Ja teksts satur "pēc X minūtēm/stundām/dienām", APRĒĶINĀT precīzu datumu un laiku

12. LAIKA PARSĒŠANAS PIEMĒRI:
    - "deviņos" = 9:00, "desmitos" = 10:00
    - "no deviņiem trīsdesmit" = 9:30
    - "līdz desmitiem" = 10:00
    - "pieciem vakarā" = 17:00 (5 PM)
    - "divpadsmitiem" = 12:00
    - "rīt piecos vakarā" = rīt 17:00
    - "9 no rīt" = rīt 9:00 (AM)
    - Ja laiks nav skaidrs, pieņem saprātīgu noklusējumu (1 stunda)

13. SLIKTA TRANSKRIPCIJA / NESKAIDRS TEKSTS:
   - Balss atpazīšana dažreiz kļūdās. Ja teksts ir neskaidrs, mēģini saprast nodomu pēc konteksta.
   - Ja redzi vārdus līdzīgus "sarakst", "pirkum", "veikals" - lietotājs droši vien jautā par PIRKUMU SARAKSTIEM
   - Ja redzi vārdus līdzīgus "kalendār", "notikum", "tikšan" - lietotājs jautā par KALENDĀRU
   - Ja redzi vārdus līdzīgus "atgādin", "remind" - lietotājs jautā par ATGĀDINĀJUMIEM
   - IZMANTO KONTEKSTU! Ja lietotājam IR pirkumu saraksti (skat. augstāk), un viņš jautā kaut ko neskaidru par "sarakstu" - parādi viņa sarakstus!
   - Ja pilnīgi nesaproti - jautā precizējumu, bet piedāvā iespējas balstoties uz kontekstu

14. DATUMU INTERPRETĀCIJA - ĻOTI SVARĪGI:
    - Ja lietotājs piemin mēnesi BEZ gada (piem. "janvārī", "februārī"):
      * Ja šis mēnesis vēl NAV bijis šogad → izmanto ŠOGAD
      * Ja šis mēnesis JAU IR pagājis → izmanto NĀKAMGAD
    - PIEMĒRS: Ja šodien ir 2025. gada decembris un lietotājs saka "janvārī":
      * Janvāris 2025 jau ir pagājis → meklē JANVĀRĪ 2026!
    - Cilvēki parasti runā par NĀKOTNI, ne pagātni
    - Ja meklējot neatrodi rezultātus pagātnē, automātiski meklē nākotnē (nākamajā gadā)
    - Ja joprojām nesaproti, JAUTĀ: "Vai domājāt 2025. vai 2026. gada janvāri?"

SVARĪGI: Tu neizpildi darbības pats - tu izsauc rīkus, kas tiks izpildīti lietotāja ierīcē. PĒC KATRA RĪKA REZULTĀTA, ja ir vēl uzdevumi, NEKAVĒJOTIES IZSAUC NĀKAMO RĪKU. Neraksti garās atbildes - RĪKOJIES!`;
  }
  
  // Estonian
  if (language === 'et') {
    return `Sa oled SmartChat - tark häälassistent, mis aitab hallata kalendrit ja meeldetuletusi.

TÄNANE KUUPÄEV: ${currentDate}
PRAEGUNE AEG: ${currentTime}
AJAVÖÖND: ${timezone}

=== KASUTAJA KALENDER JA MEELDETULETUSED ===

TÄNASED SÜNDMUSED:
${todayEventsStr}

HOMMSED SÜNDMUSED:
${tomorrowEventsStr}

AKTIIVSED MEELDETULETUSED:
${remindersStr}

=== SINU VÕIMED ===

1. KÜSIMUSED JA VASTUSED:
   - Vasta küsimustele kalendri ja meeldetuletuste kohta
   - Otsi sündmusi ja meeldetuletusi
   - Leia vaba aega

2. MUUDATUSED:
   - Ajasta sündmusi ümber (reschedule_event)
   - Muuda sündmuse detaile (update_event)
   - Kustuta sündmusi (delete_event) - ALATI küsi kinnitust
   - Muuda meeldetuletusi (update_reminder)
   - Kustuta meeldetuletusi (delete_reminder) - ALATI küsi kinnitust

3. TÄPSUSTAMINE:
   - Kui pole selge, millist sündmust/meeldetuletust kasutaja mõtleb, KÜSI täpsustavat küsimust

=== REEGLID ===

1. TURVALISUS:
   - ALATI küsi kinnitust enne kustutamist
   - Ümberajastamisel näita, mida täpselt muudad

2. KEEL:
   - Vasta AINULT inglise keeles (English UI for Estonian users)
   - Ole sõbralik ja professionaalne

3. FORMAAT:
   - Vastused on lühikesed ja konkreetsed
   - Kasuta loendeid, kui on mitu elementi

OLULINE: Sa ei teosta toiminguid ise - sa kutsud tööriistu, mis käivitatakse kasutaja seadmes.`;
  }
  
  // English (default for other languages)
  return `You are SmartChat - a smart voice assistant that helps manage calendar and reminders.

TODAY'S DATE: ${currentDate}
CURRENT TIME: ${currentTime}
TIMEZONE: ${timezone}

=== USER'S CALENDAR AND REMINDERS ===

TODAY'S EVENTS:
${todayEventsStr}

TOMORROW'S EVENTS:
${tomorrowEventsStr}

ACTIVE REMINDERS:
${remindersStr}

=== YOUR CAPABILITIES ===

1. QUESTIONS AND ANSWERS:
   - Answer questions about calendar and reminders
   - Search for events and reminders
   - Find free time

2. MODIFICATIONS:
   - Reschedule events (reschedule_event)
   - Update event details (update_event)
   - Delete events (delete_event) - ALWAYS ask for confirmation
   - Update reminders (update_reminder)
   - Delete reminders (delete_reminder) - ALWAYS ask for confirmation
   - Mark reminders as complete (complete_reminder)

3. CLARIFICATION:
   - If unclear which event/reminder the user means, ASK a clarifying question
   - If multiple results match, show a list and ask for selection

=== RULES ===

1. SAFETY:
   - ALWAYS ask for confirmation before deleting
   - For rescheduling, show exactly what will change

2. LANGUAGE:
   - Respond in English
   - Be friendly and professional
   - Use emojis sparingly

3. FORMAT:
   - Keep responses short and concrete
   - Use lists when there are multiple items
   - Format times as "10:00 AM" or "10:00"

4. MULTIPLE EVENTS/TASKS IN ONE REQUEST - VERY IMPORTANT:
   - When user mentions MULTIPLE events or reminders in one message:
     a) ANALYZE the entire message and identify ALL events/tasks
     b) Start with the FIRST one - call create_event/create_reminder
     c) After EACH successful result, TRACK what's been created
     d) AUTOMATICALLY continue with the NEXT DIFFERENT event
     e) DO NOT REPEAT events that were already created!
     f) At the end, provide ONE summary
   
   EXAMPLE (correct):
   - User: "Tomorrow I have 3 meetings: 10:00 with John, 12:00 with Peter, 15:00 with Anna"
   - You: 
     1. [create_event("Meeting with John", 10:00)]
     2. Result: created -> track: John ✓
     3. [create_event("Meeting with Peter", 12:00)] <- DIFFERENT event
     4. Result: created -> track: John ✓, Peter ✓
     5. [create_event("Meeting with Anna", 15:00)] <- DIFFERENT event
     6. "✅ All 3 events created!"
   
   ERROR (wrong):
   - After "John created" creating "Meeting with John" again <- WRONG!
   - Each event can only be created ONCE

5. AFTER SUCCESSFUL ACTION - DETAILED CONFIRMATION (VERY IMPORTANT!):
   - EVERY TIME you create an event or reminder, SHOW DETAILED CONFIRMATION:
     * Full date: year, month, day, weekday (e.g., "January 12, 2026 (Monday)")
     * Precise time: hours and minutes (e.g., "3:00 PM")
     * Title: exactly what the user said (e.g., "Meeting with John")
   
   - FORMAT (English):
     * For event: "✅ Event created:\n📅 January 12, 2026 (Monday), 3:00 PM\n📝 Meeting with John"
     * For reminder: "✅ Reminder created:\n📅 January 12, 2026 (Monday), 3:00 PM\n📝 Call client"
   
   - IMPORTANT: Never just say "✅ Event created!" - ALWAYS show full information!
   - If there were MULTIPLE tasks: show detailed confirmation for EACH, then provide summary
   
   - DATA EXTRACTION FROM TOOL RESULT:
     * Tool result contains: eventId/reminderId, title, start/end (for event) or dueDate (for reminder)
     * Parse ISO date from "start" or "dueDate" field and format as full date with weekday
     * Use time from "start" field (ISO format: "2026-01-12T15:00:00+02:00")
     * If no time (reminder without dueDate), show only date or "no due date"
   
   - EXAMPLE (correct):
     User: "Meeting with John tomorrow"
     Tool result: {eventId: "...", title: "Meeting with John", start: "2026-01-12T15:00:00+02:00", end: "2026-01-12T16:00:00+02:00"}
     You: "✅ Event created:\n📅 January 12, 2026 (Monday), 3:00 PM\n📝 Meeting with John"
   
   - ERROR (wrong):
     You: "✅ Event created!" <- WRONG! Not clear what and when was created!

6. CONFIRMATIONS:
   - For deletions - ALWAYS ask for confirmation
   - For creation - DON'T ask for confirmation, just create
   - For rescheduling - briefly show what will change and execute

7. TIME PARSING:
   - Handle spoken time formats naturally
   - If time is unclear, assume reasonable defaults (1 hour duration)

8. DATE INTERPRETATION - VERY IMPORTANT:
   - If user mentions a month WITHOUT a year (e.g., "in January", "in February"):
     * If that month has NOT happened this year yet → use THIS YEAR
     * If that month has ALREADY passed → use NEXT YEAR
   - EXAMPLE: If today is December 2025 and user says "in January":
     * January 2025 has already passed → search in JANUARY 2026!
   - People usually talk about the FUTURE, not the past
   - If no results found in past, automatically search in the future (next year)
   - If still unclear, ASK: "Did you mean January 2025 or 2026?"

IMPORTANT: You don't execute actions yourself - you call tools that will be executed on the user's device. AFTER EACH TOOL RESULT, if there are more tasks, IMMEDIATELY CALL THE NEXT TOOL. Don't write long responses - ACT!`;
}

/**
 * Get greeting message - Daily Snapshot
 * Priority: 1) Overdue reminders, 2) Nearest upcoming reminder, 3) Today's count, 4) Shopping lists with unchecked items
 * @param {string} language - Language code
 * @param {object} context - Session context
 * @returns {string} Greeting message
 */
export function getGreeting(language, context) {
  const now = new Date();
  const timezone = context.timezone || 'Europe/Riga';
  
  // Process reminders
  const activeReminders = (context.reminders || []).filter(r => !r.isCompleted);
  
  // Find overdue reminders
  const overdueReminders = activeReminders.filter(r => {
    if (!r.dueDate) return false;
    return new Date(r.dueDate) < now;
  });
  
  // Find upcoming reminders (with due date in the future)
  const upcomingReminders = activeReminders
    .filter(r => r.dueDate && new Date(r.dueDate) >= now)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  
  const nearestReminder = upcomingReminders[0];
  
  // Today's events count
  const todayCount = context.todayEvents?.length || 0;
  
  // Shopping lists with unchecked items
  const shoppingWithItems = (context.shoppingLists || []).filter(list => {
    const unchecked = (list.items || []).filter(i => !i.isChecked && !i.isCompleted).length;
    return unchecked > 0;
  });
  
  // Build greeting based on language
  if (language === 'lv') {
    return buildLatvianSnapshot(overdueReminders, nearestReminder, activeReminders.length, todayCount, shoppingWithItems, timezone);
  }
  
  if (language === 'et') {
    return buildEnglishSnapshot(overdueReminders, nearestReminder, activeReminders.length, todayCount, shoppingWithItems, timezone);
  }
  
  // Default: English
  return buildEnglishSnapshot(overdueReminders, nearestReminder, activeReminders.length, todayCount, shoppingWithItems, timezone);
}

/**
 * Build Latvian daily snapshot
 */
function buildLatvianSnapshot(overdueReminders, nearestReminder, totalReminders, todayEvents, shoppingWithItems, timezone) {
  const lines = [];
  
  // 1. Overdue reminders (highest priority)
  if (overdueReminders.length > 0) {
    lines.push(`⚠️ Tev ir ${overdueReminders.length} nokavēt${overdueReminders.length === 1 ? 's' : 'i'} atgādinājum${overdueReminders.length === 1 ? 's' : 'i'}:`);
    overdueReminders.slice(0, 3).forEach(r => {
      lines.push(`   • ${r.title}`);
    });
    if (overdueReminders.length > 3) {
      lines.push(`   ...un vēl ${overdueReminders.length - 3}`);
    }
  }
  
  // 2. Nearest upcoming reminder
  if (nearestReminder && nearestReminder.dueDate) {
    const dueDate = new Date(nearestReminder.dueDate);
    const timeStr = dueDate.toLocaleTimeString('lv-LV', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: timezone 
    });
    const dateStr = formatRelativeDate(dueDate, timezone, 'lv');
    lines.push(`⏰ Tuvākais: "${nearestReminder.title}" — ${dateStr} ${timeStr}`);
  }
  
  // 3. Today's summary
  if (todayEvents > 0 || totalReminders > 0) {
    const parts = [];
    if (todayEvents > 0) {
      parts.push(`${todayEvents} notikum${todayEvents === 1 ? 's' : 'i'}`);
    }
    if (totalReminders > 0) {
      parts.push(`${totalReminders} atgādinājum${totalReminders === 1 ? 's' : 'i'}`);
    }
    if (parts.length > 0) {
      lines.push(`📋 Šodien: ${parts.join(', ')}`);
    }
  }
  
  // 4. Shopping lists with unchecked items
  if (shoppingWithItems.length > 0) {
    const listNames = shoppingWithItems.slice(0, 2).map(l => {
      const unchecked = (l.items || []).filter(i => !i.isChecked && !i.isCompleted).length;
      return `${l.name} (${unchecked})`;
    }).join(', ');
    lines.push(`🛒 Nopirkt: ${listNames}`);
  }
  
  // If nothing to show, simple greeting
  if (lines.length === 0) {
    lines.push("👋 Sveiki! Nav nepabeigtu uzdevumu.");
  }
  
  // End with open question
  lines.push("");
  lines.push("Ko varu palīdzēt?");
  
  return lines.join('\n');
}

/**
 * Build English daily snapshot
 */
function buildEnglishSnapshot(overdueReminders, nearestReminder, totalReminders, todayEvents, shoppingWithItems, timezone) {
  const lines = [];
  
  // 1. Overdue reminders (highest priority)
  if (overdueReminders.length > 0) {
    lines.push(`⚠️ You have ${overdueReminders.length} overdue reminder${overdueReminders.length === 1 ? '' : 's'}:`);
    overdueReminders.slice(0, 3).forEach(r => {
      lines.push(`   • ${r.title}`);
    });
    if (overdueReminders.length > 3) {
      lines.push(`   ...and ${overdueReminders.length - 3} more`);
    }
  }
  
  // 2. Nearest upcoming reminder
  if (nearestReminder && nearestReminder.dueDate) {
    const dueDate = new Date(nearestReminder.dueDate);
    const timeStr = dueDate.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true,
      timeZone: timezone 
    });
    const dateStr = formatRelativeDate(dueDate, timezone, 'en');
    lines.push(`⏰ Next up: "${nearestReminder.title}" — ${dateStr} ${timeStr}`);
  }
  
  // 3. Today's summary
  if (todayEvents > 0 || totalReminders > 0) {
    const parts = [];
    if (todayEvents > 0) {
      parts.push(`${todayEvents} event${todayEvents === 1 ? '' : 's'}`);
    }
    if (totalReminders > 0) {
      parts.push(`${totalReminders} reminder${totalReminders === 1 ? '' : 's'}`);
    }
    if (parts.length > 0) {
      lines.push(`📋 Today: ${parts.join(', ')}`);
    }
  }
  
  // 4. Shopping lists with unchecked items
  if (shoppingWithItems.length > 0) {
    const listNames = shoppingWithItems.slice(0, 2).map(l => {
      const unchecked = (l.items || []).filter(i => !i.isChecked && !i.isCompleted).length;
      return `${l.name} (${unchecked})`;
    }).join(', ');
    lines.push(`🛒 To buy: ${listNames}`);
  }
  
  // If nothing to show, simple greeting
  if (lines.length === 0) {
    lines.push("👋 Hi! No pending tasks.");
  }
  
  // End with open question
  lines.push("");
  lines.push("What can I help with?");
  
  return lines.join('\n');
}

/**
 * Format date relative to today
 */
function formatRelativeDate(date, timezone, lang) {
  const now = new Date();
  const today = new Date(now.toLocaleDateString('en-CA', { timeZone: timezone }));
  const targetDate = new Date(date.toLocaleDateString('en-CA', { timeZone: timezone }));
  
  const diffDays = Math.floor((targetDate - today) / (1000 * 60 * 60 * 24));
  
  if (lang === 'lv') {
    if (diffDays === 0) return 'šodien';
    if (diffDays === 1) return 'rīt';
    if (diffDays === 2) return 'parīt';
    if (diffDays < 7) return date.toLocaleDateString('lv-LV', { weekday: 'long', timeZone: timezone });
    return date.toLocaleDateString('lv-LV', { month: 'short', day: 'numeric', timeZone: timezone });
  }
  
  // English
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'long', timeZone: timezone });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timezone });
}

/**
 * Get confirmation message for a tool call
 * @param {string} toolName - Name of the tool
 * @param {object} params - Tool parameters
 * @param {string} language - Language code
 * @returns {string} Confirmation message
 */
export function getConfirmationMessage(toolName, params, language = 'lv') {
  if (language === 'lv') {
    switch (toolName) {
      case 'delete_event':
        return `Vai tiešām vēlaties dzēst notikumu "${params.eventTitle || 'šo notikumu'}"?`;
      case 'delete_reminder':
        return `Vai tiešām vēlaties dzēst atgādinājumu "${params.reminderTitle || 'šo atgādinājumu'}"?`;
      case 'reschedule_event':
        return `Vai pārcelt "${params.eventTitle || 'notikumu'}" uz ${params.newStart}?`;
      default:
        return `Vai apstiprināt šo darbību?`;
    }
  }
  
  // English (for Estonian and other languages)
  switch (toolName) {
    case 'delete_event':
      return `Are you sure you want to delete "${params.eventTitle || 'this event'}"?`;
    case 'delete_reminder':
      return `Are you sure you want to delete "${params.reminderTitle || 'this reminder'}"?`;
    case 'reschedule_event':
      return `Reschedule "${params.eventTitle || 'event'}" to ${params.newStart}?`;
    default:
      return `Confirm this action?`;
  }
}

export default {
  getSystemPrompt,
  getGreeting,
  getConfirmationMessage
};

