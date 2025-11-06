#!/bin/bash

# Test Parser V3 via /test-parse endpoint
# Usage: ./test-parser-v3-curl.sh [SERVER_URL]
# Default: http://localhost:3000 (or use production URL)

SERVER_URL=${1:-"http://localhost:3000"}

echo "🧪 Testing Parser V3 via $SERVER_URL/test-parse"
echo "=============================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

passed=0
failed=0

test_case() {
  local text="$1"
  local description="$2"
  local expected_type="$3"
  
  echo "📝 Test: $description"
  echo "   Input: \"$text\""
  
  response=$(curl -s -X POST "$SERVER_URL/test-parse" \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"$text\"}")
  
  if [ $? -ne 0 ]; then
    echo -e "   ${RED}❌ FAILED: curl error${NC}"
    ((failed++))
    echo ""
    return
  fi
  
  # Check if response is valid JSON and contains type
  if echo "$response" | grep -q '"type"'; then
    # Extract type from JSON
    result_type=$(echo "$response" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)
    
    if [ -n "$expected_type" ] && [ "$result_type" != "$expected_type" ]; then
      echo -e "   ${YELLOW}⚠️  Type mismatch: expected $expected_type, got $result_type${NC}"
      echo "   Response: $response" | python3 -m json.tool 2>/dev/null || echo "   Response: $response"
      ((failed++))
    else
      echo -e "   ${GREEN}✅ PASSED${NC}"
      echo "   Response: $response" | python3 -m json.tool 2>/dev/null || echo "   Response: $response"
      ((passed++))
    fi
  else
    echo -e "   ${RED}❌ FAILED: Invalid response${NC}"
    echo "   Response: $response"
    ((failed++))
  fi
  
  echo ""
}

# Test cases
test_case "Rīt desmitos tikšanās" "Rīt desmitos tikšanās" "calendar"
test_case "Rīt 10:00" "Vienkāršs laiks" "calendar"
test_case "Rīt desmitos" "Vārdisks laiks" "calendar"
test_case "Pirmdien 15:00" "Nedēļas diena" "calendar"
test_case "Rīt no rīta" "Diennakts daļa" "calendar"
test_case "Pusdeviņos rīt" "Pusdeviņos (edge case)" "calendar"
test_case "No 9 līdz 11 rīt" "Intervāls" "calendar"
test_case "Pēc stundas" "Relatīvs laiks" "reminder"
test_case "Nopirkt piens, maize" "Shopping" "shopping"
test_case "Sapulce ar Jāni rīt desmitos Zoom" "Sarežģīts" "calendar"

echo "=============================================="
echo -e "${GREEN}📊 Results: $passed passed${NC}, ${RED}$failed failed${NC}"
if [ $((passed + failed)) -gt 0 ]; then
  success_rate=$((passed * 100 / (passed + failed)))
  echo "Success rate: $success_rate%"
fi

