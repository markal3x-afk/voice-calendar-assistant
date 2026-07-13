import { executeUserTool } from "./utils/tool-runner.js";
import assert from "assert";

async function runTests() {
  console.log("🚀 Starting Tool Runner Integration Tests...\n");

  // Mock GoogleCalendarClient
  const mockGoogleClient = {
    async listCalendars() {
      return {
        items: [
          { id: "primary", summary: "Personal Calendar", selected: true }
        ]
      };
    },
    
    async listEvents(calendarId, params) {
      console.log(`[Mock Google Client] listEvents called with calendarId: ${calendarId}, params:`, params);
      return {
        items: [
          {
            id: "test-event-1",
            summary: "Singapore flight SQ 33",
            start: { dateTime: "2026-07-16T22:25:00-07:00" },
            end: { dateTime: "2026-07-17T06:00:00+08:00" }
          }
        ]
      };
    }
  };

  const userId = 1;

  // Test 1: Verify list_events maps the search query argument to params.q
  console.log("Test 1: Verify list_events forwards the query parameter 'q' or 'query'...");
  let capturedParams = null;
  mockGoogleClient.listEvents = async (calendarId, params) => {
    capturedParams = params;
    return { items: [] };
  };

  await executeUserTool(
    "list_events",
    { query: "Singapore flight", timeMin: "2026-07-13T00:00:00Z" },
    mockGoogleClient,
    userId
  );

  assert.ok(capturedParams, "Google Calendar listEvents was not invoked");
  assert.strictEqual(capturedParams.q, "Singapore flight", "Query parameter 'q' was not mapped correctly from 'query'");
  console.log("✅ Test 1 Passed: 'query' was mapped to 'q'.");

  // Test 2: Verify q parameter takes precedence or matches
  console.log("\nTest 2: Verify 'q' parameter mapping...");
  capturedParams = null;
  await executeUserTool(
    "list_events",
    { q: "World Cup Finals" },
    mockGoogleClient,
    userId
  );

  assert.ok(capturedParams, "Google Calendar listEvents was not invoked");
  assert.strictEqual(capturedParams.q, "World Cup Finals", "Query parameter 'q' was not mapped correctly from 'q'");
  console.log("✅ Test 2 Passed: 'q' was forwarded correctly.");

  // Test 3: Verify UTC Z suffixes are normalized to Pacific Time offset (-07:00) as expected by backend rules
  console.log("\nTest 3: Verify UTC 'Z' timezone normalization...");
  capturedParams = null;
  await executeUserTool(
    "list_events",
    { timeMin: "2026-07-20T00:00:00Z" },
    mockGoogleClient,
    userId
  );

  assert.ok(capturedParams, "Google Calendar listEvents was not invoked");
  assert.strictEqual(capturedParams.timeMin, "2026-07-20T00:00:00-07:00", "UTC 'Z' was not normalized to Pacific offset");
  console.log("✅ Test 3 Passed: 'Z' normalized to '-07:00'.");

  console.log("\n🎉 ALL TOOL RUNNER TESTS PASSED SUCCESSFULLY!\n");
}

runTests().catch(err => {
  console.error("❌ Test runner failed:", err);
  process.exit(1);
});
