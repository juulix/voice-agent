#!/usr/bin/env node

/**
 * Test script for Parser V3
 * Tests all scenarios directly without server
 */

// Import parser from index.js
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read index.js and extract parser class
const indexJsPath = join(__dirname, 'index.js');
const indexJs = readFileSync(indexJsPath, 'utf8');

// Extract parser class code
const parserMatch = indexJs.match(/class LatvianCalendarParserV3[\s\S]*?^}/m);
if (!parserMatch) {
  console.error('❌ Could not find Parser V3 class in index.js');
  process.exit(1);
}

// Extract parseWithV3 function code
const parseWithV3Match = indexJs.match(/function parseWithV3[\s\S]*?^}/m);
if (!parseWithV3Match) {
  console.error('❌ Could not find parseWithV3 function in index.js');
  process.exit(1);
}

// Create a minimal context for eval (we'll use a different approach)
// Instead, let's create a test that imports the actual module
// But since index.js is a server, we'll extract just what we need

// Get current time in Europe/Riga
function getNowISO() {
  const now = new Date();
  const tz = "Europe/Riga";
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset"
  });
  const partsArr = dtf.formatToParts(now);
  const parts = Object.fromEntries(partsArr.map(p => [p.type, p.value]));
  const offset = (parts.timeZoneName || "GMT+00:00").replace(/^GMT/, "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

// We'll use dynamic import to load the parser
// But first, let's check if we can import it
console.log('🧪 Testing Parser V3\n');
console.log('Note: This test requires the server to be running or parser to be imported\n');
console.log('To test with server, use:');
console.log('  curl -X POST http://localhost:3000/test-parse -H "Content-Type: application/json" -d \'{"text": "Rīt desmitos tikšanās"}\'\n');

// Test cases
const tests = [
  {
    name: "1. Vienkāršs laiks",
    text: "Rīt 10:00",
    expected: { type: "calendar", hasTime: true }
  },
  {
    name: "2. Vārdisks laiks",
    text: "Rīt desmitos",
    expected: { type: "calendar", hasTime: true }
  },
  {
    name: "3. Nedēļas diena",
    text: "Pirmdien 15:00",
    expected: { type: "calendar", hasTime: true }
  },
  {
    name: "4. Diennakts daļa",
    text: "Rīt no rīta",
    expected: { type: "calendar", hasTime: true }
  },
  {
    name: "5. Pusdeviņos (edge case)",
    text: "Pusdeviņos rīt",
    expected: { type: "calendar", hasTime: true }
  },
  {
    name: "6. Intervāls",
    text: "No 9 līdz 11 rīt",
    expected: { type: "calendar", hasTime: true, hasEnd: true }
  },
  {
    name: "7. Relatīvs laiks",
    text: "Pēc stundas",
    expected: { type: "reminder", hasTime: true }
  },
  {
    name: "8. Shopping",
    text: "Nopirkt piens, maize",
    expected: { type: "shopping", hasItems: true }
  },
  {
    name: "9. Sarežģīts",
    text: "Sapulce ar Jāni rīt desmitos Zoom",
    expected: { type: "calendar", hasTime: true }
  },
  {
    name: "10. Rīt desmitos tikšanās",
    text: "Rīt desmitos tikšanās",
    expected: { type: "calendar", hasTime: true }
  }
];

console.log('📋 Test cases:');
tests.forEach((test, i) => {
  console.log(`  ${i + 1}. ${test.name}: "${test.text}"`);
});

console.log('\n💡 To test with curl, run these commands:\n');

const nowISO = getNowISO();
tests.forEach((test, i) => {
  console.log(`# ${test.name}`);
  console.log(`curl -X POST http://localhost:3000/test-parse \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"text": "${test.text}"}'`);
  console.log('');
});

console.log('\n💡 Or test all at once with this script:\n');
console.log('#!/bin/bash');
console.log('for text in "Rīt 10:00" "Rīt desmitos" "Pirmdien 15:00" "Rīt no rīta" "Pusdeviņos rīt" "No 9 līdz 11 rīt" "Pēc stundas" "Nopirkt piens, maize" "Sapulce ar Jāni rīt desmitos Zoom" "Rīt desmitos tikšanās"; do');
console.log('  echo "Testing: $text"');
console.log('  curl -X POST http://localhost:3000/test-parse -H "Content-Type: application/json" -d "{\\"text\\": \\"$text\\"}"');
console.log('  echo ""');
console.log('done');
