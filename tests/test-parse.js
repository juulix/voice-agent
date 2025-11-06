#!/usr/bin/env node

/**
 * Vienkāršs testa skripts servera testēšanai
 * Lietojums: node test-parse.js [teksts] [server-url]
 */

const SERVER_URL = process.argv[3] || process.env.SERVER_URL || 'http://localhost:8080';
const TEST_TEXT = process.argv[2] || 'Rīt pulksten divos tikšanās ar Jāni.';

async function testParse(text) {
  console.log(`\n🧪 Testē: "${text}"`);
  console.log(`🌐 Serveris: ${SERVER_URL}`);
  console.log('');
  
  try {
    const response = await fetch(`${SERVER_URL}/test-parse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': 'u-1761411475-8ae09a4e', // Test user ID
        'X-Device-Id': 'd-test-device',
        'X-Plan': 'dev',
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Kļūda: ${response.status} ${response.statusText}`);
      console.error(`📄 Atbilde: ${errorText}`);
      return;
    }

    const data = await response.json();
    
    console.log('✅ Rezultāts:');
    console.log(JSON.stringify(data, null, 2));
    
    // Vienkāršs validācijas tests
    if (data.type) {
      console.log(`\n✅ Type: ${data.type}`);
    } else {
      console.log(`\n⚠️ Nav 'type' lauka`);
    }
    
    if (data.start) {
      console.log(`📅 Start: ${data.start}`);
    }
    
    if (data.description) {
      console.log(`📝 Description: ${data.description}`);
    }
    
    if (data.test_mode) {
      console.log(`🧪 Test mode: ${data.test_mode}`);
    }
    
  } catch (error) {
    console.error(`❌ Kļūda: ${error.message}`);
    if (error.code === 'ECONNREFUSED') {
      console.error(`💡 Serveris nav pieejams. Pārbaudiet, vai serveris darbojas vai izmantojiet Railway URL:`);
      console.error(`   node test-parse.js "${text}" https://your-app.up.railway.app`);
    }
  }
}

// Testa scenāriji
const scenarios = [
  'Rīt pulksten divos tikšanās ar Jāni.',
  'Rīt pulksten vienos tikšanās ar Montu.',
  'Nopirkt desu, pieniņu, balto vīnu.',
  'Atgādini man rītnos rīta desmitos iznest miskasti.',
];

async function runTests() {
  if (process.argv[2] === '--all') {
    console.log('🧪 Testē visus scenārijus...\n');
    for (const text of scenarios) {
      await testParse(text);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Pagaidām 1 sekundi
    }
  } else {
    await testParse(TEST_TEXT);
  }
}

runTests().catch(console.error);

