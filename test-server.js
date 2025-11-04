#!/usr/bin/env node

/**
 * Testa skripts servera testēšanai bez telefona
 * Lietojums: node test-server.js [audio-file.m4a] [text]
 */

import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Konfigurācija
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const TEST_USER_ID = 'u-1761411475-8ae09a4e';
const TEST_DEVICE_ID = 'd-test-device';
const TEST_PLAN = 'dev';

// Testa scenāriji (teksti, ko parsēt)
const TEST_SCENARIOS = [
  {
    name: 'Rīt pulksten divos',
    text: 'Tikšanās ar Jāni rīt pulksten divos.',
    expectedType: 'reminder',
    expectedTime: '14:00' // divos = 2, bet jāpārbauda
  },
  {
    name: 'Rīt pulksten vienos',
    text: 'Tikšanās ar Montu rīt pulksten vienos.',
    expectedType: 'reminder',
    expectedTime: '13:00'
  },
  {
    name: 'Shopping',
    text: 'Nopirkt desu, pieniņu, balto vīnu, sarkano vīnu, olas.',
    expectedType: 'shopping'
  },
  {
    name: 'Multi-reminder',
    text: 'Atgādini man rītnos rīta desmitos iznest miskasti, pēc tam vienpadsmitos pazvanīt Jānim un divpadsmitos aizbraukt pakaļ Ostinai uz skolu.',
    expectedType: 'reminders'
  }
];

/**
 * Testē ar audio failu
 */
async function testWithAudioFile(audioFilePath) {
  if (!fs.existsSync(audioFilePath)) {
    console.error(`❌ Audio fails nav atrasts: ${audioFilePath}`);
    return;
  }

  console.log(`\n📁 Testē ar audio failu: ${audioFilePath}`);
  
  const form = new FormData();
  form.append('audio', fs.createReadStream(audioFilePath), {
    filename: path.basename(audioFilePath),
    contentType: 'audio/m4a'
  });

  try {
    const response = await fetch(`${SERVER_URL}/ingest-audio`, {
      method: 'POST',
      headers: {
        'X-User-Id': TEST_USER_ID,
        'X-Device-Id': TEST_DEVICE_ID,
        'X-Plan': TEST_PLAN,
        'X-App-Version': '1.1-2',
        ...form.getHeaders()
      },
      body: form
    });

    const data = await response.json();
    
    console.log(`\n✅ Status: ${response.status}`);
    console.log(`📊 Response:`, JSON.stringify(data, null, 2));
    
    if (data.type) {
      console.log(`\n✅ Type: ${data.type}`);
      if (data.start) {
        console.log(`📅 Start: ${data.start}`);
      }
      if (data.description) {
        console.log(`📝 Description: ${data.description}`);
      }
    }
    
    return data;
  } catch (error) {
    console.error(`❌ Kļūda:`, error.message);
    throw error;
  }
}

/**
 * Testē ar tīru tekstu (simulē Whisper transkripciju)
 * Piezīme: ja serveris nav modificēts, lai pieņemtu tīru tekstu, šis nedarbosies
 */
async function testWithText(text, scenarioName) {
  console.log(`\n📝 Testē scenāriju: ${scenarioName}`);
  console.log(`📄 Text: "${text}"`);
  
  // Izveidojam vienkāršu audio failu vai izmantojam mock
  // Vai arī modificējam serveri, lai pieņemtu tīru tekstu testiem
  
  // Pagaidām izmantosim HTTP POST ar tekstu (ja serveris atbalsta)
  try {
    const response = await fetch(`${SERVER_URL}/ingest-audio`, {
      method: 'POST',
      headers: {
        'X-User-Id': TEST_USER_ID,
        'X-Device-Id': TEST_DEVICE_ID,
        'X-Plan': TEST_PLAN,
        'X-App-Version': '1.1-2',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text,
        test_mode: true // Ja serveris atbalsta test mode
      })
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Status: ${response.status}`);
      console.log(`📊 Response:`, JSON.stringify(data, null, 2));
      return data;
    } else {
      console.log(`⚠️ Serveris neatbalsta tīru tekstu. Izmantojiet audio failu.`);
    }
  } catch (error) {
    console.log(`⚠️ Serveris neatbalsta tīru tekstu: ${error.message}`);
  }
}

/**
 * Testē visus scenārijus ar tekstiem (ja serveris atbalsta)
 */
async function testAllScenarios() {
  console.log('\n🧪 Testē visus scenārijus...\n');
  
  for (const scenario of TEST_SCENARIOS) {
    await testWithText(scenario.text, scenario.name);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Pagaidām 1 sekundi
  }
}

/**
 * Galvenā funkcija
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
📋 Lietojums:
  node test-server.js [audio-file.m4a]     # Testē ar audio failu
  node test-server.js --scenarios           # Testē visus scenārijus (ja serveris atbalsta)
  node test-server.js --text "teksts"      # Testē ar tekstu (ja serveris atbalsta)

🌐 Serveris: ${SERVER_URL}
👤 User ID: ${TEST_USER_ID}
📱 Device ID: ${TEST_DEVICE_ID}
📦 Plan: ${TEST_PLAN}

Piemērs:
  node test-server.js test-audio.m4a
  node test-server.js --text "Rīt pulksten divos tikšanās ar Jāni"
    `);
    return;
  }

  if (args[0] === '--scenarios') {
    await testAllScenarios();
  } else if (args[0] === '--text' && args[1]) {
    await testWithText(args[1], 'Custom text');
  } else if (args[0].endsWith('.m4a') || args[0].endsWith('.mp3') || args[0].endsWith('.wav')) {
    await testWithAudioFile(args[0]);
  } else {
    console.error(`❌ Nezināms arguments: ${args[0]}`);
    console.log(`💡 Izmantojiet: node test-server.js [audio-file.m4a] vai --text "teksts"`);
  }
}

main().catch(console.error);

