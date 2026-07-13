import { GoogleCalendarClient } from "./google-client.js";
import fs from "fs";
import path from "path";

/**
 * Sanitizes Google Calendar event objects to prevent massive nested JSON payloads
 * (like conferenceData, creator email details, rules, etc.) from hitting 
 * Gemini Live API constraints or causing validation errors.
 */
function sanitizeEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    summary: event.summary,
    description: event.description ? event.description.substring(0, 500) : undefined, // Truncate description to save tokens
    location: event.location,
    start: event.start,
    end: event.end,
    htmlLink: event.htmlLink
  };
}

/**
 * Handles tool executions securely within a user's database context.
 * @param {string} name Name of the function declaration
 * @param {object} args Arguments supplied by Gemini Live
 * @param {GoogleCalendarClient} googleClient Client wrapper authorized for the user
 * @param {number} userId Primary key of the requesting user
 * @returns {Promise<any>} JSON response to be returned to Gemini Live
 */
export async function executeUserTool(name, args, googleClient, userId) {
  const prefPath = path.resolve(`server/data/preferences_${userId}.md`);
  
  // 1. User-specific preferences file operations
  if (name === "read_preferences") {
    if (!fs.existsSync(prefPath)) {
      const defaultPrefs = `# User Preferences\n* I prefer 25-minute sync meetings.\n* Do not book meetings on Friday afternoons.\n`;
      fs.mkdirSync(path.dirname(prefPath), { recursive: true });
      fs.writeFileSync(prefPath, defaultPrefs, "utf-8");
    }
    const content = fs.readFileSync(prefPath, "utf-8");
    return { content };
  }
  
  if (name === "save_preferences") {
    if (!args.content) {
      throw new Error("Missing 'content' parameter for save_preferences.");
    }
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(prefPath, args.content, "utf-8");
    return { success: true, message: "Preferences updated successfully." };
  }

  // 2. Google Calendar REST API actions
  if (name === "list_calendars") {
    const list = await googleClient.listCalendars();
    return list.items || [];
  }
  
  if (name === "list_events") {
    let calendarId = args.calendarId || "primary";
    
    // Normalize timestamps from UTC 'Z' markers to local offset to protect boundaries
    let timeMin = args.timeMin;
    let timeMax = args.timeMax;
    if (timeMin && timeMin.endsWith("Z")) timeMin = timeMin.replace("Z", "-07:00");
    if (timeMax && timeMax.endsWith("Z")) timeMax = timeMax.replace("Z", "-07:00");
    
    const params = {
      singleEvents: true,
      orderBy: "startTime"
    };
    if (timeMin) params.timeMin = timeMin;
    if (timeMax) params.timeMax = timeMax;
    
    // Check if we need to query across ALL active selected calendars concurrently
    if (calendarId === "primary") {
      console.log(`[Tool Runner] Querying all calendars in parallel for user_id: ${userId}`);
      const calendars = await googleClient.listCalendars();
      const listItems = calendars.items || [];
      const selectedCalendars = listItems.filter(c => c.selected);
      
      const queries = selectedCalendars.map(async (cal) => {
        try {
          const events = await googleClient.listEvents(cal.id, params);
          const list = events.items || [];
          return list.map(evt => ({
            ...evt,
            summary: `[${cal.summary}] ${evt.summary || "Untitled Event"}`
          }));
        } catch (err) {
          console.warn(`Failed to list events for calendar: ${cal.summary}`, err.message);
          return [];
        }
      });
      
      const results = await Promise.all(queries);
      const mergedEvents = results.flat();
      
      // Sort chronologically by start date/time
      mergedEvents.sort((a, b) => {
        const startA = a.start?.dateTime || a.start?.date || "";
        const startB = b.start?.dateTime || b.start?.date || "";
        return new Date(startA) - new Date(startB);
      });
      
      return mergedEvents.map(sanitizeEvent);
    } else {
      const events = await googleClient.listEvents(calendarId, params);
      return (events.items || []).map(sanitizeEvent);
    }
  }
  
  if (name === "create_event") {
    const calendarId = args.calendarId || "primary";
    const eventData = {
      summary: args.summary,
      description: args.description,
      start: args.start,
      end: args.end
    };
    if (args.attendees) eventData.attendees = args.attendees;
    if (args.location) eventData.location = args.location;
    
    const newEvent = await googleClient.createEvent(calendarId, eventData);
    return sanitizeEvent(newEvent);
  }
  
  if (name === "get_event") {
    const calendarId = args.calendarId || "primary";
    const event = await googleClient.getEvent(calendarId, args.eventId);
    return sanitizeEvent(event);
  }
  
  if (name === "update_event") {
    const calendarId = args.calendarId || "primary";
    const eventData = {
      summary: args.summary,
      description: args.description,
      start: args.start,
      end: args.end
    };
    if (args.attendees) eventData.attendees = args.attendees;
    if (args.location) eventData.location = args.location;
    
    const updatedEvent = await googleClient.updateEvent(calendarId, args.eventId, eventData);
    return sanitizeEvent(updatedEvent);
  }
  
  if (name === "delete_event") {
    const calendarId = args.calendarId || "primary";
    await googleClient.deleteEvent(calendarId, args.eventId);
    return { success: true, message: "Event deleted successfully." };
  }
  
  throw new Error(`Tool '${name}' is not supported in the cloud calendar engine.`);
}
