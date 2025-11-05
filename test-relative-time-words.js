#!/usr/bin/env node

/**
 * Quick test for word-based relative time patterns
 */

console.log('\n🧪 Word-Based Relative Time Pattern Tests\n');

const testPatterns = [
  { text: "pēc desmit minūtēm atzvanīt", pattern: /pēc\s+(pieci|desmit|piecpadsmit|divdesmit|divdesmit\s+pieci|trīsdesmit|četrdesmit|piecdesmit)\s*min/, expected: "desmit (10 min)" },
  { text: "pēc 10 minūtēm atzvanīt", pattern: /pēc\s+(\d+)\s*min/, expected: "10 (numeric)" },
  { text: "pēc divdesmit minūtēm zvanīt", pattern: /pēc\s+(pieci|desmit|piecpadsmit|divdesmit|divdesmit\s+pieci|trīsdesmit|četrdesmit|piecdesmit)\s*min/, expected: "divdesmit (20 min)" },
  { text: "pēc divām stundām tikšanās", pattern: /pēc\s+(vienas?|divām|trim|četrām|piecām)\s*stund/, expected: "divām (2h)" },
  { text: "pēc 2 stundām tikšanās", pattern: /pēc\s+(\d+)\s*stund/, expected: "2 (numeric)" },
];

testPatterns.forEach((test, i) => {
  const match = test.text.toLowerCase().match(test.pattern);
  console.log(`  Test ${i+1}: "${test.text}"`);
  console.log(`    Pattern: ${test.pattern.source}`);
  console.log(`    Match: ${match ? match[1] : 'null'} (expected: ${test.expected})`);
  console.log(`    ${match ? '✅ PASSED' : '❌ FAILED'}`);
  console.log('');
});

// Test word to number conversion
console.log('📐 Word-to-Number Conversion Tests:\n');

const minuteMap = {
  'pieci': 5, 'desmit': 10, 'piecpadsmit': 15, 'divdesmit': 20,
  'divdesmit pieci': 25, 'trīsdesmit': 30, 'četrdesmit': 40, 'piecdesmit': 50
};

const hourMap = {
  'vienas': 1, 'viena': 1, 'divām': 2, 'trim': 3, 'četrām': 4, 'piecām': 5
};

console.log('  Minutes:');
Object.entries(minuteMap).forEach(([word, mins]) => {
  console.log(`    "${word}" → ${mins} minutes`);
});

console.log('\n  Hours:');
Object.entries(hourMap).forEach(([word, hours]) => {
  console.log(`    "${word}" → ${hours} hours`);
});

console.log('\n✅ All tests completed!\n');
