import React, { useState, useEffect, useRef } from "react";
import { AudioManager } from "./audio-manager";

interface CalendarEventData {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  htmlLink?: string;
  location?: string;
}

interface Message {
  id: string;
  sender: "user" | "model" | "system" | "widget";
  text: string;
  timestamp: Date;
  isToolCall?: boolean;
  widgetType?: "event-list" | "event-detail";
  eventsData?: CalendarEventData[];
}

const formatEventTime = (timeObj: any, isEnd: boolean = false) => {
  if (!timeObj) return "";
  const rawVal = timeObj.dateTime || timeObj.date;
  if (!rawVal) return "";
  
  const date = new Date(rawVal);
  if (isNaN(date.getTime())) return "";
  
  if (timeObj.date) {
    if (isEnd) return "";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", weekday: "short" }) + " (All day)";
  }
  
  if (isEnd) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  
  const datePart = date.toLocaleDateString(undefined, { month: "short", day: "numeric", weekday: "short" });
  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart} • ${timePart}`;
};

interface LogEntry {
  id: string;
  sender: "user" | "model" | "system";
  text: string;
  timestamp: Date;
}

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Disconnected");
  const [messages, setMessages] = useState<Message[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [preferences, setPreferences] = useState<string[]>([]);
  const [textInput, setTextInput] = useState("");
  const [showConsole, setShowConsole] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [mutePlayback, setMutePlayback] = useState(false);
  const [isGoogleLinked, setIsGoogleLinked] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioManagerRef = useRef<AudioManager | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const consoleEndRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Speakers / Mic states for visualizer animation
  const [isModelSpeaking, setIsModelSpeakingState] = useState(false);
  const isModelSpeakingRef = useRef(false);
  const setIsModelSpeaking = (val: boolean) => {
    isModelSpeakingRef.current = val;
    setIsModelSpeakingState(val);
  };
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const speakingTimeoutRef = useRef<any>(null);

  // Visual widgets queue to buffer event cards while the assistant is speaking
  const pendingWidgetsRef = useRef<any[]>([]);

  // Fetch preferences.md file content
  const fetchPreferences = async () => {
    try {
      const res = await fetch("/api/preferences");
      const data = await res.json();
      if (data.content) {
        // Parse lines starting with * or - as preferences
        const lines = data.content
          .split("\n")
          .map((line: string) => line.trim())
          .filter((line: string) => line.startsWith("*") || line.startsWith("-"))
          .map((line: string) => line.substring(1).trim());
        setPreferences(lines);
      }
    } catch (err) {
      console.error("Failed to fetch preferences:", err);
    }
  };

  // Scroll message thread on update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Scroll developer console logs on update
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const fetchAuthStatus = async () => {
    try {
      const res = await fetch("/api/auth/status");
      const data = await res.json();
      setIsGoogleLinked(!!data.linked);
    } catch (err) {
      console.error("Failed to fetch Google auth status:", err);
    }
  };

  // Initial fetch of preferences and auth status
  useEffect(() => {
    fetchPreferences();
    fetchAuthStatus();
  }, []);

  // Set up visualizer canvas animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;
    let phase = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const width = canvas.width;
      const height = canvas.height;
      const centerY = height / 2;

      if (!isMicActive) {
        // Draw a single thin static horizontal line when the microphone is deactivated
        ctx.beginPath();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(210, 206, 194, 0.4)"; // Soft warm shoji gray
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();
        animationId = requestAnimationFrame(render);
        return;
      }

      phase += 0.05;

      const numWaves = 4;
      for (let w = 0; w < numWaves; w++) {
        ctx.beginPath();
        ctx.lineWidth = w === 0 ? 3 : 1.5;
        
        if (isModelSpeaking) {
          ctx.strokeStyle = `rgba(92, 122, 128, ${0.7 - w * 0.15})`; // Soft Moss Green (Model)
        } else if (isUserSpeaking) {
          ctx.strokeStyle = `rgba(76, 91, 102, ${0.7 - w * 0.15})`; // Calm Slate Indigo (User)
        } else {
          ctx.strokeStyle = `rgba(210, 206, 194, ${0.25 - w * 0.05})`; // Shoji Sand Gray (Idle)
        }

        const amplitude = isModelSpeaking 
          ? 35 + Math.sin(phase * 2) * 10
          : isUserSpeaking 
            ? 45 + Math.sin(phase * 3) * 15
            : 8; 

        const frequency = isModelSpeaking ? 0.015 : isUserSpeaking ? 0.02 : 0.01;

        for (let x = 0; x < width; x++) {
          const y = centerY + Math.sin(x * frequency + phase + w * 0.5) * amplitude * Math.sin((x / width) * Math.PI);
          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      animationId = requestAnimationFrame(render);
    };

    const handleResize = () => {
      canvas.width = canvas.parentElement?.clientWidth || 600;
      canvas.height = 60; // Sleek wave height
    };
    handleResize();
    window.addEventListener("resize", handleResize);

    render();

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", handleResize);
    };
  }, [isModelSpeaking, isUserSpeaking, isMicActive]);

  const addLog = (sender: "user" | "model" | "system", text: string) => {
    setLogs((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substr(2, 9),
        sender,
        text,
        timestamp: new Date()
      }
    ]);
  };

  /**
   * Toggles the WebSocket voice session connection or toggles the mic state if online
   */
  const handleToggleConnection = async () => {
    if (!isConnected) {
      await connect(undefined, true);
    } else {
      // Toggle microphone recording state while keeping WebSocket active
      if (isMicActive) {
        if (audioManagerRef.current) {
          audioManagerRef.current.stopRecording();
        }
        setIsMicActive(false);
        setMutePlayback(true);
        addLog("system", "Microphone deactivated. Verbal response disabled.");
      } else {
        if (audioManagerRef.current) {
          try {
            await audioManagerRef.current.startRecording();
            setIsMicActive(true);
            setMutePlayback(false);
            addLog("system", "Microphone active. Speak now!");
          } catch (err) {
            console.error("Failed to start recording:", err);
            addLog("system", "Microphone access failed.");
          }
        }
      }
    }
  };

  const connect = async (pendingText?: string, startMic: boolean = true) => {
    setIsConnecting(true);
    setStatusMessage("Connecting to Server...");
    addLog("system", startMic ? "Starting Voice Session..." : "Opening text gateway...");
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substr(2, 9),
        sender: "system",
        text: startMic ? "⚡ Initializing voice assistant session..." : "⚡ Connecting text assistant...",
        timestamp: new Date()
      }
    ]);

    try {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const clientTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
      const wsUrl = `${proto}//${window.location.host}/api/live-session?timezone=${encodeURIComponent(clientTimezone)}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const audioManager = new AudioManager((base64Pcm) => {
        if (ws.readyState === WebSocket.OPEN) {
          // Discard microphone data while the model is speaking to prevent local audio output
          // (speaker echo, breathing, or feedback) from triggering false interruptions.
          if (isModelSpeakingRef.current) {
            return;
          }
          ws.send(JSON.stringify({ type: "audio", data: base64Pcm }));
          setIsUserSpeaking(true);

          if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current);
          speakingTimeoutRef.current = setTimeout(() => {
            setIsUserSpeaking(false);
          }, 600);
        }
      });
      audioManagerRef.current = audioManager;

      ws.onopen = async () => {
        console.log("WebSocket connected to gateway.");
        try {
          if (startMic) {
            await audioManager.startRecording();
            setIsMicActive(true);
            setMutePlayback(false);
            addLog("system", "Session established. Speak now!");
            setMessages((prev) => [
              ...prev,
              {
                id: Math.random().toString(36).substr(2, 9),
                sender: "system",
                text: "🎤 Assistant is listening. Speak to chat!",
                timestamp: new Date()
              }
            ]);
          } else {
            setIsMicActive(false);
            setMutePlayback(true);
            addLog("system", "Text session established.");
            setMessages((prev) => [
              ...prev,
              {
                id: Math.random().toString(36).substr(2, 9),
                sender: "system",
                text: "💬 Connected in text mode. Type below!",
                timestamp: new Date()
              }
            ]);
          }
          setIsConnected(true);
          setIsConnecting(false);
          setStatusMessage("Live Connection Active");

          if (pendingText) {
            ws.send(JSON.stringify({ type: "text", text: pendingText }));
          }
        } catch (err) {
          console.error("Microphone capture failed:", err);
          addLog("system", "Mic capture failed. Please check permissions.");
          setMessages((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substr(2, 9),
              sender: "system",
              text: "⚠️ Microphone access was denied. Check permissions.",
              timestamp: new Date()
            }
          ]);
          disconnect();
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        // 1. Handle incoming user transcription (ASR)
        if (msg.serverContent && msg.serverContent.inputTranscription && msg.serverContent.inputTranscription.text) {
          const userText = msg.serverContent.inputTranscription.text;
          setMessages((prev) => {
            // Avoid duplicate text bubbles if user just sent text manually
            const last = prev[prev.length - 1];
            if (last && last.sender === "user" && last.text === userText) {
              return prev;
            }
            return [
              ...prev,
              {
                id: Math.random().toString(36).substr(2, 9),
                sender: "user",
                text: userText,
                timestamp: new Date()
              }
            ];
          });
          addLog("user", `[Voice ASR]: ${userText}`);
        }

        // 2. Handle incoming model turns (audio output and streamed transcription)
        if (msg.serverContent) {
          const modelTurn = msg.serverContent.modelTurn;
          
          if (modelTurn) {
            const parts = modelTurn.parts || [];
            for (const part of parts) {
              if (part.text) {
                // Stream text chunk directly into the model chat bubble
                setMessages((prev) => {
                  const lastMsg = prev[prev.length - 1];
                  if (lastMsg && lastMsg.sender === "model") {
                    return [
                      ...prev.slice(0, -1),
                      { ...lastMsg, text: lastMsg.text + part.text }
                    ];
                  } else {
                    return [
                      ...prev,
                      {
                        id: Math.random().toString(36).substr(2, 9),
                        sender: "model",
                        text: part.text,
                        timestamp: new Date()
                      }
                    ];
                  }
                });
              }

              if (part.inlineData && part.inlineData.data) {
                if (!mutePlayback) {
                  audioManager.playAudioChunk(part.inlineData.data);
                  setIsModelSpeaking(true);
                }
              }
            }
          }

          if (msg.serverContent.turnComplete) {
            setIsModelSpeaking(false);
            // Flush any buffered visual widgets that were loaded while speaking
            if (pendingWidgetsRef.current.length > 0) {
              console.log(`Flushing ${pendingWidgetsRef.current.length} buffered widgets.`);
              setMessages((prev) => [...prev, ...pendingWidgetsRef.current]);
              pendingWidgetsRef.current = [];
            }
          }
          if (msg.serverContent.interrupted) {
            console.log("Model interrupted. Clearing pending widgets.");
            audioManager.clearPlaybackQueue();
            setIsModelSpeaking(false);
            pendingWidgetsRef.current = []; // Clear any buffered widgets on interruption
            addLog("system", "[Interrupted]");
            setMessages((prev) => [
              ...prev,
              {
                id: Math.random().toString(36).substr(2, 9),
                sender: "system",
                text: "⏹️ Assistant speaking interrupted.",
                timestamp: new Date()
              }
            ]);
          }
          
          // 2.5. Handle incoming model transcription (AASR)
          if (msg.serverContent.outputTranscription && msg.serverContent.outputTranscription.text) {
            const modelText = msg.serverContent.outputTranscription.text;
            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1];
              if (lastMsg && lastMsg.sender === "model") {
                return [
                  ...prev.slice(0, -1),
                  { ...lastMsg, text: lastMsg.text + modelText }
                ];
              } else {
                return [
                  ...prev,
                  {
                    id: Math.random().toString(36).substr(2, 9),
                    sender: "model",
                    text: modelText,
                    timestamp: new Date()
                  }
                ];
              }
            });
            addLog("model", `[Model ASR]: ${modelText}`);
          }
        }

        // 3. Handle Tool Calling Status Inline Notifications
        if (msg.toolCall) {
          const calls = msg.toolCall.functionCalls || [];
          calls.forEach((call: any) => {
            let displayIcon = "🔧";
            if (call.name.includes("calendar")) displayIcon = "📅";
            else if (call.name.includes("preferences")) displayIcon = "🧠";
            else if (call.name.includes("search")) displayIcon = "🔍";
            else if (call.name.includes("mail") || call.name.includes("gmail")) displayIcon = "✉️";

            setMessages((prev) => [
              ...prev,
              {
                id: Math.random().toString(36).substr(2, 9),
                sender: "system",
                text: `${displayIcon} Running tool: ${call.name}`,
                timestamp: new Date(),
                isToolCall: true
              }
            ]);
            addLog("system", `Executing MCP Tool [${call.name}] with args: ${JSON.stringify(call.args)}`);
          });

          // Refresh memory files if a preference was updated
          setTimeout(() => {
            fetchPreferences();
          }, 1500);
        }

        // 4. Handle Tool Responses (extract events for visual widgets)
        if (msg.toolResponse) {
          const addWidget = (widget: any) => {
            if (isModelSpeakingRef.current) {
              console.log("Model is speaking. Buffering visual widget:", widget.text);
              pendingWidgetsRef.current.push(widget);
            } else {
              setMessages((prev) => [...prev, widget]);
            }
          };

          const functionResponses = msg.toolResponse.functionResponses || [];
          functionResponses.forEach((funcResp: any) => {
            const name = funcResp.name;
            const responseData = funcResp.response?.result;
            if (!responseData) return;

            if (name === "list_events") {
              const events = Array.isArray(responseData)
                ? responseData
                : (responseData.items || (responseData.result && Array.isArray(responseData.result) ? responseData.result : []));

              if (Array.isArray(events) && events.length > 0) {
                const formattedEvents = events.map((e: any) => ({
                  id: e.id || Math.random().toString(),
                  summary: e.summary || "Untitled Event",
                  start: e.start || {},
                  end: e.end || {},
                  htmlLink: e.htmlLink,
                  location: e.location
                }));

                addWidget({
                  id: Math.random().toString(36).substr(2, 9),
                  sender: "widget",
                  text: `Found ${events.length} calendar events`,
                  timestamp: new Date(),
                  widgetType: "event-list",
                  eventsData: formattedEvents
                });
              }
            } else if (name === "create_event" || name === "quick_add_event" || name === "update_event" || name === "get_event") {
              const event = responseData;
              if (event && (event.summary || event.id)) {
                addWidget({
                  id: Math.random().toString(36).substr(2, 9),
                  sender: "widget",
                  text: name === "create_event" || name === "quick_add_event" ? "Created new event" : "Updated event",
                  timestamp: new Date(),
                  widgetType: "event-detail",
                  eventsData: [{
                    id: event.id || Math.random().toString(),
                    summary: event.summary || "Untitled Event",
                    start: event.start || {},
                    end: event.end || {},
                    htmlLink: event.htmlLink,
                    location: event.location
                  }]
                });
              }
            }
          });
        }
      };

      ws.onclose = (event) => {
        console.log(`WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
        disconnect();
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        disconnect();
      };

    } catch (err) {
      console.error("Failed to connect:", err);
      disconnect();
    }
  };

  const disconnect = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (audioManagerRef.current) {
      audioManagerRef.current.close();
      audioManagerRef.current = null;
    }
    setIsConnected(false);
    setIsConnecting(false);
    setIsModelSpeaking(false);
    setIsUserSpeaking(false);
    setIsMicActive(false);
    setMutePlayback(false);
    setStatusMessage("Disconnected");
    addLog("system", "Voice Session Ended.");
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substr(2, 9),
        sender: "system",
        text: "🔴 Session closed.",
        timestamp: new Date()
      }
    ]);
  };

  /**
   * Sends text input to Gemini
   */
  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;

    const textToSend = textInput;
    setTextInput("");

    // Append user message bubble immediately
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substr(2, 9),
        sender: "user",
        text: textToSend,
        timestamp: new Date()
      }
    ]);

    addLog("user", textToSend);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setMutePlayback(true);
      wsRef.current.send(JSON.stringify({ type: "text", text: textToSend }));
    } else {
      setMutePlayback(true);
      addLog("system", "Auto-connecting session to send message...");
      await connect(textToSend, false);
    }
  };

  const runSelfCheck = async () => {
    setShowMenu(false);
    addLog("system", "Starting integration self-diagnostics check...");
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substr(2, 9),
        sender: "system",
        text: "🔍 Running system integration self-check...",
        timestamp: new Date()
      }
    ]);

    try {
      const res = await fetch("/api/test-diagnostics");
      const report = await res.json();
      
      const lines = [
        `🤖 System Self-Check: ${report.status.toUpperCase()}`,
        `📅 Date: ${new Date(report.timestamp).toLocaleString()}`,
        `🛢️ Database: ${report.database.status === "ok" ? `✅ OK (Latency: ${report.database.latency})` : `❌ FAILED: ${report.database.error}`}`,
        `🔑 Cryptography: ${report.encryption.status === "ok" ? "✅ OK" : `❌ FAILED: ${report.encryption.error}`}`,
        `👤 Accounts Linked: ${report.google_oauth.status === "ok" ? `✅ OK (Users: ${report.google_oauth.registered_users}, Credentials: ${report.google_oauth.linked_credentials})` : `❌ FAILED: ${report.google_oauth.error}`}`,
        `⚡ Gemini API: ${report.gemini_api.status === "ok" ? `✅ OK (Key present)` : `❌ FAILED: ${report.gemini_api.error}`}`,
        `🔧 MCP Workspace: ${report.mcp_server.status === "ok" ? `✅ OK (Tools loaded: ${report.mcp_server.tools_loaded})` : `❌ FAILED: ${report.mcp_server.error}`}`
      ];

      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).substr(2, 9),
          sender: "system",
          text: lines.join("\n"),
          timestamp: new Date()
        }
      ]);
      addLog("system", `System diagnostics completed: ${report.status}`);
    } catch (err: any) {
      console.error("Failed to run diagnostics:", err);
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).substr(2, 9),
          sender: "system",
          text: `❌ Diagnostics failed to run: ${err.message}`,
          timestamp: new Date()
        }
      ]);
    }
  };

  const handleUnlink = async () => {
    setShowMenu(false);
    addLog("system", "Unlinking Google Calendar account...");
    try {
      const res = await fetch("/api/auth/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      if (data.success) {
        setIsGoogleLinked(false);
        addLog("system", "Google account successfully unlinked.");
        setMessages((prev) => [
          ...prev,
          {
            id: Math.random().toString(36).substr(2, 9),
            sender: "system",
            text: "🔑 Google Calendar account unlinked successfully.",
            timestamp: new Date()
          }
        ]);
      } else {
        throw new Error(data.error || "Failed to unlink");
      }
    } catch (err: any) {
      console.error("Failed to unlink Google account:", err);
      addLog("system", `Failed to unlink: ${err.message}`);
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).substr(2, 9),
          sender: "system",
          text: `⚠️ Failed to unlink Google account: ${err.message}`,
          timestamp: new Date()
        }
      ]);
    }
  };

  const handleCopyLogs = () => {
    const text = logs
      .map((log) => `[${log.timestamp.toLocaleTimeString()}] [${log.sender.toUpperCase()}]: ${log.text}`)
      .join("\n");
    navigator.clipboard.writeText(text)
      .then(() => {
        addLog("system", "Developer logs successfully copied to clipboard.");
      })
      .catch((err) => {
        console.error("Failed to copy logs:", err);
      });
  };

  return (
    <div className="dashboard">
      
      {/* 1. Left Panel: Agent Memory & Capabilities */}
      {showMemory && (
        <div className="panel sidebar memory-sidebar">
          <div className="panel-header">
            <span>🧠 Agent Memory</span>
            <button className="close-console-btn" onClick={() => setShowMemory(false)}>×</button>
          </div>
          <div className="panel-content">
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "16px" }}>
              The assistant learns and persists scheduling guidelines here. Ask it to "remember" items to update memory.
            </p>
            <div className="memory-list">
              {preferences.length > 0 ? (
                preferences.map((pref, i) => (
                  <div key={i} className="memory-item">
                    {pref}
                  </div>
                ))
              ) : (
                <div style={{ color: "var(--text-secondary)", fontSize: "12px", fontStyle: "italic", textAlign: "center", marginTop: "20px" }}>
                  No preferences recorded yet.
                </div>
              )}
            </div>

            <div className="sidebar-divider" />

            <div>
              <h4 style={{ fontSize: "13px", color: "var(--accent-cyan)", marginBottom: "8px", fontWeight: 600 }}>Active Capabilities</h4>
              <div className="status-indicator" style={{ marginBottom: "6px" }}>
                <div className="status-dot active" />
                <span>Workspace Calendar</span>
              </div>
              <div className="status-indicator" style={{ marginBottom: "6px" }}>
                <div className="status-dot active" />
                <span>Google Search</span>
              </div>
              <div className="status-indicator">
                <div className="status-dot active" />
                <span>Dynamic Memory</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. Main Column: Threaded Chatbot & Live Visualizer */}
      <div className="main-chat-area">
        <div className="chat-header">
          {/* Hamburger Menu on Left */}
          <div className="header-left">
            <button 
              className="hamburger-btn"
              onClick={() => setShowMenu(!showMenu)}
              title="Open Menu"
            >
              ☰
            </button>
            
            {showMenu && (
              <div className="hamburger-dropdown">
                {isGoogleLinked ? (
                  <button 
                    className="dropdown-item"
                    title="Unlink Google Calendar"
                    onClick={handleUnlink}
                  >
                    🔑 Unlink Google
                  </button>
                ) : (
                  <a 
                    href="/api/auth/google" 
                    className="dropdown-item"
                    title="Link Google Calendar"
                    onClick={() => setShowMenu(false)}
                  >
                    🔑 Link Google
                  </a>
                )}
                <button 
                  className="dropdown-item"
                  onClick={() => {
                    setShowMemory(!showMemory);
                    setShowMenu(false);
                  }}
                  title="Toggle Memory"
                >
                  🧠 Memory
                </button>
                <button 
                  className="dropdown-item"
                  onClick={() => {
                    setShowConsole(!showConsole);
                    setShowMenu(false);
                  }}
                  title="Toggle Dev Console"
                >
                  🖥️ Logs
                </button>
                <button 
                  className="dropdown-item"
                  onClick={runSelfCheck}
                  title="Run Self Diagnostics"
                >
                  🔍 Diagnostics
                </button>
              </div>
            )}
          </div>

          {/* Centered Title */}
          <div className="header-center">
            <h1 style={{ fontSize: "18px", fontWeight: 700, letterSpacing: "-0.5px", margin: 0 }}>
              Calendar <span style={{ color: "var(--accent-cyan)" }}>Live</span>
            </h1>
          </div>

          {/* Connection Status on Right */}
          <div className="header-right">
            <div className={`status-dot ${isConnected ? "active" : isConnecting ? "connecting" : ""}`} />
            <span className="status-text">{statusMessage}</span>
          </div>
        </div>

        {/* Messaging Chat Thread */}
        <div className="chat-thread-container">
          {messages.length === 0 ? (
            <div className="welcome-card">
              <div className="welcome-icon">💬</div>
              <h2>Ready to schedule?</h2>
              <p>Click "Start Session" to speak naturally with the assistant, or connect to type your requests.</p>
              <div className="suggestions-grid">
                <button onClick={() => setTextInput("What's on my calendar tomorrow?")} disabled={!isConnected} className="suggestion-pill">
                  "What's on my calendar tomorrow?"
                </button>
                <button onClick={() => setTextInput("Am I busy on Wednesday?")} disabled={!isConnected} className="suggestion-pill">
                  "Am I busy on Wednesday?"
                </button>
              </div>
            </div>
          ) : (
            <div className="chat-messages">
              {messages.map((msg) => {
                if (msg.sender === "system") {
                  return (
                    <div key={msg.id} className={`chat-bubble-system ${msg.isToolCall ? "tool-call" : ""}`}>
                      {msg.text}
                    </div>
                  );
                }
                if (msg.sender === "widget") {
                  return (
                    <div key={msg.id} className="chat-message-row widget">
                      <div className="chat-avatar widget">📅</div>
                      <div className="calendar-widget-wrapper">
                        <div className="calendar-widget-title">
                          {msg.widgetType === "event-detail" ? "Calendar Event Detail" : `${msg.text}`}
                        </div>
                        <div className="calendar-events-list">
                          {msg.eventsData?.map((event) => {
                            const startStr = formatEventTime(event.start);
                            const endStr = formatEventTime(event.end, true);
                            
                            return (
                              <a 
                                key={event.id}
                                href={event.htmlLink || "#"}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="calendar-event-card"
                                title="Click to view event in Google Calendar"
                              >
                                <div className="event-card-color-stripe" />
                                <div className="event-card-content">
                                  <div className="event-card-summary">{event.summary}</div>
                                  <div className="event-card-time">
                                    🕒 {startStr}{endStr ? ` - ${endStr}` : ''}
                                  </div>
                                  {event.location && (
                                    <div className="event-card-location">
                                      📍 {event.location}
                                    </div>
                                  )}
                                </div>
                                <div className="event-card-arrow">↗</div>
                              </a>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={msg.id} className={`chat-message-row ${msg.sender}`}>
                    {msg.sender === "model" && <div className="chat-avatar">AI</div>}
                    <div className={`chat-bubble ${msg.sender}`}>
                      {msg.text}
                    </div>
                    {msg.sender === "user" && <div className="chat-avatar user">ME</div>}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Visualizer Wave & Chat Input Bar Container */}
        <div className="chat-input-container">
          {/* Audio Visualizer Wave */}
          <div className="sleek-visualizer">
            <canvas ref={canvasRef} style={{ width: "100%", height: "60px", display: "block" }} />
          </div>

          <div className="chat-controls-bar">
            {/* Start / Stop Session Button */}
            <button
              className={`mic-button-upgrade ${(isConnected && isMicActive) ? "active" : isConnecting ? "connecting" : ""}`}
              onClick={handleToggleConnection}
              disabled={isConnecting}
              title={(isConnected && isMicActive) ? "Mute Microphone" : "Activate Microphone"}
            >
              {isConnecting ? "⏳" : (isConnected && isMicActive) ? "🔴" : "🎤"}
            </button>

            {/* Form Input */}
            <form onSubmit={handleSendText} className="unified-input-form">
              <input
                type="text"
                className="unified-text-input"
                placeholder="Message Calendar Live..."
                value={textInput}
                onChange={(e) => {
                  setTextInput(e.target.value);
                  // Auto-close microphone when starting to type to prevent interruptions
                  if (isMicActive) {
                    if (audioManagerRef.current) {
                      audioManagerRef.current.stopRecording();
                    }
                    setIsMicActive(false);
                    setMutePlayback(true);
                    addLog("system", "Typing detected. Closing microphone.");
                  }
                }}
              />
              <button 
                type="submit" 
                className={`unified-send-btn ${textInput.trim() ? "active" : ""}`} 
                disabled={!textInput.trim()}
              >
                ➔
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* 3. Right Panel: Collapsible Monospace Developer Console Logs */}
      {showConsole && (
        <div className="panel sidebar developer-sidebar">
          <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>🖥️ Dev Console Logs</span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <button 
                onClick={handleCopyLogs}
                style={{
                  background: "transparent",
                  border: "1px solid var(--panel-border)",
                  borderRadius: "4px",
                  fontSize: "11px",
                  padding: "2px 6px",
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                  display: "inline-flex",
                  alignItems: "center"
                }}
                title="Copy logs to clipboard"
              >
                📋 Copy
              </button>
              <button className="close-console-btn" onClick={() => setShowConsole(false)} style={{ border: "none", background: "transparent", fontSize: "18px", cursor: "pointer", padding: "0 4px" }}>×</button>
            </div>
          </div>
          <div className="panel-content monospace-console">
            <div className="raw-logs-container">
              {logs.map((log) => (
                <div key={log.id} className={`raw-log-line ${log.sender}`}>
                  <span className="log-time">[{log.timestamp.toLocaleTimeString()}]</span>
                  <span className={`log-sender-tag ${log.sender}`}>{log.sender.toUpperCase()}:</span> {log.text}
                </div>
              ))}
              <div ref={consoleEndRef} />
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
