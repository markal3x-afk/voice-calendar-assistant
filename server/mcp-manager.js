import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";

class MCPManager {
  constructor() {
    this.clients = new Map(); // serverName -> Client
    this.toolsMap = new Map(); // toolName -> serverName
    this.rawTools = []; // Full list of MCP tools
  }

  /**
   * Initializes the MCP servers configured in mcp_config.json
   */
  async init() {
    const configPath = path.resolve(process.cwd(), "mcp_config.json");
    if (!fs.existsSync(configPath)) {
      console.warn("mcp_config.json not found. No MCP servers will be loaded.");
      return [];
    }

    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      console.error("Failed to parse mcp_config.json:", err);
      return [];
    }

    const servers = config.mcpServers || {};
    const initPromises = [];

    for (const [name, serverConfig] of Object.entries(servers)) {
      if (serverConfig.enabled === false) {
        console.log(`MCP Server [${name}] is disabled in config.`);
        continue;
      }

      initPromises.push(this.connectServer(name, serverConfig));
    }

    await Promise.all(initPromises);
    console.log(`Successfully connected to ${this.clients.size} MCP servers.`);
    return this.getGeminiTools();
  }

  /**
   * Connects to a single MCP server via stdio transport
   */
  async connectServer(name, config) {
    console.log(`Connecting to MCP Server [${name}] via stdio...`);
    try {
      const env = {
        ...process.env,
        // Make sure credentials pass down to subprocesses
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
        BRAVE_API_KEY: process.env.BRAVE_API_KEY,
      };

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env
      });

      const client = new Client(
        { name: "gemini-live-gateway", version: "1.0.0" },
        { capabilities: {} }
      );

      await client.connect(transport);
      this.clients.set(name, client);

      // Handle stderr from the subprocess to print login instructions (especially Google OAuth)
      transport.stderr?.pipe(process.stderr);

      // Fetch tools from the connected server
      const response = await client.listTools();
      const tools = response.tools || [];
      console.log(`Loaded ${tools.length} tools from MCP Server [${name}].`);

      for (const tool of tools) {
        this.toolsMap.set(tool.name, name);
        this.rawTools.push(tool);
      }
    } catch (err) {
      console.error(`Failed to connect to MCP Server [${name}]:`, err);
    }
  }

  /**
   * Converts loaded MCP tools into Gemini API function declarations,
   * filtering for only Calendar and Gmail tools, and appending local memory tools.
   */
  getGeminiTools() {
    // 1. Filter Workspace MCP tools to Calendar and Gmail to reduce Gemini's overhead
    const allowedTools = [
      "list_events",
      "create_event",
      "get_event",
      "update_event",
      "delete_event",
      "list_calendars",
      "find_free_time",
      "get_current_time",
      "create_draft",
      "send_draft",
      "create_draft_reply",
      "list_drafts",
      "send_message",
      "list_messages",
      "get_message"
    ];
    const filteredTools = this.rawTools
      .filter(tool => allowedTools.includes(tool.name))
      .map(tool => {
        return {
          name: tool.name,
          description: tool.description || "",
          parameters: this.normalizeSchema(tool.inputSchema)
        };
      });

    // 2. Append local memory tools for reading/writing preferences.md
    filteredTools.push({
      name: "read_preferences",
      description: "Read the user's saved calendar and scheduling preferences.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: []
      }
    });

    filteredTools.push({
      name: "save_preferences",
      description: "Save the updated calendar and scheduling preferences markdown file.",
      parameters: {
        type: "OBJECT",
        properties: {
          content: {
            type: "STRING",
            description: "The complete updated markdown text containing the list of preferences."
          }
        },
        required: ["content"]
      }
    });

    return filteredTools;
  }

  /**
   * Helper to normalize JSON Schema types to UPPERCASE for Gemini API compliance
   */
  normalizeSchema(schema) {
    if (!schema) return undefined;
    const normalized = { ...schema };
    
    if (typeof normalized.type === "string") {
      normalized.type = normalized.type.toUpperCase();
    }
    
    // Gemini API validator requires the 'items' field to be defined for type ARRAY
    if (normalized.type === "ARRAY" && !normalized.items) {
      normalized.items = { type: "STRING" };
    }

    if (normalized.properties) {
      const newProps = {};
      for (const [key, prop] of Object.entries(normalized.properties)) {
        newProps[key] = this.normalizeSchema(prop);
      }
      normalized.properties = newProps;
    }
    
    if (normalized.items) {
      normalized.items = this.normalizeSchema(normalized.items);
    }
    
    return normalized;
  }

  /**
   * Calls a tool by name on the correct MCP server
   */
  async executeTool(name, args) {
    // Intercept local memory tools
    if (name === "read_preferences") {
      console.log("Executing local tool: read_preferences");
      const prefPath = path.resolve(process.cwd(), "server", "data", "preferences.md");
      if (fs.existsSync(prefPath)) {
        const content = fs.readFileSync(prefPath, "utf-8");
        return { content };
      }
      return { content: "" };
    }

    if (name === "save_preferences") {
      console.log("Executing local tool: save_preferences");
      const { content } = args;
      const prefPath = path.resolve(process.cwd(), "server", "data", "preferences.md");
      fs.mkdirSync(path.dirname(prefPath), { recursive: true });
      fs.writeFileSync(prefPath, content, "utf-8");
      return { success: true, message: "Preferences updated successfully." };
    }

    // Intercept list_events to fetch events from ALL calendars in parallel
    if (name === "list_events") {
      // Normalize timezone parameters to America/Los_Angeles (-07:00) to prevent date shifts
      if (args.timeMin && args.timeMin.endsWith("Z")) {
        args.timeMin = args.timeMin.replace("Z", "-07:00");
      }
      if (args.timeMax && args.timeMax.endsWith("Z")) {
        args.timeMax = args.timeMax.replace("Z", "-07:00");
      }

      const calendarId = args.calendarId || "primary";
      if (calendarId === "primary") {
        console.log("Intercepting list_events to query ALL calendars in parallel...");
        try {
          const workspaceClient = this.clients.get("google-workspace");
          if (!workspaceClient) {
            throw new Error("Workspace client not connected");
          }

          // 1. Fetch the list of calendars
          const calendarsRes = await workspaceClient.callTool({
            name: "list_calendars",
            arguments: {}
          });

          let calendars = [];
          if (calendarsRes.structuredContent && Array.isArray(calendarsRes.structuredContent.calendars)) {
            calendars = calendarsRes.structuredContent.calendars;
          } else if (calendarsRes.content && calendarsRes.content[0] && calendarsRes.content[0].text) {
            try {
              const text = calendarsRes.content[0].text;
              const jsonStr = text.substring(text.indexOf('{'));
              const parsed = JSON.parse(jsonStr);
              calendars = parsed.calendars || [];
            } catch (e) {
              console.warn("Failed to parse list_calendars text fallback:", e);
            }
          }

          if (calendars.length === 0) {
            console.log("No calendars found, falling back to standard list_events");
            // Proceed to standard execution
          } else {
            // 2. Fetch events for all calendars in parallel
            const fetchPromises = calendars.map(async (cal) => {
              try {
                const calArgs = { ...args, calendarId: cal.id };
                const res = await workspaceClient.callTool({
                  name: "list_events",
                  arguments: calArgs
                });
                
                let events = [];
                if (res.structuredContent && Array.isArray(res.structuredContent.events)) {
                  events = res.structuredContent.events;
                } else if (res.content && res.content[0] && res.content[0].text) {
                  try {
                    const text = res.content[0].text;
                    const jsonStr = text.substring(text.indexOf('{'));
                    const parsed = JSON.parse(jsonStr);
                    events = parsed.events || [];
                  } catch (e) {
                    console.warn(`Failed to parse events text fallback for ${cal.summary}:`, e);
                  }
                }

                // Annotate events with calendar summary
                return events.map(evt => ({
                  ...evt,
                  calendarName: cal.summary,
                  calendarId: cal.id
                }));
              } catch (err) {
                console.error(`Failed to list events for calendar ${cal.summary} (${cal.id}):`, err);
                return [];
              }
            });

            const resultsArray = await Promise.all(fetchPromises);
            const allEvents = resultsArray.flat();

            // Sort chronologically
            allEvents.sort((a, b) => {
              const startA = a.start?.dateTime || a.start?.date || "";
              const startB = b.start?.dateTime || b.start?.date || "";
              return startA.localeCompare(startB);
            });

            // Format response content
            const textEvents = allEvents.map(evt => {
              const time = evt.start?.dateTime || evt.start?.date || "No Time";
              return `- [${evt.calendarName}] ${evt.summary} (Start: ${time}, ID: ${evt.id})`;
            }).join("\n");

            const responseText = `Found ${allEvents.length} event(s) across all calendars:\n\n${textEvents || "No events found."}`;

            return {
              content: [
                {
                  type: "text",
                  text: responseText
                }
              ],
              structuredContent: {
                events: allEvents
              }
            };
          }
        } catch (err) {
          console.error("Failed parallel calendar retrieval interceptor:", err);
          // Proceed to standard fallback below
        }
      }
    }

    const serverName = this.toolsMap.get(name);
    if (!serverName) {
      throw new Error(`Tool [${name}] not found in any registered MCP server.`);
    }

    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP Client for server [${serverName}] is not connected.`);
    }

    console.log(`Forwarding tool call [${name}] to MCP Server [${serverName}] with args:`, args);
    const result = await client.callTool({
      name,
      arguments: args
    });

    return result;
  }

  /**
   * Gracefully shuts down all active MCP connections
   */
  async shutdown() {
    console.log("Shutting down MCP servers...");
    for (const [name, client] of this.clients.entries()) {
      try {
        await client.close();
        console.log(`Disconnected from MCP Server [${name}].`);
      } catch (err) {
        console.error(`Error closing MCP Client [${name}]:`, err);
      }
    }
    this.clients.clear();
    this.toolsMap.clear();
    this.rawTools = [];
  }
}

export default new MCPManager();
