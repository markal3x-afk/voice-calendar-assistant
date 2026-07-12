import pg from "pg";
import fs from "fs";
import path from "path";

const isPostgresConfigured = !!process.env.DATABASE_URL;

let pool = null;
if (isPostgresConfigured) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false // Necessary for DigitalOcean managed PostgreSQL connections
    }
  });
}

// Path to store dummy data in local mode
const FALLBACK_DB_PATH = path.resolve("server/data/db_fallback.json");

// Ensure data folder and file structure exist
const dir = path.dirname(FALLBACK_DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(FALLBACK_DB_PATH)) {
  fs.writeFileSync(FALLBACK_DB_PATH, JSON.stringify({ users: [], credentials: [] }, null, 2));
}

const getFallbackData = () => {
  return JSON.parse(fs.readFileSync(FALLBACK_DB_PATH, "utf8"));
};

const saveFallbackData = (data) => {
  fs.writeFileSync(FALLBACK_DB_PATH, JSON.stringify(data, null, 2));
};

/**
 * Universal Database adapter supporting PostgreSQL and local JSON fallbacks.
 */
export const db = {
  async query(text, params = []) {
    if (isPostgresConfigured) {
      return pool.query(text, params);
    }
    
    // Fallback JSON handler translating standard statements
    console.log(`[Local DB] Simulating Query: ${text.replace(/\s+/g, ' ').substring(0, 100)}...`);
    const data = getFallbackData();
    
    // 1. Insert User: INSERT INTO users ... RETURNING *
    if (text.includes("INSERT INTO users")) {
      const email = params[0];
      let user = data.users.find(u => u.email === email);
      if (!user) {
        user = { id: data.users.length + 1, email, created_at: new Date().toISOString() };
        data.users.push(user);
        saveFallbackData(data);
      }
      return { rows: [user] };
    }
    
    // 2. Select User by Email
    if (text.includes("SELECT * FROM users WHERE email")) {
      const email = params[0];
      const user = data.users.find(u => u.email === email);
      return { rows: user ? [user] : [] };
    }
    
    // 3. Select User by ID
    if (text.includes("SELECT * FROM users WHERE id")) {
      const id = params[0];
      const user = data.users.find(u => u.id === Number(id));
      return { rows: user ? [user] : [] };
    }
    
    // 4. Select Credentials by User ID
    if (text.includes("SELECT * FROM google_credentials WHERE user_id")) {
      const userId = params[0];
      const cred = data.credentials.find(c => c.user_id === Number(userId));
      return { rows: cred ? [cred] : [] };
    }
    
    // 5. Upsert Credentials (INSERT ... ON CONFLICT)
    if (text.includes("INSERT INTO google_credentials")) {
      const [userId, accessToken, refreshToken, expiryDate] = params;
      let cred = data.credentials.find(c => c.user_id === Number(userId));
      
      if (cred) {
        cred.access_token = accessToken;
        if (refreshToken) cred.refresh_token = refreshToken;
        cred.expiry_date = Number(expiryDate);
        cred.updated_at = new Date().toISOString();
      } else {
        cred = {
          id: data.credentials.length + 1,
          user_id: Number(userId),
          access_token: accessToken,
          refresh_token: refreshToken,
          expiry_date: Number(expiryDate),
          updated_at: new Date().toISOString()
        };
        data.credentials.push(cred);
      }
      saveFallbackData(data);
      return { rows: [cred] };
    }
    
    // 6. Update Access Token only
    if (text.includes("UPDATE google_credentials")) {
      const [accessToken, expiryDate, userId] = params;
      const cred = data.credentials.find(c => c.user_id === Number(userId));
      if (cred) {
        cred.access_token = accessToken;
        cred.expiry_date = Number(expiryDate);
        cred.updated_at = new Date().toISOString();
        saveFallbackData(data);
      }
      return { rows: cred ? [cred] : [] };
    }
    
    return { rows: [] };
  }
};
export default db;
