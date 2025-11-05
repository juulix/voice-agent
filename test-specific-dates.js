// Test specific date parsing (numeric and ordinal dates)
// Testing Parser v3's new extractDate() specific date functionality

class LatvianCalendarParserV3 {
  constructor() {
    this.weekdays = new Map([
      ['pirmdien', 1], ['pirmdiena', 1], ['pirmdienu', 1], ['pirmdienā', 1],
      ['otrdien', 2], ['otrdiena', 2], ['otrdienu', 2], ['otrdienā', 2],
      ['trešdien', 3], ['trešdiena', 3], ['trešdienu', 3], ['trešdienā', 3],
      ['ceturtdien', 4], ['ceturtdiena', 4], ['ceturtdienu', 4], ['ceturtdienā', 4],
      ['piektdien', 5], ['piektdiena', 5], ['piektdienu', 5], ['piektdienā', 5],
      ['sestdien', 6], ['sestdiena', 6], ['sestdienu', 6], ['sestdienā', 6],
      ['svētdien', 7], ['svētdiena', 7], ['svētdienu', 7], ['svētdienā', 7],
    ]);

    this.relativeDays = new Map([
      ['šodien', 0],
      ['tagad', 0],
      ['rīt', 1],
      ['rītdien', 1],
      ['parīt', 2]
    ]);

    this.relativeTime = new Map([
      ['pēc stundas', { value: 1, unit: 'hours' }],
      ['pēc 2 stundām', { value: 2, unit: 'hours' }],
      ['pēc 2 dienām', { value: 2, unit: 'days' }]
    ]);
  }

  extractDate(lower, now) {
    // 1. Check relative days (šodien, rīt, parīt)
    for (const [word, offset] of this.relativeDays) {
      if (lower.includes(word)) {
        const date = new Date(now);
        date.setDate(date.getDate() + offset);
        date.setHours(0, 0, 0, 0);
        return {
          baseDate: date,
          type: 'relative',
          offset,
          isToday: offset === 0
        };
      }
    }

    // 2. Check weekdays (pirmdien, otrdien, etc.)
    for (const [word, targetIsoDay] of this.weekdays) {
      if (lower.includes(word)) {
        const date = this.getNextWeekday(now, targetIsoDay);
        return {
          baseDate: date,
          type: 'weekday',
          targetIsoDay
        };
      }
    }

    // 3. Check "nākamnedēļ" / "nākamajā nedēļā"
    if (/nākam[nā]?\s*nedēļ/i.test(lower)) {
      for (const [word, targetIsoDay] of this.weekdays) {
        if (lower.includes(word)) {
          const date = this.getNextWeekday(now, targetIsoDay);
          date.setDate(date.getDate() + 7);
          return {
            baseDate: date,
            type: 'next_week',
            targetIsoDay
          };
        }
      }
      const date = this.getNextWeekday(now, 1);
      date.setDate(date.getDate() + 7);
      return { baseDate: date, type: 'next_week' };
    }

    // 4. Check relative time (pēc stundas, pēc 2 dienām)
    for (const [phrase, offset] of this.relativeTime) {
      if (lower.includes(phrase)) {
        const date = new Date(now);
        if (offset.unit === 'minutes') {
          date.setMinutes(date.getMinutes() + offset.value);
        } else if (offset.unit === 'hours') {
          date.setHours(date.getHours() + offset.value);
        } else if (offset.unit === 'days') {
          date.setDate(date.getDate() + offset.value);
        }
        return {
          baseDate: date,
          type: 'relative_time',
          hasExactTime: true
        };
      }
    }

    // 5. Check specific dates (7., 10. novembrī, septītajā novembrī, etc.)
    const monthNames = {
      'janvār': 0, 'janvārī': 0,
      'februār': 1, 'februārī': 1,
      'mart': 2, 'martā': 2,
      'aprīl': 3, 'aprīlī': 3,
      'maij': 4, 'maijā': 4,
      'jūnij': 5, 'jūnijā': 5,
      'jūlij': 6, 'jūlijā': 6,
      'august': 7, 'augustā': 7,
      'septembr': 8, 'septembrī': 8,
      'oktobr': 9, 'oktobrī': 9,
      'novembr': 10, 'novembrī': 10,
      'decembr': 11, 'decembrī': 11
    };

    const ordinalDates = {
      'pirmajā': 1, 'otrajā': 2, 'trešajā': 3, 'ceturtajā': 4, 'piektajā': 5,
      'sestajā': 6, 'septītajā': 7, 'astotajā': 8, 'devītajā': 9, 'desmitajā': 10,
      'vienpadsmitajā': 11, 'divpadsmitajā': 12, 'trīspadsmitajā': 13,
      'četrpadsmitajā': 14, 'piecpadsmitajā': 15, 'sešpadsmitajā': 16,
      'septiņpadsmitajā': 17, 'astoņpadsmitajā': 18, 'deviņpadsmitajā': 19,
      'divdesmitajā': 20, 'divdesmit pirmajā': 21, 'divdesmit otrajā': 22,
      'divdesmit trešajā': 23, 'divdesmit ceturtajā': 24, 'divdesmit piektajā': 25,
      'divdesmit sestajā': 26, 'divdesmit septītajā': 27, 'divdesmit astotajā': 28,
      'divdesmit devītajā': 29, 'trīsdesmitajā': 30, 'trīsdesmit pirmajā': 31
    };

    // Try numeric date pattern: "7.", "10.", "16." + month name
    const numericDateMatch = lower.match(/(\d{1,2})\.\s*(janvār|februār|mart|aprīl|maij|jūnij|jūlij|august|septembr|oktobr|novembr|decembr)/i);
    if (numericDateMatch) {
      const day = parseInt(numericDateMatch[1], 10);
      const monthName = numericDateMatch[2].toLowerCase();
      const month = monthNames[monthName] ?? monthNames[Object.keys(monthNames).find(k => monthName.startsWith(k))];

      if (month !== undefined && day >= 1 && day <= 31) {
        const cur = new Date(now);
        const targetDate = new Date(cur.getFullYear(), month, day, 0, 0, 0, 0);

        // If target date is in the past, move to next year
        if (targetDate < cur) {
          targetDate.setFullYear(cur.getFullYear() + 1);
        }

        console.log(`📆 extractDate: found numeric date "${numericDateMatch[0]}" → ${targetDate.toISOString()}`);
        return {
          baseDate: targetDate,
          type: 'specific_date',
          day,
          month
        };
      }
    }

    // Try ordinal date pattern: "septītajā", "trīspadsmitajā" + month name
    for (const [ordinal, day] of Object.entries(ordinalDates)) {
      if (lower.includes(ordinal)) {
        // Find month name after ordinal
        for (const [monthKey, month] of Object.entries(monthNames)) {
          if (lower.includes(monthKey)) {
            const cur = new Date(now);
            const targetDate = new Date(cur.getFullYear(), month, day, 0, 0, 0, 0);

            // If target date is in the past, move to next year
            if (targetDate < cur) {
              targetDate.setFullYear(cur.getFullYear() + 1);
            }

            console.log(`📆 extractDate: found ordinal date "${ordinal} ${monthKey}" → ${targetDate.toISOString()}`);
            return {
              baseDate: targetDate,
              type: 'specific_date',
              day,
              month
            };
          }
        }
      }
    }

    // 6. Default to today
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return {
      baseDate: today,
      type: 'default',
      isToday: true
    };
  }

  getNextWeekday(current, targetIsoDay) {
    const cur = new Date(current);
    const curIsoDay = ((cur.getDay() + 6) % 7) + 1;
    let offset = targetIsoDay - curIsoDay;
    if (offset === 0) {
      offset = 0;
    } else if (offset < 0) {
      offset += 7;
    }
    const result = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + offset, 0, 0, 0);
    return result;
  }
}

// Test cases
const parser = new LatvianCalendarParserV3();
const now = new Date('2025-11-05T16:37:00+02:00'); // Wednesday, Nov 5, 2025

const testCases = [
  { text: "10. novembrī sapulce", expected: "2025-11-10" },
  { text: "13. novembrī sapulce no desmitiem", expected: "2025-11-13" },
  { text: "trīspadsmitajā novembrī desmitos", expected: "2025-11-13" },
  { text: "16. novembrī tikšanās", expected: "2025-11-16" },
  { text: "11. decembrī frizieris", expected: "2025-12-11" },
  { text: "septītajā novembrī tikšanās", expected: "2025-11-07" },
  { text: "astotajā novembrī sapulce", expected: "2025-11-08" },
  { text: "7. novembrī piecos vakarā", expected: "2025-11-07" },
  { text: "piektdien piecos vakarā", expected: "2025-11-07" }, // Should be next Friday
  { text: "sestdien desmitos", expected: "2025-11-08" }, // Should be next Saturday
];

console.log('\n🧪 Testing specific date parsing:\n');
console.log(`Current time: ${now.toISOString()} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()]})\n`);

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  const result = parser.extractDate(test.text.toLowerCase(), now);
  const actualDate = result.baseDate.toISOString().split('T')[0];
  const match = actualDate === test.expected;

  if (match) {
    console.log(`✅ Test ${index + 1}: "${test.text}" → ${actualDate}`);
    passed++;
  } else {
    console.log(`❌ Test ${index + 1}: "${test.text}"`);
    console.log(`   Expected: ${test.expected}`);
    console.log(`   Got: ${actualDate}`);
    console.log(`   Result:`, result);
    failed++;
  }
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed (${testCases.length} total)\n`);

process.exit(failed > 0 ? 1 : 0);
