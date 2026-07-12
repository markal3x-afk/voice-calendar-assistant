import { encrypt, decrypt } from "./crypto.js";

// Fetch client ID/secret configurations
const getOAuthClientConfig = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables.");
  }
  return { clientId, clientSecret };
};

/**
 * Verifies access token age and automatically requests a fresh token if expired.
 * @param {object} userCredentials Database credentials row containing tokens
 * @param {function} saveUpdatedTokensCallback Async callback to commit encrypted updates to the database
 * @returns {Promise<string>} The valid, decrypted access token
 */
export async function getActiveAccessToken(userCredentials, saveUpdatedTokensCallback) {
  const { access_token: encAccess, refresh_token: encRefresh, expiry_date: expiryStr } = userCredentials;
  
  const decryptedAccess = decrypt(encAccess);
  const decryptedRefresh = decrypt(encRefresh);
  const expiryDate = Number(expiryStr);
  
  // Return current access token if it's valid for at least another 60 seconds
  if (Date.now() < expiryDate - 60000) {
    return decryptedAccess;
  }
  
  console.log("Access token expired. Refreshing token via Google OAuth...");
  
  const { clientId, clientSecret } = getOAuthClientConfig();
  const tokenUrl = "https://oauth2.googleapis.com/token";
  
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decryptedRefresh,
      grant_type: "refresh_token"
    })
  });
  
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to refresh Google OAuth token: ${response.statusText}. Response: ${errorBody}`);
  }
  
  const data = await response.json();
  const newAccessToken = data.access_token;
  const newExpiryDate = Date.now() + (data.expires_in * 1000);
  
  // Encrypt the new access token
  const encryptedAccess = encrypt(newAccessToken);
  
  // Invoke database callback to save the new credentials row
  if (saveUpdatedTokensCallback) {
    await saveUpdatedTokensCallback({
      access_token: encryptedAccess,
      expiry_date: newExpiryDate
    });
  }
  
  return newAccessToken;
}

/**
 * Direct Google Calendar REST client utilizing standard HTTP requests.
 */
export class GoogleCalendarClient {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }
  
  async _request(endpoint, options = {}) {
    const url = `https://www.googleapis.com/calendar/v3${endpoint}`;
    const headers = {
      "Authorization": `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      ...options.headers
    };
    
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google Calendar API Error [${res.status}]: ${err}`);
    }
    return res.status === 204 ? null : res.json();
  }
  
  async listCalendars() {
    return this._request("/users/me/calendarList");
  }
  
  async listEvents(calendarId, params = {}) {
    const query = new URLSearchParams(params).toString();
    return this._request(`/calendars/${encodeURIComponent(calendarId)}/events?${query}`);
  }
  
  async createEvent(calendarId, eventData) {
    return this._request(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST",
      body: JSON.stringify(eventData)
    });
  }
  
  async getEvent(calendarId, eventId) {
    return this._request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }
  
  async updateEvent(calendarId, eventId, eventData) {
    return this._request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "PUT",
      body: JSON.stringify(eventData)
    });
  }
  
  async deleteEvent(calendarId, eventId) {
    return this._request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE"
    });
  }
}
