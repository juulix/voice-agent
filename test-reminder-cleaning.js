/**
 * Unit tests for cleanReminderText() function
 * Tests reminder text cleaning for display
 */

import { LatvianCalendarParserV3 } from './index.js';

// Create parser instance
const parser = new LatvianCalendarParserV3();

// Test cases
const testCases = [
  {
    input: "Atgādini man pēc 10 minūtēm uzzvanīt grāmatvedei.",
    expected: "Uzzvanīt grāmatvedei"
  },
  {
    input: "Pēc 20 min atgādini nosūtīt rēķinu.",
    expected: "Nosūtīt rēķinu"
  },
  {
    input: "Atgādinājums: rīt 9:00 pārzvanīt Montai.",
    expected: "Pārzvanīt Montai"
  },
  {
    input: "Atgādini pēc stundas izslēgt krāsni.",
    expected: "Izslēgt krāsni"
  },
  {
    input: "Lūdzu, atgādiniet man pēc 30 min. aizsūtīt piedāvājumu klientam.",
    expected: "Aizsūtīt piedāvājumu klientam"
  },
  {
    input: "Atgādinājums: pēc stundas iesniegt atskaiti līdz 15. novembrim.",
    expected: "Iesniegt atskaiti (līdz 15.11.)"
  },
  {
    input: "Pulksten 10.00 nosūtīt rēķinu.",
    expected: "Nosūtīt rēķinu"
  },
  {
    input: "Rīt pulksten divos atgādini pārzvanīt Montai.",
    expected: "Pārzvanīt Montai"
  },
  {
    input: "Pēc 5 minūtēm atgādini izslēgt datoru.",
    expected: "Izslēgt datoru"
  },
  {
    input: "Atgādinājums – pēc 10 minūtēm atgādināt atgādinājumu",
    expected: "Pārbaudīt atgādinājumu" // Edge case - should handle recursive "atgādināt"
  },
  {
    input: "Trešdien pulksten desmitos atgādini tikšanās ar klientu.",
    expected: "Tikšanās ar klientu"
  },
  {
    input: "15. novembrī pulksten 14:00 atgādini sapulce ar komandu.",
    expected: "Sapulce ar komandu"
  },
  {
    input: "Atgādini man rīt no rīta aizvest bērnu uz skolu.",
    expected: "Aizvest bērnu uz skolu"
  },
  {
    input: "Pēc divām stundām atgādini pārbaudīt e-pastu.",
    expected: "Pārbaudīt e-pastu"
  },
  {
    input: "Atgādinājums: iesniegt dokumentus līdz 20. decembrim.",
    expected: "Iesniegt dokumentus (līdz 20.12.)"
  },
  {
    input: "Parīt pulksten 18:00 atgādini zvans bankai.",
    expected: "Zvans bankai"
  },
  {
    input: "Atgādini pēc pusstundas izslēgt gaismu.",
    expected: "Izslēgt gaismu"
  },
  {
    input: "Šodien vakarā atgādini sagatavot prezentāciju.",
    expected: "Sagatavot prezentāciju"
  },
  {
    input: "Atgādinājums: nosūtīt rēķinu līdz 25.11.",
    expected: "Nosūtīt rēķinu (līdz 25.11.)"
  },
  {
    input: "Pēc 45 min atgādini pārzvanīt.",
    expected: "Pārzvanīt"
  }
];

// Edge cases with errors/typos
const edgeCases = [
  {
    input: "atgādini pēc 10 min uzzvanīt grāmatvedei", // lowercase, no punctuation
    expected: "Uzzvanīt grāmatvedei"
  },
  {
    input: "Atgādinājums   pēc   20   minūtēm   nosūtīt   rēķinu.", // multiple spaces
    expected: "Nosūtīt rēķinu"
  },
  {
    input: "atgādini", // only keyword
    expected: "atgādini" // fallback to original
  },
  {
    input: "pēc 10 min", // only time phrase
    expected: "pēc 10 min" // fallback to original
  },
  {
    input: "uzzvanīt grāmatvedei", // no meta-info
    expected: "Uzzvanīt grāmatvedei" // just capitalize
  }
];

// Run tests
function runTests(parser) {
  console.log('🧪 Running reminder cleaning tests...\n');
  
  let passed = 0;
  let failed = 0;
  
  // Test main cases
  console.log('📋 Main test cases:');
  testCases.forEach((test, index) => {
    const result = parser.cleanReminderText(test.input);
    const success = result === test.expected;
    
    if (success) {
      console.log(`✅ Test ${index + 1}: PASSED`);
      passed++;
    } else {
      console.log(`❌ Test ${index + 1}: FAILED`);
      console.log(`   Input:    "${test.input}"`);
      console.log(`   Expected: "${test.expected}"`);
      console.log(`   Got:      "${result}"`);
      failed++;
    }
  });
  
  // Test edge cases
  console.log('\n📋 Edge cases:');
  edgeCases.forEach((test, index) => {
    const result = parser.cleanReminderText(test.input);
    const success = result === test.expected;
    
    if (success) {
      console.log(`✅ Edge case ${index + 1}: PASSED`);
      passed++;
    } else {
      console.log(`❌ Edge case ${index + 1}: FAILED`);
      console.log(`   Input:    "${test.input}"`);
      console.log(`   Expected: "${test.expected}"`);
      console.log(`   Got:      "${result}"`);
      failed++;
    }
  });
  
  // Summary
  console.log('\n📊 Summary:');
  console.log(`   Passed: ${passed}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Total:  ${passed + failed}`);
  console.log(`   Success rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  
  if (failed === 0) {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed.');
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  runTests();
}

export { testCases, edgeCases, runTests };

