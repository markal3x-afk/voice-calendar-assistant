import express from "express";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { WebSocketServer } from "ws";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import mcpManager from "./mcp-manager.js";
import { handleLiveSession } from "./gemini-live-bridge.js";
import authRouter from "./routes/auth.js";

// Load environment variables from .env
dotenv.config();

const PORT = process.env.PORT || 3000;
const app = express();
app.set("trust proxy", true); // Trust DigitalOcean's load balancer to resolve req.protocol to https

// Select HTTP or HTTPS based on local self-signed dev certificates
const keyPath = path.resolve(process.cwd(), "server.key");
const certPath = path.resolve(process.cwd(), "server.cert");
const isHttps = fs.existsSync(keyPath) && fs.existsSync(certPath);

const httpServer = isHttps 
  ? createHttpsServer({
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    }, app)
  : createHttpServer(app);

// Initialize a single WebSocket Server bound to our HTTP server
const wss = new WebSocketServer({ noServer: true });

// Serve frontend static files from Client build directory in production
const clientDistPath = path.resolve(process.cwd(), "client", "dist");
app.use(express.static(clientDistPath));

// Mount Google OAuth endpoints
app.use("/api/auth", authRouter);

// Endpoint to retrieve preferences.md contents for the UI
app.get("/api/preferences", (req, res) => {
  const prefPath = path.resolve(process.cwd(), "server", "data", "preferences.md");
  if (fs.existsSync(prefPath)) {
    const content = fs.readFileSync(prefPath, "utf-8");
    res.json({ content });
  } else {
    res.json({ content: "" });
  }
});

// Fallback to index.html for React SPA routing
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }
  res.sendFile(path.join(clientDistPath, "index.html"));
});

// Handle upgrade from HTTP to WebSocket protocol
httpServer.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === "/api/live-session") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Handle WebSocket connections
wss.on("connection", (ws, request) => {
  console.log("WebSocket client connection received.");
  handleLiveSession(ws, request).catch((err) => {
    console.error("Error handling live session:", err);
    ws.close(1011, "Internal server error.");
  });
});

// Bootstrap the gateway
async function bootstrap() {
  console.log("Bootstrapping Gemini-MCP Voice Assistant Gateway...");
  
  if (process.env.DATABASE_URL) {
    try {
      // Parse URL to check hostname (avoid logging sensitive credentials)
      const dbUrl = new URL(process.env.DATABASE_URL);
      console.log(`[Database Config] Target PostgreSQL Host: ${dbUrl.hostname}`);
    } catch (err) {
      console.warn(`[Database Config] Failed to parse DATABASE_URL variable.`);
    }
  } else {
    console.warn(`[Database Config] DATABASE_URL is not defined.`);
  }

  try {
    // 1. Initialize MCP Manager (Spawns Google Workspace, Search subprocesses)
    await mcpManager.init();

    // 2. Start HTTP/HTTPS Server
    httpServer.listen(PORT, () => {
      const protocol = isHttps ? "https" : "http";
      const wsProto = isHttps ? "wss" : "ws";
      console.log(`=================================================`);
      console.log(`Voice Assistant Gateway running on secure ${protocol.toUpperCase()}: ${protocol}://localhost:${PORT}`);
      console.log(`WebSocket Endpoint: ${wsProto}://localhost:${PORT}/api/live-session`);
      console.log(`=================================================`);
    });
  } catch (err) {
    console.error("Fatal: Failed to bootstrap gateway:", err);
    process.exit(1);
  }
}

// Handle graceful shutdown of subprocesses
async function handleGracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
  
  // Close HTTP Server first to stop accepting new requests
  httpServer.close(() => {
    console.log("HTTP server closed.");
  });

  // Shut down all active WebSocket connections
  wss.clients.forEach((client) => {
    client.close(1001, "Server shutting down.");
  });

  // Clean up and kill all spawned MCP subprocesses
  await mcpManager.shutdown();

  console.log("Shutdown complete. Exiting.");
  process.exit(0);
}

process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));

bootstrap();
