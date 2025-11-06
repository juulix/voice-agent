#!/bin/bash

# Script to clean up unnecessary files before App Store submission
# This script organizes files into docs/ and tests/ directories, and removes temporary files

set -e

echo "🧹 Starting cleanup process..."
echo ""

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# ====================
# SERVER CLEANUP
# ====================
echo "📁 Server cleanup (voice-agent)..."
echo ""

# Create directories
mkdir -p docs
mkdir -p tests

# Move documentation to docs/
echo "  📄 Moving documentation to docs/..."
mv -f ANALYZE_GOLD_LOG.md docs/ 2>/dev/null || true
mv -f IMPLEMENTATION_PLAN.md docs/ 2>/dev/null || true
mv -f RAILWAY_SETUP.md docs/ 2>/dev/null || true
mv -f RAILWAY_TROUBLESHOOTING.md docs/ 2>/dev/null || true
mv -f TEACHER_STUDENT_IMPLEMENTATION.md docs/ 2>/dev/null || true
mv -f analyze-gold-log.sql docs/ 2>/dev/null || true

# Move test files to tests/
echo "  🧪 Moving test files to tests/..."
mv -f test-*.js tests/ 2>/dev/null || true
mv -f test-*.sh tests/ 2>/dev/null || true
mv -f test-*.md tests/ 2>/dev/null || true
mv -f TEST_README.md tests/ 2>/dev/null || true

# Remove temporary files
echo "  🗑️  Removing temporary files..."
rm -f voice-agent.zip 2>/dev/null || true

# Keep README.md in root (useful for GitHub)
echo "  ✅ README.md kept in root (for GitHub)"

echo ""
echo "✅ Server cleanup complete!"
echo ""

# ====================
# APP CLEANUP
# ====================
APP_DIR="$HOME/Documents/Balss Assistents Clean"

if [ -d "$APP_DIR" ]; then
    echo "📱 App cleanup (Balss Assistents Clean)..."
    echo ""
    
    cd "$APP_DIR"
    
    # Create docs directory
    mkdir -p docs
    
    # Move analysis documents to docs/
    echo "  📄 Moving analysis documents to docs/..."
    mv -f AI_PROMPT_KATEGORIJAS.md docs/ 2>/dev/null || true
    mv -f CHECK_SERVER_DATA.md docs/ 2>/dev/null || true
    mv -f DUAL_SERVER_ANALYSIS.md docs/ 2>/dev/null || true
    mv -f INVENTARIZACIJAS_IZVESTS.md docs/ 2>/dev/null || true
    mv -f IOS_APP_UPDATE_INFO.md docs/ 2>/dev/null || true
    mv -f IZMAINAS_SUMMARY.md docs/ 2>/dev/null || true
    mv -f KODA_ANALIZE_UN_TIRISANA.md docs/ 2>/dev/null || true
    mv -f PRODUKTU_APSTRADES_ANALIZE.md docs/ 2>/dev/null || true
    mv -f PRODUKTU_APSTRADES_PLUSMA.md docs/ 2>/dev/null || true
    mv -f RAILWAY_HEALTH_REPORT.md docs/ 2>/dev/null || true
    mv -f SERVER_ANALYSIS.md docs/ 2>/dev/null || true
    mv -f SYSTEM_ANALYSIS.md docs/ 2>/dev/null || true
    mv -f TELEMETRIJAS_ANALIZE.md docs/ 2>/dev/null || true
    mv -f TEXT_KOREKCIJAS_ANALIZE.md docs/ 2>/dev/null || true
    mv -f V3_LEARNING_MECHANISM.md docs/ 2>/dev/null || true
    mv -f V3_PARSER_ANALIZE.md docs/ 2>/dev/null || true
    mv -f VERSIJAS_1.1_PLANS.md docs/ 2>/dev/null || true
    
    # Move App Store documents to docs/
    echo "  📱 Moving App Store documents to docs/..."
    mv -f APP_STORE_DESCRIPTION.md docs/ 2>/dev/null || true
    mv -f APP_STORE_METADATA.md docs/ 2>/dev/null || true
    mv -f EXPORT_COMPLIANCE_INSTRUKCIJAS.md docs/ 2>/dev/null || true
    mv -f GEOFENCE_SETUP_INSTRUCTIONS.md docs/ 2>/dev/null || true
    mv -f PRIVACY_POLICY.md docs/ 2>/dev/null || true
    mv -f TERMS_OF_SERVICE.md docs/ 2>/dev/null || true
    mv -f TESTFLIGHT_1.1_INSTRUKCIJAS.md docs/ 2>/dev/null || true
    mv -f VERSIJAS_1.1_CHANGELOG.md docs/ 2>/dev/null || true
    mv -f WIDGET_SETUP_INSTRUCTIONS.md docs/ 2>/dev/null || true
    mv -f README.md docs/ 2>/dev/null || true
    
    # Remove temporary files
    echo "  🗑️  Removing temporary files..."
    rm -f check_servers.sh 2>/dev/null || true
    
    echo ""
    echo "✅ App cleanup complete!"
    echo ""
else
    echo "⚠️  App directory not found: $APP_DIR"
    echo "   Skipping app cleanup..."
    echo ""
fi

# ====================
# SUMMARY
# ====================
echo "📊 Cleanup Summary:"
echo ""
echo "Server (voice-agent):"
echo "  ✅ Documentation moved to docs/"
echo "  ✅ Test files moved to tests/"
echo "  ✅ Temporary files removed"
echo ""
echo "App (Balss Assistents Clean):"
echo "  ✅ Analysis documents moved to docs/"
echo "  ✅ App Store documents moved to docs/"
echo "  ✅ Temporary files removed"
echo ""
echo "🎉 All done! Your project is now clean and ready for App Store submission."
echo ""
echo "💡 Note: If you need any files back, they're in docs/ and tests/ directories."

