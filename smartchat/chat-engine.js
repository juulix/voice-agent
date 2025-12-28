/**
 * SmartChat Chat Engine
 * Handles GPT interactions with function calling
 */

import OpenAI from "openai";
import { SMARTCHAT_TOOLS, requiresConfirmation, isQueryTool } from "./tools.js";
import { getSystemPrompt, getConfirmationMessage } from "./prompts.js";
import { addMessage, addPendingToolCall } from "./session-manager.js";

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
 * @param {object} session - Chat session
 * @param {string} userMessage - Current user message
 * @returns {Array} Messages array
 */
function buildMessages(session, userMessage) {
  const systemPrompt = getSystemPrompt(session.context, session.language);
  
  const messages = [
    { role: "system", content: systemPrompt }
  ];
  
  // Add conversation history (last 20 messages)
  const historyMessages = session.messages.slice(-20);
  for (const msg of historyMessages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (msg.role === 'tool') {
      // Include tool results
      messages.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content
      });
    }
  }
  
  return messages;
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
    // Add tool result to history
    const toolResultContent = success 
      ? JSON.stringify(result)
      : JSON.stringify({ error: error || "Execution failed" });
    
    addMessage(session.id, 'tool', toolResultContent, { toolCallId });
    
    // Build messages with tool result - properly format for GPT
    const systemPrompt = getSystemPrompt(session.context, session.language);
    const messages = [{ role: "system", content: systemPrompt }];
    
    // Process session messages with proper tool call formatting
    for (const m of session.messages.slice(-20)) {
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
    
    console.log(`[SmartChat ${session.id}] Processing tool result for ${toolCallId}, messages: ${messages.length}`);
    
    // Get GPT response based on tool result
    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE
    });
    
    const assistantMessage = response.choices[0].message.content || "";
    addMessage(session.id, 'assistant', assistantMessage);
    
    const processingTime = Date.now() - startTime;
    
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

export default {
  processMessage,
  processToolResult,
  processAudioMessage
};

