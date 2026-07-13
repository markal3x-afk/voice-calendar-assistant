import { encrypt, decrypt } from "./utils/crypto.js";
import { getActiveAccessToken } from "./utils/google-client.js";
import assert from "assert";

async function runTests() {
  console.log("🚀 Starting Auth & Token Refresh Integration Tests...\n");

  // 1. Verify Crypto utility (AES-256-GCM encryption/decryption)
  console.log("Test 1: Verifying crypto encryption/decryption integrity...");
  const plaintext = "ya29.google-oauth-access-token-123456";
  const encrypted = encrypt(plaintext);
  assert.ok(encrypted, "Encryption returned null or empty");
  assert.notStrictEqual(encrypted, plaintext, "Encrypted text matches plaintext");
  
  const decrypted = decrypt(encrypted);
  assert.strictEqual(decrypted, plaintext, "Decrypted text does not match original plaintext");
  console.log("✅ Test 1 Passed: Encryption and decryption are 100% loss-less.");

  // 2. Verify getActiveAccessToken age checks
  console.log("\nTest 2: Verifying getActiveAccessToken on-demand age check...");
  
  // Set up mock credential records
  const mockUserCredentialsActive = {
    access_token: encrypt("active-token-abc"),
    refresh_token: encrypt("refresh-token-xyz"),
    expiry_date: Date.now() + 300000 // Valid for 5 minutes
  };

  // Mock callback
  let dbCallbackInvoked = false;
  const mockSaveCallback = async (updates) => {
    dbCallbackInvoked = true;
  };

  // Active token should be returned immediately without calling refresh
  const token = await getActiveAccessToken(mockUserCredentialsActive, mockSaveCallback);
  assert.strictEqual(token, "active-token-abc", "Did not return active access token");
  assert.strictEqual(dbCallbackInvoked, false, "Database update callback was invoked for active token");
  console.log("✅ Test 2 Passed: Active tokens are returned directly without redundant network calls.");

  // 3. Verify getActiveAccessToken refresh logic on expired token
  console.log("\nTest 3: Verifying getActiveAccessToken refresh triggers on expired token...");
  
  const mockUserCredentialsExpired = {
    access_token: encrypt("expired-token-abc"),
    refresh_token: encrypt("refresh-token-xyz"),
    expiry_date: Date.now() - 10000 // Expired 10 seconds ago
  };

  // Mock fetch endpoint
  const originalFetch = global.fetch;
  let fetchParams = null;
  global.fetch = async (url, options) => {
    fetchParams = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "refreshed-token-999",
        expires_in: 3600
      })
    };
  };

  dbCallbackInvoked = false;
  let savedFields = null;
  const saveCallback = async (updates) => {
    dbCallbackInvoked = true;
    savedFields = updates;
  };

  // Set fake credentials in environment for test run
  process.env.GOOGLE_CLIENT_ID = "mock-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret";

  const refreshedToken = await getActiveAccessToken(mockUserCredentialsExpired, saveCallback);
  
  // Restore original fetch
  global.fetch = originalFetch;

  assert.strictEqual(refreshedToken, "refreshed-token-999", "Failed to return refreshed token");
  assert.ok(fetchParams, "OAuth token refresh endpoint was not requested");
  assert.strictEqual(dbCallbackInvoked, true, "Database callback was not invoked to save fresh tokens");
  assert.ok(savedFields.access_token, "Refreshed access token was not encrypted");
  
  const decryptedSavedToken = decrypt(savedFields.access_token);
  assert.strictEqual(decryptedSavedToken, "refreshed-token-999", "Saved encrypted token decrypts to incorrect value");
  console.log("✅ Test 3 Passed: Expired tokens trigger Google OAuth calls, encrypt fresh tokens, and update DB.");

  console.log("\n🎉 ALL AUTH INTEGRATION TESTS PASSED SUCCESSFULLY!\n");
}

runTests().catch(err => {
  console.error("❌ Test failure:", err);
  process.exit(1);
});
