#!/bin/bash

# Test script for Parser V3 via /test-parse endpoint
# Make sure server is running: cd voice-agent && node index.js

echo "🧪 Testing Parser V3 via /test-parse endpoint"
echo "=============================================="
echo ""

# Test cases
tests=(
  "Rīt desmitos tikšanās|Rīt desmitos tikšanās"
  "Rīt 10:00|Vienkāršs laiks"
  "Rīt desmitos|Vārdisks laiks"
  "Pirmdien 15:00|Nedēļas diena"
  "Rīt no rīta|Diennakts daļa"
  "Pusdeviņos rīt|Pusdeviņos (edge case)"
  "No 9 līdz 11 rīt|Intervāls"
  "Pēc stundas|Relatīvs laiks"
  "Nopirkt piens, maize|Shopping"
  "Sapulce ar Jāni rīt desmitos Zoom|Sarežģīts"
)

passed=0
failed=0

for test_case in "${tests[@]}"; do
  IFS='|' read -r text description <<< "$test_case"
  echo "📝 Test: $description"
  echo "   Input: \"$text\""
  
  response=$(curl -s -X POST http://localhost:3000/test-parse \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"$text\"}")
  
  if [ $? -eq 0 ]; then
    echo "   ✅ Response: $response"
    
    # Check if response contains expected fields
    if echo "$response" | grep -q '"type"'; then
      echo "   ✅ PASSED"
      ((passed++))
    else
      echo "   ❌ FAILED: Missing type field"
      ((failed++))
    fi
  else
    echo "   ❌ FAILED: curl error"
    ((failed++))
  fi
  
  echo ""
done

echo "=============================================="
echo "📊 Results: $passed passed, $failed failed"
echo "Success rate: $((passed * 100 / (passed + failed)))%"

