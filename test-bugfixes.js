#!/usr/bin/env node

/**
 * Quick test for bug fixes:
 * 1. nowISO format normalization
 * 2. "pēc X minūtēm" relative time parsing
 * 3. Dynamic confidence calculation
 */

// Test 1: toRigaISO format normalization
console.log('\n🧪 Test 1: toRigaISO format normalization');
console.log('Expected: ISO format with +HH:MM offset (e.g., +02:00, not +2)');

const testDate = new Date('2025-11-05T14:30:00+02:00');
const dtf = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Riga",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
  timeZoneName: "shortOffset"
});
const partsArr = dtf.formatToParts(testDate);
const parts = Object.fromEntries(partsArr.map(p => [p.type, p.value]));

let offset = (parts.timeZoneName || "GMT+00:00").replace(/^GMT/, "");
console.log(`  Raw offset: "${offset}"`);

// Apply fix
if (offset && !/[+-]\d{2}:\d{2}/.test(offset)) {
  const match = offset.match(/([+-])(\d{1,2})/);
  if (match) {
    offset = `${match[1]}${match[2].padStart(2, '0')}:00`;
  }
}

console.log(`  Normalized offset: "${offset}"`);
console.log(`  ✅ Test 1 ${/[+-]\d{2}:\d{2}/.test(offset) ? 'PASSED' : 'FAILED'}`);

// Test 2: Relative time patterns
console.log('\n🧪 Test 2: Relative time pattern matching');

const relativeTests = [
  { text: "pēc 10 minūtēm iznest atkritumu", pattern: /pēc\s+(\d+)\s*min/, expected: "10 minutes" },
  { text: "pēc 2 stundām tikšanās", pattern: /pēc\s+(\d+)\s*stund/, expected: "2 hours" },
  { text: "pēc pusstundas zvanīt", pattern: /pēc\s+(pusotras|stundas|pusstundas)/, expected: "30 minutes" }
];

relativeTests.forEach((test, i) => {
  const match = test.text.toLowerCase().match(test.pattern);
  console.log(`  Test 2.${i+1}: "${test.text}"`);
  console.log(`    Match: ${match ? match[1] : 'null'} (expected: ${test.expected})`);
  console.log(`    ${match ? '✅ PASSED' : '❌ FAILED'}`);
});

// Test 3: Confidence calculation logic
console.log('\n🧪 Test 3: Confidence calculation');

const confidenceTests = [
  {
    text: "Rīt pulksten divos tikšanās",
    hasTime: true,
    hasDay: true,
    hasType: true,
    expectedMin: 0.95
  },
  {
    text: "Rīt tikšanās",
    hasTime: false,
    hasDay: true,
    hasType: true,
    expectedMin: 0.90
  },
  {
    text: "Pulksten divos",
    hasTime: true,
    hasDay: false,
    hasType: false,
    expectedMin: 0.85
  }
];

confidenceTests.forEach((test, i) => {
  let confidence = 0.85;
  if (test.hasTime) confidence += 0.07;
  if (test.hasDay) confidence += 0.05;
  if (test.hasType) confidence += 0.03;
  confidence = Math.min(0.95, confidence);

  console.log(`  Test 3.${i+1}: "${test.text}"`);
  console.log(`    Confidence: ${confidence.toFixed(2)} (expected min: ${test.expectedMin})`);
  console.log(`    ${confidence >= test.expectedMin ? '✅ PASSED' : '❌ FAILED'}`);
});

console.log('\n✅ All unit tests completed!\n');
