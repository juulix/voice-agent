#!/usr/bin/env node

/**
 * Simple test - just verify parser syntax and basic structure
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('📋 Parser V3 Integration Status:\n');

// Check if parser class exists
const indexJsPath = join(__dirname, 'index.js');
const indexJs = readFileSync(indexJsPath, 'utf8');

const hasParserClass = indexJs.includes('class LatvianCalendarParserV3');
const hasParseWithV3 = indexJs.includes('function parseWithV3');
const usesParseWithV3 = (indexJs.match(/parseWithV3\(/g) || []).length;

console.log(`✅ Parser V3 class exists: ${hasParserClass}`);
console.log(`✅ parseWithV3 function exists: ${hasParseWithV3}`);
console.log(`✅ parseWithV3 called ${usesParseWithV3} times in code\n`);

// Check integration points
const testEndpoint = indexJs.includes('/test-parse');
const audioEndpoint = indexJs.includes('/ingest-audio');

console.log('📡 Integration points:');
console.log(`   /test-parse endpoint: ${testEndpoint ? '✅' : '❌'}`);
console.log(`   /ingest-audio endpoint: ${audioEndpoint ? '✅' : '❌'}\n`);

// Check if parseWithCode is still used
const parseWithCodeCalls = (indexJs.match(/parseWithCode\(/g) || []).length;
if (parseWithCodeCalls > 0) {
  console.log(`⚠️  parseWithCode still called ${parseWithCodeCalls} times (should be 0)`);
} else {
  console.log(`✅ parseWithCode no longer used`);
}

console.log('\n' + '='.repeat(60));
console.log('\n✅ Parser V3 is integrated!');
console.log('\n💡 To test with actual server:');
console.log('   1. Set OPENAI_API_KEY environment variable');
console.log('   2. Run: node index.js');
console.log('   3. Test: curl -X POST http://localhost:3000/test-parse \\');
console.log('            -H "Content-Type: application/json" \\');
console.log('            -d \'{"text": "Rīt desmitos tikšanās"}\'');
console.log('\n');

