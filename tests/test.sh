#!/bin/bash

# Testa skripts servera testēšanai bez telefona
# Lietojums: ./test.sh [teksts] vai ./test.sh

SERVER_URL="${SERVER_URL:-http://localhost:8080}"

# Testa scenāriji
test_scenario() {
    local text="$1"
    local name="$2"
    
    echo ""
    echo "🧪 Testē: $name"
    echo "📝 Teksts: \"$text\""
    echo ""
    
    curl -X POST "${SERVER_URL}/test-parse" \
        -H "Content-Type: application/json" \
        -d "{\"text\": \"$text\"}" \
        | jq '.' 2>/dev/null || cat
    
    echo ""
    echo "---"
}

# Ja nav arguments, izmantojam noklusētos testus
if [ -z "$1" ]; then
    echo "🧪 Testē serveri ar standarta scenārijiem..."
    echo "💡 Vai arī izmantojiet: ./test.sh \"Rīt pulksten divos tikšanās ar Jāni\""
    echo ""
    
    test_scenario "Rīt pulksten divos tikšanās ar Jāni." "Rīt pulksten divos"
    sleep 1
    
    test_scenario "Rīt pulksten vienos tikšanās ar Montu." "Rīt pulksten vienos"
    sleep 1
    
    test_scenario "Nopirkt desu, pieniņu, balto vīnu." "Shopping"
    sleep 1
    
    test_scenario "Atgādini man rītnos rīta desmitos iznest miskasti." "Multi-reminder"
else
    # Testē ar custom tekstu
    test_scenario "$1" "Custom text"
fi

