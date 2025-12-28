/**
 * SmartChat Tools - GPT Function Calling Definitions
 * These tools are executed locally on the iOS device
 */

export const SMARTCHAT_TOOLS = [
  // ===== QUERY TOOLS (Read-only) =====
  {
    type: "function",
    function: {
      name: "query_events",
      description: "Query calendar events for a specific date range. Use this to find events on specific days or search for events by title.",
      parameters: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            description: "Start date in ISO format (YYYY-MM-DD)"
          },
          endDate: {
            type: "string",
            description: "End date in ISO format (YYYY-MM-DD)"
          },
          calendar: {
            type: "string",
            description: "Optional: Filter by calendar name"
          },
          searchText: {
            type: "string",
            description: "Optional: Search text to match in event title or notes"
          }
        },
        required: ["startDate", "endDate"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_reminders",
      description: "Query reminders. Can filter by list, completion status, and due date.",
      parameters: {
        type: "object",
        properties: {
          list: {
            type: "string",
            description: "Optional: Filter by reminder list name"
          },
          showCompleted: {
            type: "boolean",
            description: "Whether to include completed reminders (default: false)"
          },
          dueBefore: {
            type: "string",
            description: "Optional: Only show reminders due before this date (ISO format)"
          },
          dueAfter: {
            type: "string",
            description: "Optional: Only show reminders due after this date (ISO format)"
          },
          searchText: {
            type: "string",
            description: "Optional: Search text to match in reminder title"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_free_time",
      description: "Find available time slots on a specific day. Useful for scheduling new events.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date to check for free time (YYYY-MM-DD)"
          },
          durationMinutes: {
            type: "number",
            description: "Required duration of free slot in minutes"
          },
          startHour: {
            type: "number",
            description: "Start of working hours (0-23, default: 9)"
          },
          endHour: {
            type: "number",
            description: "End of working hours (0-23, default: 18)"
          }
        },
        required: ["date", "durationMinutes"]
      }
    }
  },

  // ===== CALENDAR MODIFICATION TOOLS =====
  {
    type: "function",
    function: {
      name: "create_event",
      description: "Create a new calendar event. Use this when user wants to add a new event.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Event title"
          },
          startDate: {
            type: "string",
            description: "Start date and time in ISO format"
          },
          endDate: {
            type: "string",
            description: "End date and time in ISO format (if not provided, defaults to 1 hour after start)"
          },
          location: {
            type: "string",
            description: "Optional: Event location"
          },
          notes: {
            type: "string",
            description: "Optional: Event notes"
          },
          calendar: {
            type: "string",
            description: "Optional: Calendar to add event to"
          },
          alerts: {
            type: "array",
            items: { type: "number" },
            description: "Optional: Alert times in minutes before event (e.g., [15, 60] for 15min and 1hour before)"
          }
        },
        required: ["title", "startDate"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reschedule_event",
      description: "Reschedule a calendar event to a new time. Use when user wants to move an event.",
      parameters: {
        type: "object",
        properties: {
          eventId: {
            type: "string",
            description: "Event identifier"
          },
          eventTitle: {
            type: "string",
            description: "Event title (for confirmation display)"
          },
          newStart: {
            type: "string",
            description: "New start date and time in ISO format"
          },
          newEnd: {
            type: "string",
            description: "New end date and time in ISO format (optional, maintains duration if not provided)"
          }
        },
        required: ["eventId", "newStart"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_event",
      description: "Update event details (title, location, notes, alerts). Does not change time.",
      parameters: {
        type: "object",
        properties: {
          eventId: {
            type: "string",
            description: "Event identifier"
          },
          title: {
            type: "string",
            description: "New event title"
          },
          location: {
            type: "string",
            description: "New event location"
          },
          notes: {
            type: "string",
            description: "New event notes"
          },
          alerts: {
            type: "array",
            items: { type: "number" },
            description: "New alert times in minutes before event"
          }
        },
        required: ["eventId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_event",
      description: "Delete a calendar event. REQUIRES CONFIRMATION before execution.",
      parameters: {
        type: "object",
        properties: {
          eventId: {
            type: "string",
            description: "Event identifier"
          },
          eventTitle: {
            type: "string",
            description: "Event title (for confirmation display)"
          }
        },
        required: ["eventId"]
      }
    }
  },

  // ===== REMINDER MODIFICATION TOOLS =====
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Create a new reminder.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Reminder title"
          },
          dueDate: {
            type: "string",
            description: "Optional: Due date and time in ISO format"
          },
          list: {
            type: "string",
            description: "Optional: Reminder list name"
          },
          notes: {
            type: "string",
            description: "Optional: Reminder notes"
          },
          priority: {
            type: "number",
            description: "Optional: Priority (1=high, 5=medium, 9=low)"
          }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_reminder",
      description: "Update reminder details (title, due date, list, completion status).",
      parameters: {
        type: "object",
        properties: {
          reminderId: {
            type: "string",
            description: "Reminder identifier"
          },
          title: {
            type: "string",
            description: "New reminder title"
          },
          dueDate: {
            type: "string",
            description: "New due date and time in ISO format"
          },
          list: {
            type: "string",
            description: "New reminder list"
          },
          isCompleted: {
            type: "boolean",
            description: "Mark as completed or not completed"
          },
          notes: {
            type: "string",
            description: "New reminder notes"
          }
        },
        required: ["reminderId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_reminder",
      description: "Mark a reminder as completed.",
      parameters: {
        type: "object",
        properties: {
          reminderId: {
            type: "string",
            description: "Reminder identifier"
          },
          reminderTitle: {
            type: "string",
            description: "Reminder title (for confirmation display)"
          }
        },
        required: ["reminderId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_reminder",
      description: "Delete a reminder. REQUIRES CONFIRMATION before execution.",
      parameters: {
        type: "object",
        properties: {
          reminderId: {
            type: "string",
            description: "Reminder identifier"
          },
          reminderTitle: {
            type: "string",
            description: "Reminder title (for confirmation display)"
          }
        },
        required: ["reminderId"]
      }
    }
  },

  // ===== SHOPPING LIST TOOLS =====
  {
    type: "function",
    function: {
      name: "query_shopping_lists",
      description: "Get all shopping lists with their item counts. Use to see what lists exist.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_shopping_items",
      description: "Get items from a specific shopping list.",
      parameters: {
        type: "object",
        properties: {
          listName: {
            type: "string",
            description: "Name of the shopping list (e.g., 'Rimi', 'Maxima')"
          },
          showCompleted: {
            type: "boolean",
            description: "Whether to include completed/purchased items (default: false)"
          }
        },
        required: ["listName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_shopping_item",
      description: "Add one or more items to a shopping list.",
      parameters: {
        type: "object",
        properties: {
          listName: {
            type: "string",
            description: "Name of the shopping list"
          },
          items: {
            type: "array",
            items: { type: "string" },
            description: "Array of item names to add"
          }
        },
        required: ["listName", "items"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_shopping_item",
      description: "Mark a shopping item as purchased/completed.",
      parameters: {
        type: "object",
        properties: {
          listName: {
            type: "string",
            description: "Name of the shopping list"
          },
          itemName: {
            type: "string",
            description: "Name of the item to mark as purchased"
          }
        },
        required: ["listName", "itemName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "uncheck_shopping_item",
      description: "Mark a shopping item as not purchased (undo check).",
      parameters: {
        type: "object",
        properties: {
          listName: {
            type: "string",
            description: "Name of the shopping list"
          },
          itemName: {
            type: "string",
            description: "Name of the item to uncheck"
          }
        },
        required: ["listName", "itemName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_shopping_item",
      description: "Remove an item from a shopping list.",
      parameters: {
        type: "object",
        properties: {
          listName: {
            type: "string",
            description: "Name of the shopping list"
          },
          itemName: {
            type: "string",
            description: "Name of the item to delete"
          }
        },
        required: ["listName", "itemName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "clear_completed_shopping",
      description: "Remove all completed/purchased items from a shopping list.",
      parameters: {
        type: "object",
        properties: {
          listName: {
            type: "string",
            description: "Name of the shopping list to clear"
          }
        },
        required: ["listName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_shopping_list",
      description: "Create a new shopping list.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name for the new shopping list (e.g., 'Rimi', 'Maxima')"
          }
        },
        required: ["name"]
      }
    }
  },

  // ===== CLARIFICATION TOOL =====
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description: "Ask the user for clarification when the request is ambiguous or multiple items match.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The clarification question to ask"
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional: List of options for the user to choose from"
          },
          context: {
            type: "string",
            description: "Additional context about why clarification is needed"
          }
        },
        required: ["question"]
      }
    }
  }
];

/**
 * Tools that require user confirmation before execution
 * Note: reschedule_event removed - GPT naturally asks for confirmation in conversation
 */
export const CONFIRMATION_REQUIRED_TOOLS = [
  "delete_event",
  "delete_reminder"
];

/**
 * Tools that only query data (read-only)
 */
export const QUERY_ONLY_TOOLS = [
  "query_events",
  "query_reminders",
  "find_free_time",
  "query_shopping_lists",
  "query_shopping_items",
  "ask_clarification"
];

/**
 * Check if a tool requires confirmation
 * @param {string} toolName - Name of the tool
 * @returns {boolean}
 */
export function requiresConfirmation(toolName) {
  return CONFIRMATION_REQUIRED_TOOLS.includes(toolName);
}

/**
 * Check if a tool is query-only (read-only)
 * @param {string} toolName - Name of the tool
 * @returns {boolean}
 */
export function isQueryTool(toolName) {
  return QUERY_ONLY_TOOLS.includes(toolName);
}

export default {
  SMARTCHAT_TOOLS,
  CONFIRMATION_REQUIRED_TOOLS,
  QUERY_ONLY_TOOLS,
  requiresConfirmation,
  isQueryTool
};

