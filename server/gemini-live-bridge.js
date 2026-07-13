import WebSocket from "ws";
import fs from "fs";
import path from "path";
import mcpManager from "./mcp-manager.js";
import db from "./utils/db.js";
import { getActiveAccessToken, GoogleCalendarClient } from "./utils/google-client.js";
import { executeUserTool } from "./utils/tool-runner.js";

// Gemini Live API WSS Endpoint
const GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export async function handleLiveSession(clientWs, request) {
  console.log("Client connected. Parsing user email context...");

  // 1. Resolve email parameter from connection query string or fallback to cookie header
  const urlObj = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  let email = urlObj.searchParams.get("email");

  if (!email && request.headers.cookie) {
    try {
      const cookies = Object.fromEntries(
        request.headers.cookie.split(";").map(c => {
          const parts = c.trim().split("=");
          return [parts[0], decodeURIComponent(parts[1] || "")];
        })
      );
      if (cookies["email"]) {
        email = cookies["email"];
        console.log(`[Session Upgrade] Resolved email context from cookie: ${email}`);
      }
    } catch (err) {
      console.warn("[Session Upgrade] Failed to parse request cookies:", err.message);
    }
  }

  // Fallback for local web dashboard compatibility: load first database user or create developer profile
  if (!email) {
    const usersList = await db.query("SELECT * FROM users LIMIT 1");
    if (usersList.rows.length > 0) {
      email = usersList.rows[0].email;
      console.log(`[Session Fallback] Loaded first database profile: ${email}`);
    } else {
      email = "developer@local.chat";
      await db.query("INSERT INTO users (email) VALUES ($1) ON CONFLICT DO NOTHING", [email]);
      console.log(`[Session Fallback] Seeding default developer profile: ${email}`);
    }
  }

  // 2. Fetch User Row from database
  const userRes = await db.query("SELECT * FROM users WHERE email = $1", [email]);
  if (!userRes.rows || userRes.rows.length === 0) {
    clientWs.close(4001, `User email '${email}' not found. Please link account first.`);
    return;
  }
  const user = userRes.rows[0];

  // 3. Fetch User Google OAuth Credentials
  const credsRes = await db.query("SELECT * FROM google_credentials WHERE user_id = $1", [user.id]);
  let userCreds = credsRes.rows[0];

  // Fallback: If DB credentials missing, look for developer's local workspace MCP tokens to seed database automatically
  if (!userCreds) {
    const tokensFile = "/Users/alexander/.config/google-workspace-mcp/tokens.json";
    if (fs.existsSync(tokensFile)) {
      try {
        console.log(`[Developer Fallback] Found local cached tokens file. Seeding DB for ${email}...`);
        const rawTokens = JSON.parse(fs.readFileSync(tokensFile, "utf-8"));
        
        // Import encryption functions dynamically to prevent loading conflicts
        const { encrypt } = await import("./utils/crypto.js");
        const encAccess = encrypt(rawTokens.access_token);
        const encRefresh = encrypt(rawTokens.refresh_token);
        const expiryDate = rawTokens.expiry_date || (Date.now() + 3600 * 1000);
        
        await db.query(
          `INSERT INTO google_credentials (user_id, access_token, refresh_token, expiry_date)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [user.id, encAccess, encRefresh, expiryDate]
        );
        
        const newCreds = await db.query("SELECT * FROM google_credentials WHERE user_id = $1", [user.id]);
        userCreds = newCreds.rows[0];
      } catch (err) {
        console.warn("[Developer Fallback] Could not seed local credentials:", err.message);
      }
    }
  }

  if (!userCreds) {
    console.error(`Missing OAuth credentials for email: ${email}`);
    clientWs.close(4002, `No Google credentials linked for email '${email}'. Please login first.`);
    return;
  }

  // 4. Secure active decrypted access token (performing automated refreshes if expired)
  let accessToken;
  try {
    const saveCallback = async (updatedFields) => {
      await db.query(
        "UPDATE google_credentials SET access_token = $1, expiry_date = $2 WHERE user_id = $3",
        [updatedFields.access_token, updatedFields.expiry_date, user.id]
      );
      console.log(`[Database] Updated refreshed access tokens for user_id: ${user.id}`);
    };
    accessToken = await getActiveAccessToken(userCreds, saveCallback);
  } catch (err) {
    console.error("Failed to secure active access token:", err);
    clientWs.close(4003, "Google credentials token refresh failed.");
    return;
  }

  // Initialize direct REST client for Google APIs
  const googleClient = new GoogleCalendarClient(accessToken);

  // 5. Load User Preferences / Memory from DB-linked markdown file
  const prefPath = path.resolve(`server/data/preferences_${user.id}.md`);
  let userPrefs = "";
  try {
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    if (fs.existsSync(prefPath)) {
      userPrefs = fs.readFileSync(prefPath, "utf-8");
    } else {
      userPrefs = `# User Preferences\n* I prefer 25-minute sync meetings.\n* Do not book meetings on Friday afternoons.\n`;
      fs.writeFileSync(prefPath, userPrefs, "utf-8");
    }
  } catch (err) {
    console.error(`Failed to read preferences for user_id: ${user.id}`, err);
  }

  // 6. Generate current date-time context (America/Los_Angeles)
  const now = new Date();
  const timeContext = `Current Time Context:
- Today is: ${now.toLocaleDateString("en-US", { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' })}
- Current Local Time: ${now.toLocaleTimeString("en-US", { timeZone: 'America/Los_Angeles' })} (America/Los_Angeles)
Use this reference to resolve relative dates (like "tomorrow", "next Thursday", or "July 23rd") when making calendar queries.
When calling calendar tools, you MUST format all ISO 8601 timestamps (such as timeMin/timeMax) in the America/Los_Angeles timezone using the -07:00 offset (e.g. 2026-07-23T00:00:00-07:00). Do NOT use UTC ('Z' suffix), otherwise queries will be shifted by 7 hours.`;

  // 7. Define System Instructions
  const systemInstruction = `You are a helpful, general-purpose voice-enabled AI assistant.
You speak naturally, concisely, and with a friendly tone, optimized for real-time fluid voice conversations.

${timeContext}

You have access to a set of Google Calendar and memory tools.
Always prefer running tools to answer calendar requests or search questions.

Here are the user's saved preferences and memories. You MUST follow them at all times:
${userPrefs}

If the user states a new preference or asks you to forget/change a rule, you MUST use the tool "save_preferences" to save the updated preferences content. First, query "read_preferences" to get the current preferences, make your changes, and call save_preferences.
Always confirm to the user when you have successfully scheduled an event or updated a memory.

When you decide to call a tool (like list_events, create_event, list_calendars, etc.), you MUST first output a brief verbal transition statement to the user to let them know you are looking it up (e.g., "Let me check that for you...", "Sure thing, let me check your calendar...", or "Give me a second to search that..."). Keep it extremely short, friendly, and natural, then execute the tool.
`;

  // 8. Connect to Gemini Live
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error("GEMINI_API_KEY is not defined in the environment.");
    clientWs.close(1011, "GEMINI_API_KEY is missing.");
    return;
  }
  const url = `${GEMINI_LIVE_URL}?key=${geminiApiKey}`;
  const geminiWs = new WebSocket(url);

  // Fetch the list of function definitions from MCP Manager
  let mcpTools = [];
  try {
    mcpTools = mcpManager.getGeminiTools();
  } catch (err) {
    console.error("Failed to load schemas from MCP Manager:", err);
  }

  geminiWs.on("open", () => {
    console.log(`Connected to Gemini Multimodal Live API on behalf of: ${email}`);

    // Compile tool schemas (incorporating Google Search grounding)
    const tools = [];
    if (mcpTools.length > 0) {
      tools.push({ functionDeclarations: mcpTools });
    }
    tools.push({ googleSearch: {} });

    const setupMessage = {
      setup: {
        model: "models/gemini-2.0-flash-exp",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Puck"
              }
            }
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        tools
      }
    };

    geminiWs.send(JSON.stringify(setupMessage));
    console.log("Session setup message sent to Gemini Live.");
  });

  geminiWs.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Check if Gemini is requesting a Tool Call
      if (message.toolCall) {
        // Forward the toolCall to client so it can display running status
        try {
          clientWs.send(JSON.stringify(message));
        } catch (e) {
          console.error("Failed to forward toolCall to client:", e);
        }

        const functionCalls = message.toolCall.functionCalls || [];
        const responses = [];

        for (const call of functionCalls) {
          const { id, name, args } = call;
          try {
            // Execute the tool call via our user-specific Tool Runner
            const result = await executeUserTool(name, args, googleClient, user.id);
            responses.push({
              id,
              name,
              response: { result }
            });
          } catch (err) {
            console.error(`Error executing user tool [${name}]:`, err);
            responses.push({
              id,
              name,
              response: { error: err.message || "Failed to execute tool" }
            });
          }
        }

        // Send the toolResponse back to Gemini Live
        if (responses.length > 0) {
          const toolResponse = {
            toolResponse: {
              functionResponses: responses
            }
          };
          geminiWs.send(JSON.stringify(toolResponse));
          console.log("Sent toolResponse back to Gemini Live.");

          // Forward the toolResponse payload to the client so it can parse returned events
          try {
            clientWs.send(JSON.stringify(toolResponse));
          } catch (e) {
            console.error("Failed to forward toolResponse to client:", e);
          }
        }
      } 
      // Forward general stream content (audio base64, text, status updates) to client
      else {
        clientWs.send(JSON.stringify(message));
      }
    } catch (err) {
      console.error("Error processing message from Gemini:", err);
    }
  });

  geminiWs.on("close", (code, reason) => {
    console.log(`Gemini Live connection closed. Code: ${code}, Reason: ${reason}`);
    clientWs.close(1000, "Gemini session closed.");
  });

  geminiWs.on("error", (err) => {
    console.error("Gemini Live WebSocket error:", err);
    clientWs.send(JSON.stringify({ error: "Gemini WebSocket error." }));
  });

  // Listen to messages from the iOS client
  clientWs.on("message", (data) => {
    if (geminiWs.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const clientMsg = JSON.parse(data.toString());

      if (clientMsg.type === "audio" && clientMsg.data) {
        const inputFrame = {
          realtimeInput: {
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: clientMsg.data
            }
          }
        };
        geminiWs.send(JSON.stringify(inputFrame));
      } 
      else if (clientMsg.type === "text" && clientMsg.text) {
        const textFrame = {
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  { text: clientMsg.text }
                ]
              }
            ],
            turnComplete: true
          }
        };
        geminiWs.send(JSON.stringify(textFrame));
      }
    } catch (err) {
      console.error("Error parsing message from client:", err);
    }
  });

  clientWs.on("close", () => {
    console.log(`Client disconnected. Closing Gemini session for ${email}...`);
    geminiWs.close();
  });

  clientWs.on("error", (err) => {
    console.error("Client WebSocket error:", err);
    geminiWs.close();
  });
}
