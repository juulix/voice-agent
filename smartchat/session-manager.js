/**
 * SmartChat Session Manager
 * Handles session creation, retrieval, and lifecycle management
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// In-memory session storage
const sessions = new Map();

// Session configuration
const CLEANUP_INTERVAL = 5 * 60 * 1000;    // Cleanup every 5 minutes
const SESSION_TTL = 30 * 60 * 1000;         // 30 minutes idle timeout
const MAX_SESSION_DURATION = 2 * 60 * 60 * 1000; // 2 hours max session duration
const BACKUP_INTERVAL = 60 * 1000;          // Backup every 1 minute

// Backup file path (use Railway volume if available)
const BACKUP_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp';
const BACKUP_FILE = path.join(BACKUP_DIR, 'smartchat-sessions.json');

/**
 * Restore sessions from backup file on startup
 */
function restoreSessionsFromBackup() {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const data = fs.readFileSync(BACKUP_FILE, 'utf8');
      const backup = JSON.parse(data);
      const now = Date.now();
      let restored = 0;
      let expired = 0;
      
      for (const [id, session] of Object.entries(backup.sessions || {})) {
        // Check if session is still valid (not expired)
        if (now < session.expiresAt && now < session.createdAt + MAX_SESSION_DURATION) {
          sessions.set(id, session);
          restored++;
        } else {
          expired++;
        }
      }
      
      console.log(`📂 Restored ${restored} sessions from backup (${expired} expired)`);
    }
  } catch (error) {
    console.warn(`⚠️ Could not restore sessions from backup: ${error.message}`);
  }
}

/**
 * Save sessions to backup file
 */
function saveSessionsToBackup() {
  try {
    const backup = {
      timestamp: Date.now(),
      savedAt: new Date().toISOString(),
      sessionCount: sessions.size,
      sessions: Object.fromEntries(sessions)
    };
    
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup), 'utf8');
    // Only log if there are sessions to save
    if (sessions.size > 0) {
      console.log(`💾 Backed up ${sessions.size} sessions`);
    }
  } catch (error) {
    console.error(`❌ Failed to backup sessions: ${error.message}`);
  }
}

// Restore sessions on module load
restoreSessionsFromBackup();

// Periodic backup
setInterval(saveSessionsToBackup, BACKUP_INTERVAL);

// Cleanup expired sessions periodically
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions) {
    // Check both TTL expiry AND max session duration
    const isExpired = now > session.expiresAt;
    const exceedsMaxDuration = now > session.createdAt + MAX_SESSION_DURATION;
    
    if (isExpired || exceedsMaxDuration) {
      sessions.delete(id);
      cleaned++;
      if (exceedsMaxDuration && !isExpired) {
        console.log(`⏰ Session ${id} exceeded max duration (2h)`);
      }
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired SmartChat sessions`);
    saveSessionsToBackup(); // Save after cleanup
  }
}, CLEANUP_INTERVAL);

// Save sessions on process exit
process.on('SIGINT', () => {
  console.log('💾 Saving sessions before shutdown...');
  saveSessionsToBackup();
});
process.on('SIGTERM', () => {
  console.log('💾 Saving sessions before shutdown...');
  saveSessionsToBackup();
});

/**
 * Generate secure session ID using crypto
 * @returns {string} Secure random session ID
 */
function generateSecureSessionId() {
  return `sc_${crypto.randomUUID()}`;
}

/**
 * Create a new chat session
 * @param {string} userId - User identifier
 * @param {object} context - Initial context (events, reminders, etc.)
 * @param {string} language - Language code (lv, et, en)
 * @returns {object} Created session
 */
export function createSession(userId, context, language = 'lv') {
  const sessionId = generateSecureSessionId();
  
  const session = {
    id: sessionId,
    userId,
    language,
    context: {
      todayEvents: context.todayEvents || [],
      tomorrowEvents: context.tomorrowEvents || [],
      weekEvents: context.weekEvents || [],
      reminders: context.reminders || [],
      shoppingItems: context.shoppingItems || [],
      shoppingLists: context.shoppingLists || [],
      timezone: context.timezone || 'Europe/Riga',
      currentDate: context.currentDate || new Date().toISOString().split('T')[0],
      currentTime: context.currentTime || new Date().toTimeString().split(' ')[0]
    },
    messages: [],
    pendingToolCalls: [], // Track pending tool calls awaiting results
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL,
    lastActivity: Date.now()
  };
  
  sessions.set(sessionId, session);
  console.log(`📱 Created SmartChat session: ${sessionId} for user: ${userId}`);
  
  return session;
}

/**
 * Get a session by ID
 * @param {string} sessionId - Session identifier
 * @returns {object|null} Session or null if not found/expired
 */
export function getSession(sessionId) {
  const session = sessions.get(sessionId);
  
  if (!session) {
    console.log(`❌ Session not found: ${sessionId}`);
    return null;
  }
  
  if (Date.now() > session.expiresAt) {
    console.log(`⏰ Session expired: ${sessionId}`);
    sessions.delete(sessionId);
    return null;
  }
  
  // Extend session on activity
  session.lastActivity = Date.now();
  session.expiresAt = Date.now() + SESSION_TTL;
  
  return session;
}

/**
 * Add a message to session history
 * @param {string} sessionId - Session identifier
 * @param {string} role - Message role (user, assistant, system, tool)
 * @param {string} content - Message content
 * @param {object} metadata - Optional metadata (toolCallId, etc.)
 * @returns {object|null} Updated session or null
 */
export function addMessage(sessionId, role, content, metadata = {}) {
  const session = getSession(sessionId);
  if (!session) return null;
  
  const message = {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    role,
    content,
    timestamp: Date.now(),
    ...metadata
  };
  
  session.messages.push(message);
  
  // Keep message history manageable (last 50 messages)
  if (session.messages.length > 50) {
    session.messages = session.messages.slice(-50);
  }
  
  return session;
}

/**
 * Add a pending tool call
 * @param {string} sessionId - Session identifier
 * @param {object} toolCall - Tool call details
 */
export function addPendingToolCall(sessionId, toolCall) {
  const session = getSession(sessionId);
  if (!session) return null;
  
  session.pendingToolCalls.push({
    ...toolCall,
    createdAt: Date.now()
  });
  
  return session;
}

/**
 * Get and remove a pending tool call
 * @param {string} sessionId - Session identifier
 * @param {string} toolCallId - Tool call identifier
 */
export function consumePendingToolCall(sessionId, toolCallId) {
  const session = getSession(sessionId);
  if (!session) return null;
  
  const index = session.pendingToolCalls.findIndex(tc => tc.id === toolCallId);
  if (index === -1) return null;
  
  const [toolCall] = session.pendingToolCalls.splice(index, 1);
  return toolCall;
}

/**
 * Update session context with fresh data
 * @param {string} sessionId - Session identifier
 * @param {object} contextUpdate - Partial context update
 */
export function updateContext(sessionId, contextUpdate) {
  const session = getSession(sessionId);
  if (!session) return null;
  
  session.context = {
    ...session.context,
    ...contextUpdate
  };
  
  return session;
}

/**
 * Delete a session
 * @param {string} sessionId - Session identifier
 */
export function deleteSession(sessionId) {
  const existed = sessions.delete(sessionId);
  if (existed) {
    console.log(`🗑️ Deleted SmartChat session: ${sessionId}`);
  }
  return existed;
}

/**
 * Get session stats
 * @returns {object} Session statistics
 */
export function getStats() {
  return {
    activeSessions: sessions.size,
    sessions: Array.from(sessions.values()).map(s => ({
      id: s.id,
      userId: s.userId,
      messageCount: s.messages.length,
      createdAt: new Date(s.createdAt).toISOString(),
      expiresAt: new Date(s.expiresAt).toISOString()
    }))
  };
}

export default {
  createSession,
  getSession,
  addMessage,
  addPendingToolCall,
  consumePendingToolCall,
  updateContext,
  deleteSession,
  getStats
};

