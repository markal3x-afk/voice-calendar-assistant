import express from "express";
import db from "../utils/db.js";
import { encrypt } from "../utils/crypto.js";

const router = express.Router();

// Helper to construct callback redirect URI
const getRedirectUri = (req) => {
  const host = req.get("host");
  const protocol = req.protocol;
  return `${protocol}://${host}/api/auth/google/callback`;
};

/**
 * GET /api/auth/google
 * Initiates the Google OAuth consent flow
 */
router.get("/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "GOOGLE_CLIENT_ID is not configured on the server." });
  }

  const redirectUri = getRedirectUri(req);
  
  // Scopes requested (Calendar Read/Write + Email identification)
  const scopes = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email"
  ];

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("access_type", "offline"); // Crucial to request a refresh token
  authUrl.searchParams.set("prompt", "consent");      // Force consent screen to guarantee refresh token delivery

  console.log(`Redirecting user to Google OAuth: ${redirectUri}`);
  res.redirect(authUrl.toString());
});

/**
 * GET /api/auth/google/callback
 * Handles callback from Google OAuth code exchange
 */
router.get("/google/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error("Google OAuth error parameter received:", error);
    return res.status(400).send(`OAuth Error: ${error}`);
  }

  if (!code) {
    return res.status(400).send("OAuth Error: No authorization code supplied by Google.");
  }

  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = getRedirectUri(req);

    // 1. Exchange code for access & refresh tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.statusText}. Details: ${errText}`);
    }

    const tokenData = await tokenResponse.json();
    const { access_token, refresh_token, expires_in } = tokenData;

    if (!refresh_token) {
      console.warn("WARNING: No refresh token returned. User may need to revoke app access and consent again.");
    }

    const expiryDate = Date.now() + (expires_in * 1000);

    // 2. Fetch user's Google email address
    const userinfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { "Authorization": `Bearer ${access_token}` }
    });

    if (!userinfoResponse.ok) {
      throw new Error(`Userinfo retrieval failed: ${userinfoResponse.statusText}`);
    }

    const userinfo = await userinfoResponse.json();
    const email = userinfo.email;

    if (!email) {
      throw new Error("No email returned in Google Userinfo schema.");
    }

    console.log(`Successfully authenticated user: ${email}`);

    // 3. Upsert user in 'users' table
    let userResult = await db.query(
      "INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING *",
      [email]
    );
    // Fallback DB handles conflict differently so let's query if rows is empty
    if (!userResult.rows || userResult.rows.length === 0) {
      userResult = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    }
    const user = userResult.rows[0];

    // 4. Encrypt tokens using AES-256-GCM
    const encryptedAccess = encrypt(access_token);
    const encryptedRefresh = refresh_token ? encrypt(refresh_token) : null;

    // 5. Upsert credentials in 'google_credentials' table
    if (encryptedRefresh) {
      await db.query(
        `INSERT INTO google_credentials (user_id, access_token, refresh_token, expiry_date)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id)
         DO UPDATE SET access_token = EXCLUDED.access_token, 
                       refresh_token = EXCLUDED.refresh_token, 
                       expiry_date = EXCLUDED.expiry_date,
                       updated_at = CURRENT_TIMESTAMP`,
        [user.id, encryptedAccess, encryptedRefresh, expiryDate]
      );
    } else {
      // If refresh_token was not returned (subsequent login), update only access token & expiry
      await db.query(
        `INSERT INTO google_credentials (user_id, access_token, expiry_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id)
         DO UPDATE SET access_token = EXCLUDED.access_token,
                       expiry_date = EXCLUDED.expiry_date,
                       updated_at = CURRENT_TIMESTAMP`,
        [user.id, encryptedAccess, expiryDate]
      );
    }

    // 6. Return minimalist completed screen HTML page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authorization Successful</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: #f7f6f2; /* Shoji Sand Gray */
            color: #2c2a29;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
          }
          .card {
            background-color: #ffffff;
            border: 1px solid #e3dec3;
            border-radius: 16px;
            padding: 32px 24px;
            box-shadow: 0 8px 24px rgba(44, 42, 41, 0.04);
            max-width: 400px;
            width: 100%;
            text-align: center;
          }
          .success-icon {
            font-size: 48px;
            margin-bottom: 16px;
            color: #5c7a80; /* Moss Green */
          }
          h2 {
            font-size: 22px;
            font-weight: 700;
            margin: 0 0 12px 0;
            letter-spacing: -0.5px;
          }
          p {
            font-size: 14px;
            color: #706b68;
            line-height: 1.6;
            margin: 0 0 24px 0;
          }
          .badge {
            background: #f0ede4;
            color: #5c7a80;
            padding: 8px 16px;
            border-radius: 30px;
            font-size: 13px;
            font-weight: 600;
            display: inline-block;
            margin-bottom: 24px;
          }
          .instruction-box {
            background: #f7f6f2;
            border-left: 3px solid #c95942; /* Hanko Vermilion */
            padding: 12px 16px;
            border-radius: 6px;
            font-size: 13px;
            color: #2c2a29;
            text-align: left;
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="success-icon">✓</div>
          <h2>Link Successful!</h2>
          <p>Your Google Calendar has been securely authorized and connected to the assistant.</p>
          <div class="badge">${email}</div>
          <div class="instruction-box">
            👉 <strong>Please tap "Done"</strong> in the top-left corner of this screen to return to the assistant interface and start your session.
          </div>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    console.error("Google OAuth callback exception:", err);
    res.status(500).send(`Authentication Failed: ${err.message}`);
  }
});

export default router;
