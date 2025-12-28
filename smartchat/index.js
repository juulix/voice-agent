/**
 * SmartChat API Routes
 * Express router for SmartChat endpoints
 */

import express from "express";
import Busboy from "busboy";
import { createSession, getSession, deleteSession, updateContext, consumePendingToolCall, getStats } from "./session-manager.js";
import { processMessage, processToolResult, processAudioMessage } from "./chat-engine.js";
import { getGreeting } from "./prompts.js";

const router = express.Router();

// Request ID middleware
router.use((req, res, next) => {
  req.smartchatRequestId = `sc-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  console.log(`[${req.smartchatRequestId}] ${req.method} ${req.path}`);
  next();
});

/**
 * POST /api/chat/session
 * Create a new chat session
 */
router.post("/session", async (req, res) => {
  try {
    const userId = req.header("X-User-Id") || "anon";
    const language = (req.header("X-Lang") || "lv").toLowerCase();
    const { context } = req.body;
    
    if (!context) {
      return res.status(400).json({
        error: "context_required",
        message: "Context object is required",
        requestId: req.smartchatRequestId
      });
    }
    
    const session = createSession(userId, context, language);
    const greeting = getGreeting(language, session.context);
    
    console.log(`[${req.smartchatRequestId}] Created session ${session.id} for user ${userId}`);
    
    res.json({
      sessionId: session.id,
      expiresAt: new Date(session.expiresAt).toISOString(),
      greeting,
      requestId: req.smartchatRequestId
    });
    
  } catch (error) {
    console.error(`[${req.smartchatRequestId}] Session creation error:`, error.message);
    res.status(500).json({
      error: "session_creation_failed",
      message: error.message,
      requestId: req.smartchatRequestId
    });
  }
});

/**
 * POST /api/chat/message
 * Send a text message
 */
router.post("/message", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({
        error: "session_id_required",
        message: "sessionId is required",
        requestId: req.smartchatRequestId
      });
    }
    
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        error: "message_required",
        message: "Message text is required",
        requestId: req.smartchatRequestId
      });
    }
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        error: "session_not_found",
        message: "Session not found or expired",
        requestId: req.smartchatRequestId
      });
    }
    
    const result = await processMessage(session, message.trim());
    
    res.json({
      ...result,
      requestId: req.smartchatRequestId
    });
    
  } catch (error) {
    console.error(`[${req.smartchatRequestId}] Message processing error:`, error.message);
    res.status(500).json({
      error: "message_processing_failed",
      message: error.message,
      requestId: req.smartchatRequestId
    });
  }
});

/**
 * POST /api/chat/voice
 * Send a voice message (multipart form with audio file)
 */
router.post("/voice", async (req, res) => {
  try {
    const sessionId = req.header("X-Session-Id");
    
    if (!sessionId) {
      return res.status(400).json({
        error: "session_id_required",
        message: "X-Session-Id header is required",
        requestId: req.smartchatRequestId
      });
    }
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        error: "session_not_found",
        message: "Session not found or expired",
        requestId: req.smartchatRequestId
      });
    }
    
    // Parse multipart form
    let audioBuffer = Buffer.alloc(0);
    let filename = "audio.m4a";
    
    const bb = Busboy({ 
      headers: req.headers, 
      limits: { files: 1, fileSize: 5 * 1024 * 1024 } // 5MB limit
    });
    
    await new Promise((resolve, reject) => {
      bb.on("file", (_name, stream, info) => {
        filename = info?.filename || filename;
        stream.on("data", (d) => { audioBuffer = Buffer.concat([audioBuffer, d]); });
        stream.on("end", () => {});
      });
      bb.on("error", reject);
      bb.on("finish", resolve);
      req.pipe(bb);
    });
    
    if (audioBuffer.length === 0) {
      return res.status(400).json({
        error: "audio_required",
        message: "Audio file is required",
        requestId: req.smartchatRequestId
      });
    }
    
    const result = await processAudioMessage(session, audioBuffer, filename);
    
    res.json({
      ...result,
      requestId: req.smartchatRequestId
    });
    
  } catch (error) {
    console.error(`[${req.smartchatRequestId}] Voice message error:`, error.message);
    res.status(500).json({
      error: "voice_processing_failed",
      message: error.message,
      requestId: req.smartchatRequestId
    });
  }
});

/**
 * POST /api/chat/tool-result
 * Send tool execution result back
 */
router.post("/tool-result", async (req, res) => {
  try {
    const { sessionId, toolCallId, success, result, error } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({
        error: "session_id_required",
        message: "sessionId is required",
        requestId: req.smartchatRequestId
      });
    }
    
    if (!toolCallId) {
      return res.status(400).json({
        error: "tool_call_id_required",
        message: "toolCallId is required",
        requestId: req.smartchatRequestId
      });
    }
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        error: "session_not_found",
        message: "Session not found or expired",
        requestId: req.smartchatRequestId
      });
    }
    
    const response = await processToolResult(session, toolCallId, success, result, error);
    
    res.json({
      ...response,
      requestId: req.smartchatRequestId
    });
    
  } catch (err) {
    console.error(`[${req.smartchatRequestId}] Tool result error:`, err.message);
    res.status(500).json({
      error: "tool_result_processing_failed",
      message: err.message,
      requestId: req.smartchatRequestId
    });
  }
});

/**
 * POST /api/chat/confirm
 * Confirm or cancel a pending action
 */
router.post("/confirm", async (req, res) => {
  try {
    const { sessionId, toolCallId, confirmed } = req.body;
    
    if (!sessionId || toolCallId === undefined || confirmed === undefined) {
      return res.status(400).json({
        error: "invalid_request",
        message: "sessionId, toolCallId, and confirmed are required",
        requestId: req.smartchatRequestId
      });
    }
    
    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        error: "session_not_found",
        message: "Session not found or expired",
        requestId: req.smartchatRequestId
      });
    }
    
    const pendingToolCall = consumePendingToolCall(sessionId, toolCallId);
    
    if (!pendingToolCall) {
      return res.status(404).json({
        error: "pending_action_not_found",
        message: "No pending action found for this toolCallId",
        requestId: req.smartchatRequestId
      });
    }
    
    if (confirmed) {
      // Return the tool call for client execution
      res.json({
        type: "tool_call",
        tool: pendingToolCall.name,
        parameters: pendingToolCall.parameters,
        toolCallId: pendingToolCall.id,
        confirmed: true,
        sessionId,
        requestId: req.smartchatRequestId
      });
    } else {
      // Cancelled - add message to history
      const cancelMessage = session.language === 'lv' 
        ? "Darbība atcelta."
        : "Action cancelled.";
      
      res.json({
        type: "text",
        message: cancelMessage,
        cancelled: true,
        sessionId,
        requestId: req.smartchatRequestId
      });
    }
    
  } catch (error) {
    console.error(`[${req.smartchatRequestId}] Confirm error:`, error.message);
    res.status(500).json({
      error: "confirm_failed",
      message: error.message,
      requestId: req.smartchatRequestId
    });
  }
});

/**
 * POST /api/chat/context
 * Update session context (e.g., after tool execution changes data)
 */
router.post("/context", async (req, res) => {
  try {
    const { sessionId, context } = req.body;
    
    if (!sessionId || !context) {
      return res.status(400).json({
        error: "invalid_request",
        message: "sessionId and context are required",
        requestId: req.smartchatRequestId
      });
    }
    
    const session = updateContext(sessionId, context);
    if (!session) {
      return res.status(404).json({
        error: "session_not_found",
        message: "Session not found or expired",
        requestId: req.smartchatRequestId
      });
    }
    
    res.json({
      success: true,
      sessionId,
      requestId: req.smartchatRequestId
    });
    
  } catch (error) {
    console.error(`[${req.smartchatRequestId}] Context update error:`, error.message);
    res.status(500).json({
      error: "context_update_failed",
      message: error.message,
      requestId: req.smartchatRequestId
    });
  }
});

/**
 * DELETE /api/chat/session/:sessionId
 * End a chat session
 */
router.delete("/session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const deleted = deleteSession(sessionId);
    
    res.json({
      success: deleted,
      sessionId,
      requestId: req.smartchatRequestId
    });
    
  } catch (error) {
    console.error(`[${req.smartchatRequestId}] Session delete error:`, error.message);
    res.status(500).json({
      error: "session_delete_failed",
      message: error.message,
      requestId: req.smartchatRequestId
    });
  }
});

/**
 * GET /api/chat/stats
 * Get SmartChat statistics (admin only)
 */
router.get("/stats", async (req, res) => {
  try {
    // Simple auth check
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "unauthorized" });
    }
    
    const stats = getStats();
    
    res.json({
      ...stats,
      requestId: req.smartchatRequestId
    });
    
  } catch (error) {
    console.error(`[${req.smartchatRequestId}] Stats error:`, error.message);
    res.status(500).json({
      error: "stats_failed",
      message: error.message,
      requestId: req.smartchatRequestId
    });
  }
});

export default router;

