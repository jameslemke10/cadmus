/**
 * Google Calendar tools - create events, list events
 *
 * These tools use the Google Calendar API, and require an API key with appropriate permissions.
 *
 */

import { defineTool } from "@cadmus/kernel";
import { google } from 'googleapis';
import { readFileSync } from 'node:fs';


interface CalendarListParams {
  from?: string;   // ISO date string, e.g., "2025-04-01T00:00:00Z"
  to?: string;     // ISO date string
  calendarId?: string; // default: 'primary'
}

interface CalendarCreateParams {
  title: string;
  start: string;         // ISO date string
  end: string;           // ISO date string
  description?: string;
  attendees?: string[];  // email addresses
  calendarId?: string;   // default: 'primary'
}

/**
 * Create Google Calendar tools using a service account.
 * @param credentialsPath Path to the service account JSON key file.
 * @returns An object containing the calendar tools.
 */
export function createCalendarTools({ credentialsPath }: { credentialsPath: string }): { list: any; create: any } {
  const key = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  const auth = new google.auth.JWT(
    key.client_email,
    undefined,
    key.private_key,
    ['https://www.googleapis.com/auth/calendar']
  );

  const calendar = google.calendar({ version: 'v3', auth });

  // list events
  const listTool = defineTool({
    name: 'calendar_list',
    description: 'List upcoming calendar events within an optional time range.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date-time'},
        to: { type: 'string', format: 'date-time'},
        calendarId: { type: 'string'}
      }
    },
    handler: async (args) => {
      const { from, to, calendarId = 'primary' } = args as CalendarListParams;
      const timeMin = from ? new Date(from) : new Date();
      const timeMax = to ? new Date(to) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const response = await calendar.events.list({
        calendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });
      return response.data.items || [];
    }
  });

  // create event
  const createTool = defineTool({
    name: 'calendar_create',
    description: 'Create a new calendar event.',
    input_schema: {
      type: 'object',
      required: ['title', 'start', 'end'],
      properties: {
        title: { type: 'string'},
        start: { type: 'string', format: 'date-time'},
        end: { type: 'string', format: 'date-time'},
        description: { type: 'string'},
        attendees: { type: 'array', items: { type: 'string' }}
      }
    },
    handler: async (args) => {
      const { title, start, end, description = '', attendees = [], calendarId = 'primary' } = args as CalendarCreateParams;
      const event = {
        summary: title,
        description,
        start: { dateTime: start, timeZone: 'UTC' },
        end: { dateTime: end, timeZone: 'UTC' },
        attendees: attendees.length > 0 ? attendees.map(email => ({ email })) : undefined
      };

      const response = await calendar.events.insert({
        calendarId: calendarId,
        requestBody: event,
        sendUpdates: 'all' // send invites to attendees
      });
      return response.data;
    }
  });

  return {
    listCalendar: listTool,
    createCalendar: createTool
  };
}
