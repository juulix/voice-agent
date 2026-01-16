#!/usr/bin/env node

/**
 * Extended Parser V3 Tests
 * Tests edge cases, priority conflicts, and complex scenarios
 */

const SERVER_URL = process.env.SERVER_URL || 'https://voice-agent-production-670b.up.railway.app';

const testCases = [
  // === EXTENDED TESTS ===
  
  // Weekday edge cases
  {
    name: "Same weekday, time not passed",
    input: "Trešdien 15:00",
    currentTime: "2025-11-06T10:00:00+02:00", // Wed 10:00
    expected: { 
      type: "calendar", 
      hour: 15,
      date: "2025-11-06" // Today!
    }
  },
  {
    name: "Same weekday, time passed",
    input: "Trešdien 9:00",
    currentTime: "2025-11-06T10:00:00+02:00", // Wed 10:00
    expected: { 
      type: "calendar", 
      hour: 9,
      date: "2025-11-13" // Next Wednesday!
    }
  },
  
  // Word times with minutes
  {
    name: "Word time with minutes",
    input: "Rīt deviņos trīsdesmit",
    expected: { hour: 9, minute: 30 }
  },
  {
    name: "Divpadsmitos (noon)",
    input: "Šodien divpadsmitos",
    expected: { hour: 12, minute: 0 }
  },
  
  // Priority conflicts
  {
    name: "Numeric overrides day-part",
    input: "Rīt vakarā 10:00",
    expected: { hour: 10, minute: 0 } // NOT 19:00
  },
  
  // Relative times
  {
    name: "Relative: 30 minutes",
    input: "Pēc 30 minūtēm",
    expected: { relativeMinutes: 30 }
  },
  {
    name: "Relative: 2 hours",
    input: "Pēc 2 stundām",
    expected: { relativeMinutes: 120 }
  },
  
  // Shopping variants
  {
    name: "Shopping: iepirkt",
    input: "Iepirkties: siers, jogurts",
    expected: { type: "shopping" }
  },
  
  // Complex
  {
    name: "Complex meeting",
    input: "Sapulce ar Jāni rīt desmitos Zoom",
    expected: { type: "calendar", hour: 10 }
  },
  {
    name: "Next week + weekday",
    input: "Nākamnedēļ pirmdien no rīta",
    expected: { type: "calendar", weekday: 1, hour: 9 }
  },
  
  // LLM fallback (should return null or low confidence)
  {
    name: "Ambiguous - needs LLM",
    input: "Kad būs laiks",
    expected: { needsLLM: true }
  },
  {
    name: "Context reference - needs LLM",
    input: "Tas pats laiks kā vakar",
    expected: { needsLLM: true }
  },
  
  // Edge cases
  {
    name: "Only reminder text",
    input: "Atgādini man",
    expected: { type: "reminder", hasTime: false }
  },
  {
    name: "Only date",
    input: "Rīt",
    expected: { type: "reminder", hasTime: false }
  }
];

function generateUserId() {
  return `u-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).substring(2, 10)}`;
}

async function runExtendedTests() {
  console.log('\n🧪 EXTENDED PARSER V3 TESTS');
  console.log(`Server: ${SERVER_URL}\n`);
  console.log('='.repeat(60));
  
  let passed = 0, failed = 0;
  const failures = [];
  
  for (const test of testCases) {
    try {
      const userId = generateUserId();
      
      const response = await fetch(`${SERVER_URL}/test-parse`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-User-Id': userId
        },
        body: JSON.stringify({
          text: test.input
        })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      
      const result = await response.json();
      
      // Check expectations
      let success = true;
      const errors = [];
      
      if (test.expected.needsLLM) {
        // Should have low confidence or null
        if (result && result.confidence >= 0.85) {
          success = false;
          errors.push(`Expected LLM fallback but got confidence ${result.confidence}`);
        }
      } else {
        // Normal checks
        if (test.expected.type && result.type !== test.expected.type) {
          success = false;
          errors.push(`Type: expected ${test.expected.type}, got ${result.type}`);
        }
        
        if (test.expected.hour !== undefined && result.start) {
          const resultDate = new Date(result.start);
          const resultHour = resultDate.getHours();
          if (resultHour !== test.expected.hour) {
            success = false;
            errors.push(`Hour: expected ${test.expected.hour}, got ${resultHour}`);
          }
        }
        
        if (test.expected.minute !== undefined && result.start) {
          const resultDate = new Date(result.start);
          const resultMinute = resultDate.getMinutes();
          if (resultMinute !== test.expected.minute) {
            success = false;
            errors.push(`Minute: expected ${test.expected.minute}, got ${resultMinute}`);
          }
        }
        
        if (test.expected.hasTime !== undefined) {
          if (result.hasTime !== test.expected.hasTime) {
            success = false;
            errors.push(`hasTime: expected ${test.expected.hasTime}, got ${result.hasTime}`);
          }
        }
        
        if (test.expected.date && result.start) {
          const resultDate = new Date(result.start).toISOString().substring(0, 10);
          if (resultDate !== test.expected.date) {
            success = false;
            errors.push(`Date: expected ${test.expected.date}, got ${resultDate}`);
          }
        }
      }
      
      if (success) {
        passed++;
        console.log(`✅ ${test.name}`);
        console.log(`   Input: "${test.input}"`);
        if (result.start) {
          console.log(`   Result: ${result.type}, ${result.start}`);
        } else if (result.items) {
          console.log(`   Result: ${result.type}, items: ${result.items}`);
        }
      } else {
        failed++;
        console.log(`❌ ${test.name}`);
        console.log(`   Input: "${test.input}"`);
        console.log(`   Errors: ${errors.join(', ')}`);
        console.log(`   Result:`, JSON.stringify(result, null, 2));
        failures.push({ test, errors, result });
      }
      
      console.log('');
      
    } catch (error) {
      failed++;
      console.log(`❌ ${test.name} - Request failed: ${error.message}`);
      failures.push({ test, errors: [error.message], result: null });
      console.log('');
    }
  }
  
  console.log('='.repeat(60));
  console.log(`\n📊 EXTENDED TESTS: ${passed}/${testCases.length} passed (${Math.round(passed/testCases.length*100)}%)\n`);
  
  if (failures.length > 0) {
    console.log('❌ FAILURES:');
    failures.forEach(f => {
      console.log(`  "${f.test.input}" - ${f.errors.join(', ')}`);
    });
  }
  
  return { passed, failed, total: testCases.length };
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runExtendedTests().catch(console.error);
}

export { runExtendedTests, testCases };

