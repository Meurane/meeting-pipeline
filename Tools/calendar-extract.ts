#!/usr/bin/env bun
/**
 * calendar-extract.ts — Extract calendar events from macOS Calendar via JXA
 *
 * Reads from Outlook calendars synced to macOS Calendar (Exchange/M365).
 * Uses bulk property access + per-event attendee fetch for speed.
 * Writes JSON feed to OneDrive/.../20 - Transcripts/00 - Processing/calendar-feed/ for MeetingPipeline.
 *
 * Usage:
 *   bun calendar-extract.ts daily                          Today + tomorrow
 *   bun calendar-extract.ts backfill [--since 2026-01-14]  Historical
 *   bun calendar-extract.ts test                            Test access
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const CALENDARS = ["Calendar - Suez", "Calendar - LumAI"];
const FEED_DIR = join(
  Bun.env.HOME!,
  "Library/CloudStorage/OneDrive-SharedLibraries-LumaiConsulting",
  "Lumai Consulting - Documents/04 - Ressources/20 - Transcripts/00 - Processing/calendar-feed"
);

interface CalendarEvent {
  outlook_id: string;
  title: string;
  date: string;
  time_start: string;
  time_end: string;
  attendees: Array<{ name: string; email: string }>;
  body: string;
  location: string;
  is_recurring: boolean;
  calendar_source: string;
}

interface FeedFile {
  events: CalendarEvent[];
  synced_at: string;
  source: string;
}

/**
 * Extract events using JXA with heredoc (avoids shell quoting issues and timeouts).
 * Bulk property access for speed, per-event attendee fetch only on matching events.
 */
function extractEvents(calendarName: string, startDate: string, endDate: string, includeAttendees: boolean = true): CalendarEvent[] {
  const jxa = `
const Calendar = Application("Calendar");
let cal;
try { cal = Calendar.calendars.byName("${calendarName}"); } catch(e) { JSON.stringify([]); }
const summaries = cal.events.summary();
const starts = cal.events.startDate();
const ends = cal.events.endDate();
const uids = cal.events.uid();
const locations = cal.events.location();
const alldays = cal.events.alldayEvent();
const cutoff = new Date("${startDate}T00:00:00");
const limit = new Date("${endDate}T23:59:59");
const indices = [];
for (let i = 0; i < summaries.length; i++) {
  if (starts[i] >= cutoff && starts[i] <= limit && !alldays[i]) indices.push(i);
}
const withAtts = ${includeAttendees ? "true" : "false"};
const results = indices.map(function(i) {
  var evt = cal.events[i];
  var atts = [];
  if (withAtts) {
    try {
      var a = evt.attendees();
      for (var j = 0; j < a.length; j++) atts.push({name: a[j].displayName(), email: a[j].email()});
    } catch(x) {}
  }
  var desc = "";
  try { desc = (evt.description() || "").slice(0, 500); } catch(x) {}
  var s = starts[i]; var e = ends[i];
  return {
    uid: uids[i], title: summaries[i],
    date: s.getFullYear()+"-"+String(s.getMonth()+1).padStart(2,"0")+"-"+String(s.getDate()).padStart(2,"0"),
    ts: String(s.getHours()).padStart(2,"0")+String(s.getMinutes()).padStart(2,"0"),
    te: String(e.getHours()).padStart(2,"0")+String(e.getMinutes()).padStart(2,"0"),
    loc: locations[i]||"", atts: atts, body: desc
  };
});
JSON.stringify(results);
`;

  try {
    const raw = execFileSync("osascript", ["-l", "JavaScript", "-e", jxa], {
      encoding: "utf-8",
      timeout: 120000,
    }).trim();

    if (!raw || raw === "null" || raw === "undefined") return [];

    const parsed = JSON.parse(raw) as any[];
    return parsed.map(e => ({
      outlook_id: e.uid,
      title: e.title,
      date: e.date,
      time_start: e.ts,
      time_end: e.te,
      attendees: e.atts || [],
      body: e.body || "",
      location: e.loc || "",
      is_recurring: false,
      calendar_source: calendarName,
    }));
  } catch (e: any) {
    console.error(`  ${calendarName}: extraction failed: ${e.message?.slice(0, 200)}`);
    return [];
  }
}

function writeFeedFiles(events: CalendarEvent[]): number {
  if (!existsSync(FEED_DIR)) mkdirSync(FEED_DIR, { recursive: true });

  const byDate = new Map<string, CalendarEvent[]>();
  for (const evt of events) {
    const existing = byDate.get(evt.date) || [];
    existing.push(evt);
    byDate.set(evt.date, existing);
  }

  let filesWritten = 0;
  for (const [date, dateEvents] of byDate) {
    const feed: FeedFile = {
      events: dateEvents,
      synced_at: new Date().toISOString(),
      source: "macos-calendar",
    };
    writeFileSync(join(FEED_DIR, `${date}.json`), JSON.stringify(feed, null, 2));
    filesWritten++;
  }
  return filesWritten;
}

// --- Commands ---

function cmdDaily(): void {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const startDate = today.toISOString().slice(0, 10);
  const endDate = tomorrow.toISOString().slice(0, 10);

  console.log(`Syncing ${startDate} to ${endDate}...`);
  const allEvents: CalendarEvent[] = [];
  for (const cal of CALENDARS) {
    const events = extractEvents(cal, startDate, endDate, true); // daily: include attendees
    console.log(`  ${cal}: ${events.length} events`);
    allEvents.push(...events);
  }
  const files = writeFeedFiles(allEvents);
  console.log(`\x1b[32m✓\x1b[0m Daily: ${allEvents.length} events, ${files} files`);
}

function cmdBackfill(since: string): void {
  const endDate = new Date().toISOString().slice(0, 10);
  console.log(`Backfilling ${since} to ${endDate}...`);

  // Split into monthly chunks
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = new Date(since + "T00:00:00");
  const end = new Date(endDate + "T23:59:59");
  while (cursor < end) {
    const chunkEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    chunks.push({ start: cursor.toISOString().slice(0, 10), end: actualEnd.toISOString().slice(0, 10) });
    cursor = new Date(chunkEnd.getTime() + 24 * 3600 * 1000);
  }

  const allEvents: CalendarEvent[] = [];
  for (const chunk of chunks) {
    const label = chunk.start.slice(0, 7);
    for (const cal of CALENDARS) {
      const events = extractEvents(cal, chunk.start, chunk.end, false); // backfill: skip attendees (too slow)
      console.log(`  ${label} ${cal}: ${events.length} events`);
      allEvents.push(...events);
    }
  }

  const files = writeFeedFiles(allEvents);
  if (!existsSync(FEED_DIR)) mkdirSync(FEED_DIR, { recursive: true });
  writeFileSync(join(FEED_DIR, "backfill.json"), JSON.stringify({
    events: allEvents,
    synced_at: new Date().toISOString(),
    source: "macos-calendar-backfill",
    date_range: { start: since, end: endDate },
    total_events: allEvents.length,
  }, null, 2));

  console.log(`\x1b[32m✓\x1b[0m Backfill: ${allEvents.length} events, ${files} date files + backfill.json`);
}

function cmdTest(): void {
  console.log("Testing calendar access...\n");
  for (const cal of CALENDARS) {
    const now = new Date();
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
    const events = extractEvents(cal, twoWeeksAgo.toISOString().slice(0, 10), now.toISOString().slice(0, 10));
    console.log(`${cal}: ${events.length} events (last 14 days)`);
    for (const e of events.slice(0, 5)) {
      const atts = e.attendees.map(a => a.name).join(", ");
      console.log(`  ${e.date} ${e.time_start} | ${e.title} | ${atts || "solo"}`);
    }
    console.log();
  }
}

// --- CLI ---
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "daily": cmdDaily(); break;
  case "backfill": {
    const idx = args.indexOf("--since");
    cmdBackfill(idx >= 0 && args[idx + 1] ? args[idx + 1] : "2026-01-14");
    break;
  }
  case "test": cmdTest(); break;
  default:
    console.log(`\n  CalendarSync — macOS Calendar extraction\n
  bun calendar-extract.ts daily                          Today + tomorrow
  bun calendar-extract.ts backfill [--since YYYY-MM-DD]  Backfill (default: 2026-01-14)
  bun calendar-extract.ts test                            Test access\n`);
}
