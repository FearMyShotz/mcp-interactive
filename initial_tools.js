// Initial tools configuration for MCP server
export const initialTools = [
  {
    name: "ask_user",
    description: "Prompts the user with a question via a pop-up command prompt and awaits their interactive response.",
    inputSchema: {
      type: "object",
      properties: {
        projectName: {
          type: "string",
          description: "Identifies the context/project making the request"
        },
        message: {
          type: "string",
          description: "The specific question for the user. Supports Markdown formatting."
        },
        predefinedOptions: {
          type: "array",
          items: {
            type: "string"
          },
          description: "Predefined options for the user to choose from (optional)"
        }
      },
      required: ["projectName", "message"]
    }
  },
  {
    name: "request_user_confirmation",
    description: "Requests final confirmation or feedback from the user about a work summary. No timeout and no predefined options.",
    inputSchema: {
      type: "object",
      properties: {
        projectName: {
          type: "string",
          description: "Identifies the context/project making the request"
        },
        summary: {
          type: "string",
          description: "Summary of the work completed to present to the user. Supports Markdown formatting."
        }
      },
      required: ["projectName", "summary"]
    }
  }
];