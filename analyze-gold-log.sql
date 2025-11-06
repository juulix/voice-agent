-- 📊 SQL Queries for V3 Gold Log Analysis
-- 
-- Izmantojiet šos vaicājumus, lai analizētu Teacher-Student sistēmas darbību
-- 
-- Piemērs: sqlite3 quota.db < analyze-gold-log.sql

-- 1. TOTAL REQUESTS
SELECT COUNT(*) as total_requests FROM v3_gold_log;

-- 2. DECISION BREAKDOWN (V3 vs Teacher)
SELECT 
  decision,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM v3_gold_log), 2) as percentage
FROM v3_gold_log
GROUP BY decision
ORDER BY count DESC;

-- 3. TEACHER INVOCATION RATE
SELECT 
  COUNT(*) as total_requests,
  COUNT(CASE WHEN teacher_result IS NOT NULL THEN 1 END) as teacher_invoked,
  ROUND(COUNT(CASE WHEN teacher_result IS NOT NULL THEN 1 END) * 100.0 / COUNT(*), 2) as invocation_rate
FROM v3_gold_log;

-- 4. DISCREPANCY RATE
SELECT 
  COUNT(*) as total,
  COUNT(CASE WHEN discrepancies IS NOT NULL AND discrepancies != '{}' AND discrepancies != 'null' THEN 1 END) as with_discrepancies,
  ROUND(COUNT(CASE WHEN discrepancies IS NOT NULL AND discrepancies != '{}' AND discrepancies != 'null' THEN 1 END) * 100.0 / COUNT(*), 2) as discrepancy_rate
FROM v3_gold_log;

-- 5. SEVERITY BREAKDOWN
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
  END;

-- 6. CONFIDENCE STATISTICS
SELECT 
  AVG(confidence_after) as avg_confidence,
  MIN(confidence_after) as min_confidence,
  MAX(confidence_after) as max_confidence,
  COUNT(CASE WHEN confidence_after < 0.5 THEN 1 END) as low_confidence,
  COUNT(CASE WHEN confidence_after >= 0.5 AND confidence_after < 0.8 THEN 1 END) as medium_confidence,
  COUNT(CASE WHEN confidence_after >= 0.8 THEN 1 END) as high_confidence
FROM v3_gold_log
WHERE confidence_after IS NOT NULL;

-- 7. AM/PM DECISION BREAKDOWN
SELECT 
  am_pm_decision,
  COUNT(*) as count
FROM v3_gold_log
WHERE am_pm_decision IS NOT NULL
GROUP BY am_pm_decision
ORDER BY count DESC;

-- 8. RECENT ACTIVITY (last 24 hours)
SELECT 
  COUNT(*) as total,
  COUNT(CASE WHEN decision = 'v3' THEN 1 END) as v3_count,
  COUNT(CASE WHEN decision LIKE 'teacher%' THEN 1 END) as teacher_count
FROM v3_gold_log
WHERE ts >= datetime('now', '-1 day');

-- 9. TEACHER AGREEMENT RATE
SELECT 
  COUNT(*) as total_teacher_invocations,
  COUNT(CASE WHEN discrepancies IS NULL OR discrepancies = '{}' OR discrepancies = 'null' THEN 1 END) as agreed,
  COUNT(CASE WHEN discrepancies IS NOT NULL AND discrepancies != '{}' AND discrepancies != 'null' THEN 1 END) as disagreed,
  ROUND(COUNT(CASE WHEN discrepancies IS NULL OR discrepancies = '{}' OR discrepancies = 'null' THEN 1 END) * 100.0 / COUNT(*), 2) as agreement_rate
FROM v3_gold_log
WHERE teacher_result IS NOT NULL;

-- 10. DESCRIPTION CLEANING STATS
SELECT 
  COUNT(*) as total,
  COUNT(CASE WHEN desc_had_time_tokens_removed = 1 THEN 1 END) as had_tokens_removed,
  ROUND(COUNT(CASE WHEN desc_had_time_tokens_removed = 1 THEN 1 END) * 100.0 / COUNT(*), 2) as cleaning_rate
FROM v3_gold_log
WHERE desc_had_time_tokens_removed IS NOT NULL;

-- 11. TOP DISCREPANCIES (high severity)
SELECT 
  ts,
  asr_text,
  decision,
  JSON_EXTRACT(discrepancies, '$.severity') as severity,
  JSON_EXTRACT(discrepancies, '$.tags') as tags
FROM v3_gold_log
WHERE discrepancies IS NOT NULL 
  AND discrepancies != '{}'
  AND discrepancies != 'null'
  AND JSON_EXTRACT(discrepancies, '$.severity') = 'high'
ORDER BY ts DESC
LIMIT 10;

-- 12. CONFIDENCE BEFORE vs AFTER
SELECT 
  AVG(confidence_before) as avg_before,
  AVG(confidence_after) as avg_after,
  AVG(confidence_after - confidence_before) as avg_adjustment
FROM v3_gold_log
WHERE confidence_before IS NOT NULL 
  AND confidence_after IS NOT NULL;

-- 13. TRIGGERS USAGE
-- Note: This requires parsing JSON, so it's better to use the Node.js script
-- But here's a simple version:
SELECT 
  used_triggers,
  COUNT(*) as count
FROM v3_gold_log
WHERE used_triggers IS NOT NULL
  AND used_triggers != '[]'
  AND used_triggers != 'null'
GROUP BY used_triggers
ORDER BY count DESC
LIMIT 10;

-- 14. DAILY STATISTICS (last 7 days)
SELECT 
  DATE(ts) as date,
  COUNT(*) as total_requests,
  COUNT(CASE WHEN decision = 'v3' THEN 1 END) as v3_count,
  COUNT(CASE WHEN decision LIKE 'teacher%' THEN 1 END) as teacher_count,
  ROUND(AVG(confidence_after), 3) as avg_confidence
FROM v3_gold_log
WHERE ts >= datetime('now', '-7 days')
GROUP BY DATE(ts)
ORDER BY date DESC;

