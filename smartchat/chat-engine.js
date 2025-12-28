/**
 * SmartChat Chat Engine
 * Handles GPT interactions with function calling
 */

import OpenAI from "openai";
import { SMARTCHAT_TOOLS, requiresConfirmation, isQueryTool } from "./tools.js";
import { getSystemPrompt, getConfirmationMessage } from "./prompts.js";
import { addMessage, addPendingToolCall, getSession } from "./session-manager.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Model configuration
const CHAT_MODEL = process.env.SMARTCHAT_MODEL || "gpt-4o";
const MAX_TOKENS = 1000;
const TEMPERATURE = 0.3;

/**
 * Process a user message and generate a response
 * @param {object} session - Chat session
 * @param {string} userMessage - User's message
 * @returns {object} Response object
 */
export async function processMessage(session, userMessage) {
  const startTime = Date.now();
  
  try {
    // Add user message to history
    addMessage(session.id, 'user', userMessage);
    
    // Build messages array for GPT
    const messages = buildMessages(session, userMessage);
    
    console.log(`[SmartChat ${session.id}] Processing message: "${userMessage.substring(0, 50)}..."`);
    
    // Call GPT with tools
    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      tools: SMARTCHAT_TOOLS,
      tool_choice: "auto",
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE
    });
    
    const choice = response.choices[0];
    const processingTime = Date.now() - startTime;
    
    console.log(`[SmartChat ${session.id}] GPT response in ${processingTime}ms, finish_reason: ${choice.finish_reason}`);
    
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
    
    // Return error message
    const errorMessage = session.language === 'lv' 
      ? "Atvainojiet, radās kļūda. Lūdzu, mēģiniet vēlreiz."
      : "Sorry, an error occurred. Please try again.";
    
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
    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      tools: SMARTCHAT_TOOLS,  // Allow GPT to call more tools if needed
      tool_choice: "auto",
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE
    });
    
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
    
    const errorMessage = session.language === 'lv'
      ? "Atvainojiet, radās kļūda apstrādājot rezultātu."
      : "Sorry, an error occurred while processing the result.";
    
    return {
      type: "error",
      message: errorMessage,
      error: err.message,
      sessionId: session.id
    };
  }
}

/**
 * Process audio message (transcribe and then process as text)
 * @param {object} session - Chat session
 * @param {Buffer} audioBuffer - Audio data
 * @param {string} filename - Audio filename
 * @returns {object} Response object
 */
export async function processAudioMessage(session, audioBuffer, filename = "audio.m4a") {
  const startTime = Date.now();
  
  try {
    // Import toFile helper
    const { toFile } = await import("openai/uploads");
    
    // Transcribe audio
    const file = await toFile(audioBuffer, filename);
    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file
    });
    
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
    
    // Process as text message
    const result = await processMessage(session, transcript);
    
    return {
      ...result,
      transcript,
      transcriptionTime
    };
    
  } catch (error) {
    console.error(`[SmartChat ${session.id}] Audio processing error:`, error.message);
    
    return {
      type: "error",
      message: session.language === 'lv'
        ? "Neizdevās apstrādāt audio. Lūdzu, mēģiniet vēlreiz."
        : "Failed to process audio. Please try again.",
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
    
    // Also extract titles from assistant tool_calls that had tool responses
    // This catches cases where the tool result doesn't include the title
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.function?.name === 'create_event' || tc.function?.name === 'create_reminder') {
          try {
            const params = JSON.parse(tc.function.arguments);
            // Only count if we have a corresponding tool response
            const hasResponse = messages.some(m => 
              m.role === 'tool' && m.toolCallId === tc.id
            );
            if (hasResponse && params.title && !createdTitles.includes(params.title)) {
              createdTitles.push(params.title);
              console.log(`[countCreatedItems] Found title from tool_call params: "${params.title}"`);
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

