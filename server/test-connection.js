import WebSocket from "ws";
import mcpManager from "./mcp-manager.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

async function runTests() {
  console.log("🚀 Starting Assistant Integration Tests...\n");

  // 1. Verify environment config
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ FAILURE: GEMINI_API_KEY environment variable is missing.");
    process.exit(1);
  }
  console.log("✅ Env Check: GEMINI_API_KEY is defined.");

  // 2. Initialize MCP Manager
  console.log("\n📦 Initializing MCP Manager...");
  try {
    await mcpManager.init();
    console.log("✅ MCP Manager: initialized.");
  } catch (err) {
    console.error("❌ FAILURE: Failed to initialize MCP Manager:", err);
    process.exit(1);
  }

  // 3. Verify tool loading and filtering
  const tools = mcpManager.getGeminiTools();
  console.log(`\n🛠️  Tool Validation: Loaded and filtered ${tools.length} tools.`);
  
  const hasCalendar = tools.some(t => t.name === "list_events");
  const hasGmail = tools.some(t => t.name === "send_message");
  const hasMemoryRead = tools.some(t => t.name === "read_preferences");
  const hasMemorySave = tools.some(t => t.name === "save_preferences");

  if (!hasCalendar || !hasMemoryRead || !hasMemorySave) {
    console.error("❌ FAILURE: Whitelisted tools are missing. Check mcp-manager.js filtering.");
    console.error(`Found tools: ${tools.map(t => t.name).join(", ")}`);
    await mcpManager.shutdown();
    process.exit(1);
  }
  console.log("✅ Tool Check: Calendar and Memory tools are registered successfully.");

  // 4. Test WebSocket connection to Gemini Live
  console.log("\n🌐 Connecting to Gemini Live WebSocket API...");
  const wsUrl = `${GEMINI_LIVE_URL}?key=${apiKey}`;
  const ws = new WebSocket(wsUrl);

  let testPassed = false;
  let connectionClosed = false;

  const testTimeout = setTimeout(() => {
    if (!connectionClosed) {
      console.log("\n✅ Integration Check: Connection stayed active for 5 seconds without errors.");
      testPassed = true;
      ws.close();
    }
  }, 5000);

  ws.on("open", () => {
    console.log("✅ WebSocket Check: Connection opened successfully.");

    // Formulate the exact setup payload we use in production
    const setupMessage = {
      setup: {
        model: "models/gemini-3.1-flash-live",
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
          parts: [{ text: "You are a test assistant." }]
        },
        tools: tools.length > 0 ? [{ functionDeclarations: tools }] : []
      }
    };

    console.log("📤 Sending setup payload to Gemini Live...");
    ws.send(JSON.stringify(setupMessage));
  });

  ws.on("message", (data) => {
    const response = JSON.parse(data.toString());
    if (response.setupComplete) {
      console.log("✅ Handshake Check: Gemini returned setupComplete!");
    }
  });

  ws.on("close", (code, reason) => {
    connectionClosed = true;
    clearTimeout(testTimeout);
    
    if (testPassed) {
      console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY! No schema or WebSocket regressions found.");
      mcpManager.shutdown().then(() => process.exit(0));
    } else {
      console.error(`\n❌ FAILURE: Gemini closed connection prematurely. Code: ${code}, Reason: ${reason}`);
      mcpManager.shutdown().then(() => process.exit(1));
    }
  });

  ws.on("error", (err) => {
    clearTimeout(testTimeout);
    console.error("❌ FAILURE: WebSocket error received:", err);
    mcpManager.shutdown().then(() => process.exit(1));
  });
}

runTests().catch(async (err) => {
  console.error("❌ Test runner encountered unhandled error:", err);
  await mcpManager.shutdown();
  process.exit(1);
});
