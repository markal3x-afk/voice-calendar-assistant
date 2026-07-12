# Gemini Live to MCP Voice Assistant

A premium, general-purpose voice assistant that bridges the **Gemini Multimodal Live API** (via WebSockets) to the **Model Context Protocol (MCP)**. It exposes Google Workspace (Calendar, Gmail, Drive) and Brave Web Search tools to Gemini, allowing you to speak to your calendar, search the web, and let the assistant manage its own preferences file.

---

## Prerequisites

Ensure you have **Node.js** (version 18 or higher) installed on your system.

### 1. Environment Configurations
We have initialized a `.env` file in this directory with your `GEMINI_API_KEY`. You need to populate the remaining variables:

1. **Google Workspace MCP Credentials**:
   - Create a Google Cloud project.
   - Enable the **Google Calendar API**, **Gmail API**, and **Google Drive API**.
   - Set up the OAuth consent screen and add your email to **Test Users**.
   - Create credentials of type **Desktop application**.
   - Fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

2. **Brave Search API Key (Optional)**:
   - Sign up at the [Brave API console](https://api.brave.com/register).
   - Generate an API key and fill in `BRAVE_API_KEY` in `.env`.
   - *To enable it, set `"enabled": true` under `"brave-search"` in `mcp_config.json`.*

---

## Installation & Running

### 1. Install All Dependencies
Run the helper script in the root directory to install packages for both the server and client:
```bash
npm run install:all
```

### 2. Start the Development Servers
Start both the Express backend gateway (port 3000) and the Vite frontend dev server (port 5173) concurrently:
```bash
npm run dev
```

### 3. Complete Google OAuth Consent
When the backend starts up, the **Google Workspace MCP subprocess** will run and automatically open a browser window on your desktop. 
- Log in with the test Google Account you added in your consent screen.
- Authorize the requested calendar, email, and drive permissions.
- Once completed, the MCP server will securely cache credentials locally, and the assistant will be authenticated.

---

## Usage
1. Open your browser to **`http://localhost:5173`** (or `http://localhost:3000`).
2. Click **Start Voice Session**.
3. Allow microphone permissions in your browser.
4. Speak naturally to your assistant!

### Things to Try:
- *"What is on my calendar tomorrow?"*
- *"Schedule a 25-minute sync with John on Monday at 3 PM to review the project design."*
- *"Remember that I do not do meetings on Friday afternoons."*
- *"What's the weather like in New York today?"* (Requires Brave Search enabled)
