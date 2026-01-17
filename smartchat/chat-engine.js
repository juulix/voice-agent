/**
 * SmartChat Chat Engine
 * Handles GPT interactions with function calling
 */

import OpenAI from "openai";
import { SMARTCHAT_TOOLS, requiresConfirmation, isQueryTool } from "./tools.js";
import { getSystemPrompt, getConfirmationMessage } from "./prompts.js";
import { addMessage, addPendingToolCall, getSession } from "./session-manager.js";

// Validate API key before creating OpenAI client
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY environment variable");
  console.error("❌ SmartChat cannot function without OpenAI API key");
  // Don't crash here - let the main server handle it
  // But log the error clearly
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ========== MODEL CONFIGURATION WITH FALLBACK ==========
// PRIMARY - galvenais modelis
// FALLBACK - backup modelis, ja PRIMARY neizdodas
// NOTE: GPT-5 modeļi (mini/nano) bija pārāk lēni (14-20s), atgriezāmies pie GPT-4o
const PRIMARY_MODEL = process.env.SMARTCHAT_PRIMARY_MODEL || "gpt-4o";
const FALLBACK_MODEL = process.env.SMARTCHAT_FALLBACK_MODEL || "gpt-4o";

// Legacy alias (for backward compatibility)
const CHAT_MODEL = PRIMARY_MODEL;

const MAX_TOKENS = 1000;

// Reasoning models (GPT-5+) don't support temperature parameter
const REASONING_MODELS = new Set([
  "gpt-5", "gpt-5-mini", "gpt-5-nano",
  "gpt-5.2", "gpt-5.2-pro"
]);

// Get temperature based on model (reasoning models don't support it)
function getTemperature(model) {
  return REASONING_MODELS.has(model) ? undefined : 0.3;
}

console.log(`🤖 SmartChat model config: PRIMARY=${PRIMARY_MODEL}, FALLBACK=${FALLBACK_MODEL}`);

/**
 * Call GPT with automatic fallback if PRIMARY fails
 * @param {object} params - GPT API params (without model)
 * @param {string} sessionId - Session ID for logging
 * @returns {object} { response, modelUsed, fallbackUsed }
 */
async function callGPTWithFallback(params, sessionId) {
  // Check if OpenAI client is initialized
  if (!openai) {
    throw new Error("OpenAI client not initialized: OPENAI_API_KEY is missing");
  }
  
  const startTime = Date.now();
  
  // Try PRIMARY model first
  try {
    const primaryParams = {
      ...params,
      model: PRIMARY_MODEL
    };
    
    // Add temperature only if model supports it
    const temp = getTemperature(PRIMARY_MODEL);
    if (temp !== undefined) {
      primaryParams.temperature = temp;
    }
    
    const response = await openai.chat.completions.create(primaryParams);
    const duration = Date.now() - startTime;
    
    console.log(`[SmartChat ${sessionId}] 🤖 Model: ${PRIMARY_MODEL} (primary) - ${duration}ms`);
    
    return {
      response,
      modelUsed: PRIMARY_MODEL,
      fallbackUsed: false,
      duration
    };
    
  } catch (primaryError) {
    console.error(`[SmartChat ${sessionId}] ❌ ${PRIMARY_MODEL} failed:`, primaryError.message);
    
    // If PRIMARY fails and it's different from FALLBACK, try FALLBACK
    if (PRIMARY_MODEL !== FALLBACK_MODEL) {
      console.log(`[SmartChat ${sessionId}] ⚠️ Falling back to ${FALLBACK_MODEL}...`);
      
      try {
        const fallbackParams = {
          ...params,
          model: FALLBACK_MODEL
        };
        
        // Add temperature only if model supports it
        const temp = getTemperature(FALLBACK_MODEL);
        if (temp !== undefined) {
          fallbackParams.temperature = temp;
        }
        
        const response = await openai.chat.completions.create(fallbackParams);
        const duration = Date.now() - startTime;
        
        console.log(`[SmartChat ${sessionId}] ✅ Fallback to ${FALLBACK_MODEL} succeeded - ${duration}ms`);
        console.log(`[SmartChat ${sessionId}] 🤖 Model: ${FALLBACK_MODEL} (fallback)`);
        
        return {
          response,
          modelUsed: FALLBACK_MODEL,
          fallbackUsed: true,
          primaryError: primaryError.message,
          duration
        };
        
      } catch (fallbackError) {
        console.error(`[SmartChat ${sessionId}] ❌ Fallback ${FALLBACK_MODEL} also failed:`, fallbackError.message);
        throw new Error(`Both ${PRIMARY_MODEL} and ${FALLBACK_MODEL} failed: ${primaryError.message}`);
      }
    }
    
    // If PRIMARY === FALLBACK, just throw the error
    throw primaryError;
  }
}

// Latvian text normalization rules (Whisper error corrections)
// ⚠️ SVARĪGI: Šie labojumi ir TIKAI Whisper transkripcijas kļūdām!
// NEDRĪKST pievienot labojumus, kas maina vārda nozīmi (piem., "aizvest" → "izvest")
// Latviešu prefiksi (aiz-, iz-, at-, pie-, no-) PILNĪGI maina vārda nozīmi!
const LV_FIXES = [
  [/^\s*reit\b/gi, "rīt"],
  [/\breit\b/gi, "rīt"],
  [/\brit\b/gi, "rīt"],
  [/\bpulkstenis\b/gi, "pulksten"],
  [/\btikšanas\b/gi, "tikšanās"],
  [/\btikšanos\b/gi, "tikšanās"],
  [/\bnullei\b/gi, "nullē"],
  [/\bnulli\b/gi, "nulli"],
  [/\bdesmitos\b/gi, "desmitos"],
  [/\bdivpadsmitos\b/gi, "divpadsmitos"],
  // Fix "irbatgadinajums" → "ir atgādinājums" (Whisper merges words)
  [/\birbatgadinajums\b/gi, "ir atgādinājums"],
  [/\birbatgadinajumi\b/gi, "ir atgādinājumi"],
  [/\birbatgadinajuma\b/gi, "ir atgādinājuma"],
  // Fix "Arjāni" → "ar Jāni" (Whisper merges "ar" + name)
  [/\bAr([a-zāčēģīķļņōŗšūž][a-zāčēģīķļņōŗšūž]+)\b/g, (match, name) => {
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    return `ar ${capitalized}`;
  }],
  [/\bAr([A-ZĀČĒĢĪĶĻŅŌŖŠŪŽ][a-zāčēģīķļņōŗšūž]+)\b/g, (match, name) => `ar ${name}`],
  // Fix "grāmatu vedējs" → "grāmatvedis"
  [/\bgrāmatu\s+vedēj(s|a|u|am|iem|us|i|as)?\b/gi, (match, suffix) => {
    const suffixMap = {
      's': 'grāmatvedis', 'a': 'grāmatveža', 'u': 'grāmatvedi',
      'am': 'grāmatvedim', 'iem': 'grāmatvežiem', 'us': 'grāmatvežus',
      'i': 'grāmatveži', 'as': 'grāmatvedes', '': 'grāmatvedi', undefined: 'grāmatvedi'
    };
    return suffixMap[suffix] || 'grāmatvedi';
  }],
  [/\bgrāmatu\s+ved(e|es|ei|i)?\b/gi, (match, suffix) => {
    const suffixMap = {
      'e': 'grāmatvede', 'es': 'grāmatvedes', 'ei': 'grāmatvedei',
      'i': 'grāmatvedi', '': 'grāmatvede', undefined: 'grāmatvede'
    };
    return suffixMap[suffix] || 'grāmatvede';
  }],
  // Fix "vakar diena" → "vakardiena"
  [/\bvakar\s+diena\b/gi, "vakardiena"],
  [/\bpor diena\b/gi, "pordiena"],
  // Fix "pār domu" → "pārdomu"
  [/\bpār\s+domu\b/gi, "pārdomu"],
  [/\bpār\s+domas\b/gi, "pārdomas"]
];

const ET_FIXES = [
  [/^\s*homme\b/gi, "homme"],
  [/\bkell\b/gi, "kell"]
];

/**
 * Apply language-specific normalization to text
 * @param {string} text - Input text
 * @param {string} language - Language code (lv, et, en)
 * @returns {string} Normalized text
 */
function normalizeText(text, language) {
  if (!text) return text;
  
  let normalized = text;
  const fixes = language === 'et' ? ET_FIXES : (language === 'lv' ? LV_FIXES : []);
  
  for (const [pattern, replacement] of fixes) {
    normalized = normalized.replace(pattern, replacement);
  }
  
  // Log if normalization changed the text
  if (normalized !== text) {
    console.log(`[SmartChat] Normalized: "${text}" → "${normalized}"`);
  }
  
  return normalized;
}

/**
 * Process a user message and generate a response
 * @param {object} session - Chat session
 * @param {string} userMessage - User's message
 * @returns {object} Response object
 */
export async function processMessage(session, userMessage) {
  const startTime = Date.now();
  
  try {
    // Apply language-specific normalization (fix Whisper errors)
    const normalizedMessage = normalizeText(userMessage, session.language);
    
    // Add user message to history (normalized)
    addMessage(session.id, 'user', normalizedMessage);
    
    // Build messages array for GPT
    const messages = buildMessages(session, normalizedMessage);
    
    console.log(`[SmartChat ${session.id}] Processing message: "${normalizedMessage.substring(0, 50)}..."`);
    
    // Call GPT with tools (with automatic fallback)
    const { response, modelUsed, fallbackUsed } = await callGPTWithFallback({
      messages,
      tools: SMARTCHAT_TOOLS,
      tool_choice: "auto",
      max_tokens: MAX_TOKENS
    }, session.id);
    
    const choice = response.choices[0];
    const processingTime = Date.now() - startTime;
    
    console.log(`[SmartChat ${session.id}] GPT response in ${processingTime}ms, finish_reason: ${choice.finish_reason}${fallbackUsed ? ' (fallback)' : ''}`);
    
    // Handle tool calls
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      return await handleToolCalls(session, choice.message.tool_calls);
    }
    
    // Regular text response
    const assistantMessage = choice.message.content || "";
    addMessage(session.id, 'assistant', assistantMessage);
    
    return {
      type: "text",
      message: assistantMessage,
      sessionId: session.id,
      processingTime
    };
    
  } catch (error) {
    console.error(`[SmartChat ${session.id}] Error:`, error.message);
    
    // Provide specific error messages based on error type
    let errorMessage;
    if (error.code === 'rate_limit_exceeded' || error.message.includes('rate limit')) {
      errorMessage = session.language === 'lv'
        ? "Pārāk daudz pieprasījumu. Lūdzu, uzgaidiet dažas sekundes."
        : "Too many requests. Please wait a few seconds.";
    } else if (error.message.includes('timeout') || error.code === 'ETIMEDOUT') {
      errorMessage = session.language === 'lv'
        ? "Servera atbilde aizņēma pārāk ilgu laiku. Lūdzu, mēģiniet vēlreiz."
        : "Server response took too long. Please try again.";
    } else if (error.message.includes('network') || error.code === 'ENOTFOUND') {
      errorMessage = session.language === 'lv'
        ? "Tīkla kļūda. Lūdzu, pārbaudiet savienojumu."
        : "Network error. Please check your connection.";
    } else {
      errorMessage = session.language === 'lv' 
        ? "Atvainojiet, radās kļūda. Lūdzu, mēģiniet vēlreiz."
        : "Sorry, an error occurred. Please try again.";
    }
    
    return {
      type: "error",
      message: errorMessage,
      error: error.message,
      sessionId: session.id
    };
  }
}

/**
 * Build messages array for GPT
 * Ensures all tool_calls have corresponding tool responses
 * @param {object} session - Chat session
 * @param {string} userMessage - Current user message
 * @returns {Array} Messages array
 */
function buildMessages(session, userMessage) {
  const systemPrompt = getSystemPrompt(session.context, session.language);
  
  const messages = [
    { role: "system", content: systemPrompt }
  ];
  
  // Sanitize history: ensure all tool_calls have responses
  const historyMessages = sanitizeToolCallHistory(session.messages.slice(-20));
  
  for (const msg of historyMessages) {
    if (msg.role === 'tool') {
      // Tool result message
      messages.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content
      });
    } else if (msg.role === 'assistant' && msg.toolCalls) {
      // Assistant message with tool calls
      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.toolCalls
      });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      // Regular user or assistant message
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  
  return messages;
}

/**
 * Sanitize message history to ensure all tool_calls have corresponding tool responses
 * This prevents the "tool_call_ids did not have response messages" error
 * @param {Array} messages - Array of messages
 * @returns {Array} Sanitized messages
 */
function sanitizeToolCallHistory(messages) {
  // First pass: collect all tool_call_ids that have responses
  const respondedToolCallIds = new Set();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId) {
      respondedToolCallIds.add(msg.toolCallId);
    }
  }
  
  // Second pass: filter out assistant messages with unresponded tool_calls
  const sanitized = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Check if ALL tool_calls have responses
      const allResponded = msg.toolCalls.every(tc => respondedToolCallIds.has(tc.id));
      if (allResponded) {
        sanitized.push(msg);
      } else {
        // Skip this message - it has orphaned tool_calls
        console.log(`[SmartChat] Removing orphaned tool_calls: ${msg.toolCalls.map(tc => tc.id).join(', ')}`);
      }
    } else {
      sanitized.push(msg);
    }
  }
  
  return sanitized;
}

/**
 * Handle tool calls from GPT
 * @param {object} session - Chat session
 * @param {Array} toolCalls - Array of tool calls
 * @returns {object} Response object
 */
async function handleToolCalls(session, toolCalls) {
  // Process first tool call (handle one at a time for clarity)
  const toolCall = toolCalls[0];
  const toolName = toolCall.function.name;
  
  let params;
  try {
    params = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    console.error(`[SmartChat ${session.id}] Failed to parse tool arguments:`, e.message);
    params = {};
  }
  
  console.log(`[SmartChat ${session.id}] Tool call: ${toolName}`, params);
  
  // Duplicate detection for create operations
  if (toolName === 'create_event' || toolName === 'create_reminder') {
    // Get fresh session to ensure we have latest messages
    const freshSession = getSession(session.id) || session;
    const createdItems = countCreatedItems(freshSession.messages);
    const newTitle = params.title?.toLowerCase().trim();
    
    console.log(`[SmartChat ${session.id}] Duplicate check for "${params.title}" - existing titles: [${createdItems.titles.join(', ')}]`);
    
    if (newTitle && createdItems.titles.some(t => t.toLowerCase().trim() === newTitle)) {
      console.log(`[SmartChat ${session.id}] DUPLICATE DETECTED: "${params.title}" already created, skipping`);
      
      // Return a synthetic "already created" response
      const message = session.language === 'lv'
        ? `"${params.title}" jau ir izveidots. Vai ir vēl citi notikumi/uzdevumi?`
        : `"${params.title}" was already created. Are there any other events/tasks?`;
      
      addMessage(session.id, 'assistant', message);
      
      return {
        type: "text",
        message,
        sessionId: session.id,
        duplicateSkipped: true
      };
    }
  }
  
  // Handle ask_clarification specially - return as text
  if (toolName === 'ask_clarification') {
    const clarificationMessage = params.question;
    addMessage(session.id, 'assistant', clarificationMessage);
    
    return {
      type: "text",
      message: clarificationMessage,
      sessionId: session.id,
      isClarification: true
    };
  }
  
  // IMPORTANT: Save the assistant message with tool_calls for GPT context
  // This is needed so GPT can process the tool result correctly
  addMessage(session.id, 'assistant', '', { 
    toolCalls: [{
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(params)
      }
    }]
  });
  
  // Check if confirmation is required
  if (requiresConfirmation(toolName)) {
    const confirmationMessage = getConfirmationMessage(toolName, params, session.language);
    
    // Store pending tool call
    addPendingToolCall(session.id, {
      id: toolCall.id,
      name: toolName,
      parameters: params
    });
    
    return {
      type: "confirmation_needed",
      tool: toolName,
      parameters: params,
      toolCallId: toolCall.id,
      message: confirmationMessage,
      options: session.language === 'lv' 
        ? ["Jā, izpildīt", "Nē, atcelt"]
        : ["Yes, proceed", "No, cancel"],
      sessionId: session.id
    };
  }
  
  // For query tools or non-destructive actions, return tool call for client execution
  return {
    type: "tool_call",
    tool: toolName,
    parameters: params,
    toolCallId: toolCall.id,
    confirmationRequired: false,
    sessionId: session.id
  };
}

/**
 * Process tool result from client
 * @param {object} session - Chat session
 * @param {string} toolCallId - Tool call identifier
 * @param {boolean} success - Whether execution was successful
 * @param {object} result - Execution result
 * @param {string} error - Error message if failed
 * @returns {object} Response object
 */
export async function processToolResult(session, toolCallId, success, result, error = null) {
  const startTime = Date.now();
  
  try {
    // Enhance tool result with context about what was created
    let enhancedResult = result;
    if (success && result) {
      // Add information about previously created items to help GPT track progress
      const createdItems = countCreatedItems(session.messages);
      enhancedResult = {
        ...result,
        _meta: {
          totalEventsCreatedBefore: createdItems.events,
          totalRemindersCreatedBefore: createdItems.reminders,
          previouslyCreatedTitles: createdItems.titles.slice(-5) // Last 5 titles
        }
      };
    }
    
    // Add tool result to history
    const toolResultContent = success 
      ? JSON.stringify(enhancedResult)
      : JSON.stringify({ error: error || "Execution failed" });
    
    console.log(`[SmartChat ${session.id}] Storing tool result: ${toolResultContent.substring(0, 200)}...`);
    addMessage(session.id, 'tool', toolResultContent, { toolCallId });
    
    // Build messages with tool result - properly format for GPT
    const systemPrompt = getSystemPrompt(session.context, session.language);
    const messages = [{ role: "system", content: systemPrompt }];
    
    // Process session messages with proper tool call formatting - use sanitized history
    const sanitizedHistory = sanitizeToolCallHistory(session.messages.slice(-20));
    for (const m of sanitizedHistory) {
      if (m.role === 'tool') {
        // Tool result message
        messages.push({ 
          role: "tool", 
          tool_call_id: m.toolCallId, 
          content: m.content 
        });
      } else if (m.role === 'assistant' && m.toolCalls) {
        // Assistant message with tool calls
        messages.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls
        });
      } else if (m.role === 'user' || m.role === 'assistant') {
        // Regular user or assistant message
        messages.push({ role: m.role, content: m.content });
      }
    }
    
    // Count how many events/reminders have been created in this conversation
    // This helps GPT track progress
    const createdItems = countCreatedItems(session.messages);
    if (createdItems.events > 0 || createdItems.reminders > 0) {
      console.log(`[SmartChat ${session.id}] Progress: ${createdItems.events} events, ${createdItems.reminders} reminders created so far`);
    }
    
    console.log(`[SmartChat ${session.id}] Processing tool result for ${toolCallId}, messages: ${messages.length}`);
    
    // Get GPT response based on tool result - WITH TOOLS enabled so GPT can continue to next task
    const { response, modelUsed, fallbackUsed } = await callGPTWithFallback({
      messages,
      tools: SMARTCHAT_TOOLS,  // Allow GPT to call more tools if needed
      tool_choice: "auto",
      max_tokens: MAX_TOKENS
    }, session.id);
    
    const choice = response.choices[0];
    const processingTime = Date.now() - startTime;
    
    // Check if GPT wants to make another tool call (e.g., for multiple tasks)
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      console.log(`[SmartChat ${session.id}] GPT wants to continue with another tool call`);
      // Get fresh session to ensure we have latest messages for duplicate detection
      const freshSession = getSession(session.id) || session;
      return await handleToolCalls(freshSession, choice.message.tool_calls);
    }
    
    const assistantMessage = choice.message.content || "";
    addMessage(session.id, 'assistant', assistantMessage);
    
    return {
      type: "text",
      message: assistantMessage,
      sessionId: session.id,
      processingTime,
      toolExecuted: true
    };
    
  } catch (err) {
    console.error(`[SmartChat ${session.id}] Error processing tool result:`, err.message);
    console.error(`[SmartChat ${session.id}] Full error:`, err);
    
    // Provide specific error messages
    let errorMessage;
    if (err.message.includes('tool_call_ids')) {
      // OpenAI API error about tool call history
      errorMessage = session.language === 'lv'
        ? "Sesijas kļūda. Lūdzu, sāciet jaunu sarunu."
        : "Session error. Please start a new conversation.";
    } else if (err.code === 'rate_limit_exceeded') {
      errorMessage = session.language === 'lv'
        ? "Pārāk daudz pieprasījumu. Uzgaidiet brīdi."
        : "Too many requests. Please wait a moment.";
    } else {
      errorMessage = session.language === 'lv'
        ? "Atvainojiet, radās kļūda apstrādājot rezultātu."
        : "Sorry, an error occurred while processing the result.";
    }
    
    return {
      type: "error",
      message: errorMessage,
      error: err.message,
      sessionId: session.id
    };
  }
}

// Timeout helper for promises
const withTimeout = (promise, ms, errorMessage) => {
  const timeout = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(errorMessage)), ms)
  );
  return Promise.race([promise, timeout]);
};

// Transcription timeout (30 seconds)
const TRANSCRIPTION_TIMEOUT_MS = 30000;

/**
 * Process audio message (transcribe and then process as text)
 * @param {object} session - Chat session
 * @param {Buffer} audioBuffer - Audio data
 * @param {string} filename - Audio filename
 * @returns {object} Response object
 */
export async function processAudioMessage(session, audioBuffer, filename = "audio.m4a") {
  // Check if OpenAI client is initialized
  if (!openai) {
    throw new Error("OpenAI client not initialized: OPENAI_API_KEY is missing");
  }
  
  const startTime = Date.now();
  
  try {
    // Import toFile helper
    const { toFile } = await import("openai/uploads");
    
    // Transcribe audio with timeout
    const file = await toFile(audioBuffer, filename);
    const transcription = await withTimeout(
      openai.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file
      }),
      TRANSCRIPTION_TIMEOUT_MS,
      "Transcription timeout after 30 seconds"
    );
    
    const transcript = transcription.text?.trim();
    
    if (!transcript || transcript.length < 2) {
      return {
        type: "error",
        message: session.language === 'lv' 
          ? "Neizdevās saprast runu. Lūdzu, mēģiniet vēlreiz."
          : "Could not understand speech. Please try again.",
        sessionId: session.id
      };
    }
    
    const transcriptionTime = Date.now() - startTime;
    console.log(`[SmartChat ${session.id}] Transcribed in ${transcriptionTime}ms: "${transcript.substring(0, 50)}..."`);
    
    // Apply normalization to transcript before processing
    const normalizedTranscript = normalizeText(transcript, session.language);
    
    // Process as text message (which will also normalize, but we want the transcript too)
    const result = await processMessage(session, transcript);
    
    return {
      ...result,
      transcript: normalizedTranscript, // Return normalized transcript to user
      originalTranscript: transcript !== normalizedTranscript ? transcript : undefined,
      transcriptionTime
    };
    
  } catch (error) {
    console.error(`[SmartChat ${session.id}] Audio processing error:`, error.message);
    
    // Provide specific error messages based on error type
    let userMessage;
    if (error.message.includes("timeout")) {
      userMessage = session.language === 'lv'
        ? "Audio apstrāde aizņēma pārāk ilgu laiku. Lūdzu, mēģiniet īsāku ierakstu."
        : "Audio processing took too long. Please try a shorter recording.";
    } else if (error.message.includes("network") || error.message.includes("ENOTFOUND")) {
      userMessage = session.language === 'lv'
        ? "Tīkla kļūda. Lūdzu, pārbaudiet interneta savienojumu."
        : "Network error. Please check your internet connection.";
    } else {
      userMessage = session.language === 'lv'
        ? "Neizdevās apstrādāt audio. Lūdzu, mēģiniet vēlreiz."
        : "Failed to process audio. Please try again.";
    }
    
    return {
      type: "error",
      message: userMessage,
      error: error.message,
      sessionId: session.id
    };
  }
}

/**
 * Count created items in the conversation history
 * Also extracts titles from tool call parameters (not just results)
 * @param {Array} messages - Session messages
 * @returns {object} Count of created events and reminders
 */
function countCreatedItems(messages) {
  let events = 0;
  let reminders = 0;
  const createdTitles = [];
  
  for (const msg of messages) {
    // Check tool results for successful creations
    if (msg.role === 'tool' && msg.content) {
      try {
        const result = JSON.parse(msg.content);
        // Check for eventId or reminderId (successful creation)
        if (result.eventId && result.title) {
          events++;
          if (!createdTitles.includes(result.title)) {
            createdTitles.push(result.title);
          }
          console.log(`[countCreatedItems] Found created event: "${result.title}"`);
        } else if (result.reminderId && result.title) {
          reminders++;
          if (!createdTitles.includes(result.title)) {
            createdTitles.push(result.title);
          }
          console.log(`[countCreatedItems] Found created reminder: "${result.title}"`);
        }
        // Also check for success flag with title
        if (result.success && result.title && !createdTitles.includes(result.title)) {
          createdTitles.push(result.title);
          console.log(`[countCreatedItems] Found successful creation: "${result.title}"`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // Also extract titles from assistant tool_calls that had SUCCESSFUL tool responses
    // This catches cases where the tool result doesn't include the title
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.function?.name === 'create_event' || tc.function?.name === 'create_reminder') {
          try {
            const params = JSON.parse(tc.function.arguments);
            // Find the corresponding tool response
            const toolResponse = messages.find(m => 
              m.role === 'tool' && m.toolCallId === tc.id
            );
            // Only count if tool response exists AND was successful (has eventId/reminderId, no error)
            if (toolResponse && params.title && !createdTitles.includes(params.title)) {
              try {
                const responseContent = JSON.parse(toolResponse.content);
                // Check if this was a successful creation (has ID) or an error
                const isSuccess = (responseContent.eventId || responseContent.reminderId) && !responseContent.error;
                if (isSuccess) {
                  createdTitles.push(params.title);
                  console.log(`[countCreatedItems] Found title from successful tool_call: "${params.title}"`);
                } else if (responseContent.error) {
                  console.log(`[countCreatedItems] Skipping failed tool_call for: "${params.title}" (error: ${responseContent.error})`);
                }
              } catch (e) {
                // Tool response wasn't valid JSON, skip
              }
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
  }
  
  console.log(`[countCreatedItems] Total: ${events} events, ${reminders} reminders, titles: [${createdTitles.join(', ')}]`);
  return { events, reminders, titles: createdTitles };
}

export default {
  processMessage,
  processToolResult,
  processAudioMessage
};

