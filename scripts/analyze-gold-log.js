#!/usr/bin/env node

/**
 * 📊 V3 Gold Log Analyzer
 * 
 * Analizē v3_gold_log datus, lai redzētu:
 * - Cik daudz V3 vs Teacher izmantots
 * - Kādi ir discrepancy rates
 * - Kā sistēma mācās
 * - Kādi ir confidence levels
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Database path
const dbPath = process.env.DB_PATH || path.join(__dirname, 'quota.db');

console.log('📊 V3 Gold Log Analyzer');
console.log('='.repeat(60));
console.log(`Database: ${dbPath}\n`);

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('❌ Failed to open database:', err.message);
    process.exit(1);
  }
});

// Helper: Run query and return results
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function analyze() {
  try {
    // 1. Total requests
    const total = await query(`SELECT COUNT(*) as count FROM v3_gold_log`);
    console.log(`📈 TOTAL REQUESTS: ${total[0].count}\n`);

    if (total[0].count === 0) {
      console.log('⚠️  No data in v3_gold_log yet. Start using the system to collect data.');
      db.close();
      return;
    }

    // 2. Decision breakdown (V3 vs Teacher)
    console.log('🎯 DECISION BREAKDOWN:');
    const decisions = await query(`
      SELECT 
        decision,
        COUNT(*) as count,
        ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM v3_gold_log), 2) as percentage
      FROM v3_gold_log
      GROUP BY decision
      ORDER BY count DESC
    `);
    decisions.forEach(d => {
      console.log(`   ${d.decision.padEnd(20)} ${String(d.count).padStart(6)} (${d.percentage}%)`);
    });
    console.log('');

    // 3. Teacher invocation rate
    const teacherInvoked = await query(`
      SELECT COUNT(*) as count 
      FROM v3_gold_log 
      WHERE teacher_result IS NOT NULL
    `);
    const teacherRate = (teacherInvoked[0].count / total[0].count * 100).toFixed(2);
    console.log(`👨‍🏫 TEACHER INVOCATION RATE: ${teacherRate}%`);
    console.log(`   Total invoked: ${teacherInvoked[0].count} / ${total[0].count}\n`);

    // 4. Discrepancy statistics
    console.log('⚠️  DISCREPANCY STATISTICS:');
    const withDiscrepancies = await query(`
      SELECT COUNT(*) as count 
      FROM v3_gold_log 
      WHERE discrepancies IS NOT NULL 
        AND discrepancies != '{}'
        AND discrepancies != 'null'
    `);
    const discrepancyRate = (withDiscrepancies[0].count / total[0].count * 100).toFixed(2);
    console.log(`   Total with discrepancies: ${withDiscrepancies[0].count} / ${total[0].count} (${discrepancyRate}%)`);

    // Severity breakdown
    const severityBreakdown = await query(`
      SELECT 
        JSON_EXTRACT(discrepancies, '$.severity') as severity,
        COUNT(*) as count
      FROM v3_gold_log
      WHERE discrepancies IS NOT NULL 
        AND discrepancies != '{}'
        AND discrepancies != 'null'
      GROUP BY severity
      ORDER BY 
        CASE severity
          WHEN 'high' THEN 1
          WHEN 'mid' THEN 2
          WHEN 'low' THEN 3
        END
    `);
    if (severityBreakdown.length > 0) {
      console.log('   Severity breakdown:');
      severityBreakdown.forEach(s => {
        const pct = (s.count / withDiscrepancies[0].count * 100).toFixed(1);
        console.log(`     ${(s.severity || 'unknown').padEnd(10)} ${String(s.count).padStart(4)} (${pct}%)`);
      });
    }
    console.log('');

    // 5. Confidence statistics
    console.log('📊 CONFIDENCE STATISTICS:');
    const confidenceStats = await query(`
      SELECT 
        AVG(confidence_after) as avg_confidence,
        MIN(confidence_after) as min_confidence,
        MAX(confidence_after) as max_confidence,
        COUNT(CASE WHEN confidence_after < 0.5 THEN 1 END) as low_confidence,
        COUNT(CASE WHEN confidence_after >= 0.5 AND confidence_after < 0.8 THEN 1 END) as medium_confidence,
        COUNT(CASE WHEN confidence_after >= 0.8 THEN 1 END) as high_confidence
      FROM v3_gold_log
      WHERE confidence_after IS NOT NULL
    `);
    if (confidenceStats[0].avg_confidence) {
      const stats = confidenceStats[0];
      console.log(`   Average: ${parseFloat(stats.avg_confidence).toFixed(3)}`);
      console.log(`   Range: ${parseFloat(stats.min_confidence).toFixed(3)} - ${parseFloat(stats.max_confidence).toFixed(3)}`);
      console.log(`   Low (<0.5): ${stats.low_confidence}`);
      console.log(`   Medium (0.5-0.8): ${stats.medium_confidence}`);
      console.log(`   High (>=0.8): ${stats.high_confidence}`);
    }
    console.log('');

    // 6. AM/PM decision breakdown
    console.log('🕐 AM/PM DECISION BREAKDOWN:');
    const amPmDecisions = await query(`
      SELECT 
        am_pm_decision,
        COUNT(*) as count
      FROM v3_gold_log
      WHERE am_pm_decision IS NOT NULL
      GROUP BY am_pm_decision
      ORDER BY count DESC
      LIMIT 10
    `);
    if (amPmDecisions.length > 0) {
      amPmDecisions.forEach(d => {
        console.log(`   ${(d.am_pm_decision || 'null').padEnd(30)} ${String(d.count).padStart(4)}`);
      });
    } else {
      console.log('   No AM/PM decisions logged yet');
    }
    console.log('');

    // 7. Triggers used
    console.log('🔔 TRIGGERS USED:');
    const triggers = await query(`
      SELECT 
        used_triggers
      FROM v3_gold_log
      WHERE used_triggers IS NOT NULL
        AND used_triggers != '[]'
        AND used_triggers != 'null'
    `);
    
    const triggerCounts = {};
    triggers.forEach(t => {
      try {
        const triggerList = JSON.parse(t.used_triggers);
        triggerList.forEach(trigger => {
          triggerCounts[trigger] = (triggerCounts[trigger] || 0) + 1;
        });
      } catch (e) {
        // Ignore parse errors
      }
    });
    
    if (Object.keys(triggerCounts).length > 0) {
      Object.entries(triggerCounts)
        .sort((a, b) => b[1] - a[1])
        .forEach(([trigger, count]) => {
          console.log(`   ${trigger.padEnd(30)} ${String(count).padStart(4)}`);
        });
    } else {
      console.log('   No triggers logged yet');
    }
    console.log('');

    // 8. Recent activity (last 24 hours)
    console.log('📅 RECENT ACTIVITY (last 24 hours):');
    const recent = await query(`
      SELECT 
        COUNT(*) as count,
        COUNT(CASE WHEN decision = 'v3' THEN 1 END) as v3_count,
        COUNT(CASE WHEN decision LIKE 'teacher%' THEN 1 END) as teacher_count
      FROM v3_gold_log
      WHERE ts >= datetime('now', '-1 day')
    `);
    console.log(`   Total: ${recent[0].count}`);
    console.log(`   V3: ${recent[0].v3_count}`);
    console.log(`   Teacher: ${recent[0].teacher_count}`);
    console.log('');

    // 9. Agreement rate (when Teacher was invoked)
    console.log('🤝 TEACHER AGREEMENT RATE:');
    const teacherResults = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN discrepancies IS NULL OR discrepancies = '{}' OR discrepancies = 'null' THEN 1 END) as agreed
      FROM v3_gold_log
      WHERE teacher_result IS NOT NULL
    `);
    if (teacherResults[0].total > 0) {
      const agreementRate = (teacherResults[0].agreed / teacherResults[0].total * 100).toFixed(2);
      console.log(`   Agreement: ${teacherResults[0].agreed} / ${teacherResults[0].total} (${agreementRate}%)`);
      console.log(`   Disagreement: ${teacherResults[0].total - teacherResults[0].agreed} / ${teacherResults[0].total} (${(100 - parseFloat(agreementRate)).toFixed(2)}%)`);
    } else {
      console.log('   No Teacher results yet');
    }
    console.log('');

    // 10. Description cleaning stats
    console.log('🧹 DESCRIPTION CLEANING:');
    const descCleaning = await query(`
      SELECT 
        COUNT(CASE WHEN desc_had_time_tokens_removed = 1 THEN 1 END) as had_tokens_removed,
        COUNT(*) as total
      FROM v3_gold_log
      WHERE desc_had_time_tokens_removed IS NOT NULL
    `);
    if (descCleaning[0].total > 0) {
      const cleaningRate = (descCleaning[0].had_tokens_removed / descCleaning[0].total * 100).toFixed(2);
      console.log(`   Time tokens removed: ${descCleaning[0].had_tokens_removed} / ${descCleaning[0].total} (${cleaningRate}%)`);
    } else {
      console.log('   No description cleaning data yet');
    }
    console.log('');

    // 11. Top discrepancies (examples)
    console.log('🔍 TOP DISCREPANCIES (examples):');
    const topDiscrepancies = await query(`
      SELECT 
        asr_text,
        decision,
        JSON_EXTRACT(discrepancies, '$.severity') as severity,
        JSON_EXTRACT(discrepancies, '$.tags') as tags
      FROM v3_gold_log
      WHERE discrepancies IS NOT NULL 
        AND discrepancies != '{}'
        AND discrepancies != 'null'
      ORDER BY 
        CASE JSON_EXTRACT(discrepancies, '$.severity')
          WHEN 'high' THEN 1
          WHEN 'mid' THEN 2
          WHEN 'low' THEN 3
        END
      LIMIT 5
    `);
    if (topDiscrepancies.length > 0) {
      topDiscrepancies.forEach((d, i) => {
        console.log(`   ${i + 1}. [${d.severity || 'unknown'}] ${d.asr_text?.substring(0, 50) || 'N/A'}...`);
        console.log(`      Decision: ${d.decision}, Tags: ${d.tags || 'none'}`);
      });
    } else {
      console.log('   No discrepancies found');
    }
    console.log('');

  } catch (error) {
    console.error('❌ Error analyzing:', error);
  } finally {
    db.close();
  }
}

analyze();

