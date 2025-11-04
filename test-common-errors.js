#!/usr/bin/env node

/**
 * Testa scenāriji ar biežākajām kļūdām
 * Lietojums: node test-common-errors.js [server-url]
 */

const SERVER_URL = process.argv[2] || process.env.SERVER_URL || 'https://voice-agent-production-670b.up.railway.app';

// Biežākās kļūdas - Whisper transkripcijas kļūdas
const COMMON_ERRORS = [
  {
    category: 'Transkripcijas kļūdas',
    tests: [
      {
        name: 'reit → rīt',
        text: 'reit pulksten divos tikšanās ar Jāni.',
        expected: { type: 'reminder', hasTime: true }
      },
      {
        name: 'rit → rīt',
        text: 'rit pulksten vienos tikšanās ar Montu.',
        expected: { type: 'reminder', hasTime: true }
      },
      {
        name: 'pulkstenis → pulksten',
        text: 'rīt pulkstenis divos tikšanās ar Jāni.',
        expected: { type: 'reminder', hasTime: true }
      },
      {
        name: 'tikšanas → tikšanās',
        text: 'rīt pulksten divos tikšanas ar Jāni.',
        expected: { type: 'reminder', hasTime: true }
      }
    ]
  },
  {
    category: 'Laika parsēšanas kļūdas',
    tests: [
      {
        name: 'Divos (vārds)',
        text: 'rīt pulksten divos tikšanās ar Jāni.',
        expected: { type: 'reminder', start: '2025-11-05T14:00' }
      },
      {
        name: 'Vienos (vārds)',
        text: 'rīt pulksten vienos tikšanās ar Montu.',
        expected: { type: 'reminder', start: '2025-11-05T13:00' }
      },
      {
        name: 'Desmitos (vārds)',
        text: 'rīt desmitos tikšanās ar Jāni.',
        expected: { type: 'reminder', start: '2025-11-05T10:00' }
      },
      {
        name: 'No rīta + laiks (10:00 no rīta)',
        text: 'rīt 10:00 no rīta tikšanās ar Jāni.',
        expected: { type: 'reminder', start: '2025-11-05T10:00' }
      },
      {
        name: 'Parīt (parītdien)',
        text: 'parīt pulksten divos tikšanās ar Jāni.',
        expected: { type: 'reminder', start: '2025-11-06T14:00' }
      }
    ]
  },
  {
    category: 'Shopping kļūdas',
    tests: [
      {
        name: 'Bez "nopirkt" trigger',
        text: 'pienu, desu, olas.',
        expected: { type: 'shopping' }
      },
      {
        name: 'Ar gramatikas kļūdām',
        text: 'nopirkt maizīte, pienītis, sierīņus.',
        expected: { type: 'shopping', items: 'maize, piens, sierīņi' }
      },
      {
        name: 'Ar vairākiem komatiem',
        text: 'nopirkt pienu, desu, olas, maize, sieru.',
        expected: { type: 'shopping' }
      }
    ]
  },
  {
    category: 'Multi-action kļūdas',
    tests: [
      {
        name: 'Reminder + Shopping',
        text: 'rīt pulksten divos tikšanās ar Jāni un nopirkt pienu, desu.',
        expected: { type: 'reminders', reminders: 2 }
      },
      {
        name: '2 Reminderi + Shopping',
        text: 'atgādini man rītnos desmitos iznest miskasti un vienpadsmitos pazvanīt Jānim, un arī nopirkt pienu, desu.',
        expected: { type: 'reminders', reminders: 3 }
      },
      {
        name: 'Shopping + Reminder',
        text: 'nopirkt pienu, desu un rīt pulksten divos tikšanās ar Jāni.',
        expected: { type: 'reminders', reminders: 2 }
      }
    ]
  },
  {
    category: 'Datu parsēšanas kļūdas',
    tests: [
      {
        name: 'Šodien (bez laika)',
        text: 'šodien tikšanās ar Jāni.',
        expected: { type: 'reminder' }
      },
      {
        name: 'Rīt (bez laika)',
        text: 'rīt tikšanās ar Jāni.',
        expected: { type: 'reminder' }
      },
      {
        name: 'Nedēļas diena (pirmdiena)',
        text: 'pirmdien pulksten divos tikšanās ar Jāni.',
        expected: { type: 'reminder' }
      },
      {
        name: 'Nedēļas diena + laiks (piektdiena 18:00)',
        text: 'piektdien pulksten astoņos tikšanās ar Jāni.',
        expected: { type: 'reminder' }
      }
    ]
  },
  {
    category: 'Personvārdu saglabāšana',
    tests: [
      {
        name: 'Personvārds ar lielo burtu',
        text: 'rīt pulksten divos tikšanās ar Silardu.',
        expected: { description: 'Silardu' }
      },
      {
        name: 'Personvārds "Rītu" (nevis "rīt")',
        text: 'tikšanās ar Jāni Rītu pulksten divos.',
        expected: { description: 'Rītu' }
      },
      {
        name: 'Ģimenes relācijas',
        text: 'rīt pie vectētiņu uzņemšanas dienu.',
        expected: { description: 'vectētiņu' }
      }
    ]
  },
  {
    category: 'Edge cases',
    tests: [
      {
        name: 'Ļoti īss teksts',
        text: 'rīt divos.',
        expected: { type: 'reminder' }
      },
      {
        name: 'Ļoti garš teksts',
        text: 'rīt pulksten divos tikšanās ar Jāni par projektu un apspriest visus detalizētos aspektus un izlemt par nākamajiem soļiem.',
        expected: { type: 'reminder' }
      },
      {
        name: 'Ar skaitļiem un laikiem',
        text: 'rīt 10:30 tikšanās ar Jāni.',
        expected: { type: 'reminder', start: '2025-11-05T10:30' }
      },
      {
        name: 'Intervāls (no 9 līdz 11)',
        text: 'rīt no 9 līdz 11 tikšanās ar Jāni.',
        expected: { type: 'calendar', start: '2025-11-05T09:00', end: '2025-11-05T11:00' }
      }
    ]
  }
];

async function testScenario(category, test) {
  try {
    const response = await fetch(`${SERVER_URL}/test-parse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': 'u-1761411475-8ae09a4e',
        'X-Device-Id': 'd-test-device',
        'X-Plan': 'dev',
      },
      body: JSON.stringify({ text: test.text })
    });

    if (!response.ok) {
      console.log(`  ❌ ${test.name}: ${response.status} ${response.statusText}`);
      return false;
    }

    const data = await response.json();
    
    // Validācija
    let passed = true;
    const errors = [];

    if (test.expected.type) {
      if (data.type !== test.expected.type && 
          !(test.expected.type === 'reminders' && data.type === 'reminders' && Array.isArray(data.reminders))) {
        passed = false;
        errors.push(`Type: expected ${test.expected.type}, got ${data.type}`);
      }
    }

    if (test.expected.hasTime !== undefined) {
      if (data.hasTime !== test.expected.hasTime) {
        passed = false;
        errors.push(`hasTime: expected ${test.expected.hasTime}, got ${data.hasTime}`);
      }
    }

    if (test.expected.start) {
      if (!data.start || !data.start.includes(test.expected.start)) {
        passed = false;
        errors.push(`Start: expected ${test.expected.start}, got ${data.start}`);
      }
    }

    if (test.expected.reminders !== undefined) {
      if (!Array.isArray(data.reminders) || data.reminders.length !== test.expected.reminders) {
        passed = false;
        errors.push(`Reminders: expected ${test.expected.reminders}, got ${data.reminders?.length || 0}`);
      }
    }

    if (test.expected.description) {
      if (!data.description || !data.description.includes(test.expected.description)) {
        passed = false;
        errors.push(`Description: should contain "${test.expected.description}", got "${data.description}"`);
      }
    }

    if (passed) {
      console.log(`  ✅ ${test.name}`);
      if (data.type === 'reminders' && Array.isArray(data.reminders)) {
        console.log(`     → ${data.reminders.length} items: ${data.reminders.map(r => r.type).join(', ')}`);
      } else {
        console.log(`     → ${data.type}${data.start ? ` at ${data.start.substring(11, 16)}` : ''}`);
      }
    } else {
      console.log(`  ❌ ${test.name}`);
      errors.forEach(err => console.log(`     ${err}`));
    }

    return passed;
  } catch (error) {
    console.log(`  ❌ ${test.name}: ${error.message}`);
    return false;
  }
}

async function runAllTests() {
  console.log(`\n🧪 Testē ar biežākajām kļūdām`);
  console.log(`🌐 Serveris: ${SERVER_URL}\n`);

  let totalTests = 0;
  let passedTests = 0;

  for (const category of COMMON_ERRORS) {
    console.log(`\n📋 ${category.category}:`);
    console.log('─'.repeat(50));

    for (const test of category.tests) {
      totalTests++;
      const passed = await testScenario(category.category, test);
      if (passed) passedTests++;
      await new Promise(resolve => setTimeout(resolve, 500)); // Pagaidām 0.5 sekundi
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 Rezultāti: ${passedTests}/${totalTests} tests izdevās (${Math.round(passedTests/totalTests*100)}%)`);
  console.log(`\n`);
}

runAllTests().catch(console.error);

