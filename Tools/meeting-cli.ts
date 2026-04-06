#!/usr/bin/env bun
/**
 * meeting-cli.ts — CLI entrypoint for Meeting Pipeline v3 (debug/monitoring)
 *
 * Usage:
 *   bun meeting-cli.ts status                    Show pipeline overview (git status style)
 *   bun meeting-cli.ts list [--state X] [--client X] [--date X]  List meetings
 *   bun meeting-cli.ts show <id>                 Show meeting details
 *   bun meeting-cli.ts ingest                    Ingest calendar feed files
 *   bun meeting-cli.ts sync [--month MM]         Scan OneDrive for new transcripts
 *   bun meeting-cli.ts migrate                   Migrate old pipeline-tracking.json
 *   bun meeting-cli.ts thread <id>               Show thread context for a meeting
 */

import {
  getStats,
  listMeetings,
  getMeeting,
  getEnablers,
  getThreadContext,
  ingestCalendarFeed,
  syncTranscripts,
  transitionState,
  getPendingQuestions,
  resolveEntityQuestion,
  closeDb,
  type MeetingRow,
} from "./meeting-core";

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const c = (color: keyof typeof COLORS, text: string) =>
  `${COLORS[color]}${text}${COLORS.reset}`;

function stateColor(state: string): string {
  switch (state) {
    case "enriched": return c("green", state);
    case "cr_written": return c("cyan", state);
    case "processing": return c("yellow", state);
    case "routed": return c("blue", state);
    case "registered": return c("magenta", state);
    case "transcript_received": return c("blue", state);
    case "error": return c("red", state);
    case "skipped": return c("dim", state);
    default: return state;
  }
}

// --- Commands ---

function cmdStatus(): void {
  const stats = getStats();

  console.log(c("bold", "\n  Meeting Pipeline v3 — Status\n"));

  if (stats.total === 0) {
    console.log("  No meetings tracked yet.\n");
    console.log("  Run: bun meeting-cli.ts ingest    (load calendar feed)");
    console.log("  Run: bun meeting-cli.ts sync      (scan transcripts)");
    return;
  }

  // State summary
  const states = [
    ["registered", "Awaiting transcript"],
    ["transcript_received", "Need routing"],
    ["routed", "Ready to process"],
    ["processing", "In progress"],
    ["cr_written", "CR done, enriching"],
    ["enriched", "Complete"],
    ["error", "Errors"],
    ["skipped", "Skipped"],
  ];

  for (const [state, label] of states) {
    const count = stats[state] || 0;
    if (count > 0) {
      console.log(`  ${stateColor(state).padEnd(35)} ${count.toString().padStart(3)}  ${c("dim", label)}`);
    }
  }

  console.log(`  ${"─".repeat(45)}`);
  console.log(`  ${c("bold", "Total").padEnd(28)} ${stats.total.toString().padStart(3)}`);

  if (stats.pending_questions > 0) {
    console.log(`\n  ${c("yellow", `⚠ ${stats.pending_questions} pending HITL questions`)}`);
  }

  console.log();
}

function cmdList(args: string[]): void {
  const filters: any = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--state" && args[i + 1]) filters.state = args[++i];
    if (args[i] === "--client" && args[i + 1]) filters.client = args[++i];
    if (args[i] === "--date" && args[i + 1]) filters.date = args[++i];
    if (args[i] === "--limit" && args[i + 1]) filters.limit = parseInt(args[++i]);
  }

  if (!filters.limit) filters.limit = 20;

  const meetings = listMeetings(filters);

  if (meetings.length === 0) {
    console.log("  No meetings found matching filters.");
    return;
  }

  console.log(c("bold", `\n  Meetings (${meetings.length}):\n`));

  for (const m of meetings) {
    const client = m.client || "?";
    const title = m.calendar_title || m.transcript_id || m.id;
    const time = m.time_start ? ` ${m.time_start.slice(0, 2)}:${m.time_start.slice(2)}` : "";
    console.log(
      `  ${c("dim", m.date)}${time}  ${stateColor(m.state).padEnd(35)}  ${c("cyan", client.padEnd(12))}  ${title.slice(0, 50)}`
    );
  }
  console.log();
}

function cmdShow(id: string): void {
  const meeting = getMeeting(id);
  if (!meeting) {
    console.error(`  Meeting ${id} not found`);
    process.exit(1);
  }

  console.log(c("bold", `\n  Meeting: ${meeting.id}\n`));
  console.log(`  State:       ${stateColor(meeting.state)}`);
  console.log(`  Type:        ${meeting.type}`);
  console.log(`  Date:        ${meeting.date} ${meeting.time_start || ""}`);
  console.log(`  Client:      ${meeting.client || c("dim", "unknown")}`);
  console.log(`  Project:     ${meeting.project || c("dim", "none")}`);
  console.log(`  Meeting Type:${meeting.meeting_type || c("dim", "unrouted")}`);
  console.log(`  Confidence:  ${meeting.routing_confidence ?? c("dim", "n/a")}`);
  console.log(`  Source:      ${meeting.routing_source || c("dim", "n/a")}`);

  if (meeting.participants) {
    try {
      const parts = JSON.parse(meeting.participants);
      console.log(`  Participants:${Array.isArray(parts) ? parts.join(", ") : meeting.participants}`);
    } catch {
      console.log(`  Participants:${meeting.participants}`);
    }
  }

  if (meeting.transcript_id)
    console.log(`  Transcript:  ${meeting.transcript_id}`);
  if (meeting.cr_file) console.log(`  CR File:     ${meeting.cr_file}`);
  if (meeting.summary) console.log(`  Summary:     ${meeting.summary}`);
  if (meeting.calendar_title)
    console.log(`  Cal Title:   ${meeting.calendar_title}`);

  // Enablers
  const enablers = getEnablers(meeting.id);
  if (enablers.length > 0) {
    console.log(`\n  ${c("bold", "Enablers:")}`);
    for (const e of enablers) {
      const icon =
        e.status === "done" ? c("green", "✓") :
        e.status === "failed" ? c("red", "✗") :
        e.status === "running" ? c("yellow", "⟳") :
        c("dim", "○");
      console.log(`    ${icon} ${e.enabler.padEnd(20)} ${e.status}${e.error ? c("red", ` (${e.error})`) : ""}`);
    }
  }

  console.log(`\n  Created:     ${meeting.created_at}`);
  console.log(`  Updated:     ${meeting.updated_at}`);
  if (meeting.processed_at) console.log(`  Processed:   ${meeting.processed_at}`);
  if (meeting.enriched_at) console.log(`  Enriched:    ${meeting.enriched_at}`);
  console.log();
}

function cmdIngest(): void {
  const result = ingestCalendarFeed();
  console.log(
    c("green", "✓") +
      ` Calendar ingest: ${result.inserted} inserted, ${result.updated} updated (${result.files.length} files)`
  );
}

function cmdSync(args: string[]): void {
  let month: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--month" && args[i + 1]) month = args[++i];
  }

  const result = syncTranscripts(month);
  console.log(
    c("green", "✓") +
      ` Transcript sync: ${result.newTranscripts} new, ${result.matched} matched to calendar`
  );
}

function cmdThread(id: string): void {
  const meeting = getMeeting(id);
  if (!meeting) {
    console.error(`  Meeting ${id} not found`);
    process.exit(1);
  }
  if (!meeting.client) {
    console.log("  No client set, cannot detect thread.");
    return;
  }

  const thread = getThreadContext(meeting.client, meeting.date);
  if (thread.length === 0) {
    console.log(`  No previous meetings with ${meeting.client} in last 30 days.`);
    return;
  }

  console.log(c("bold", `\n  Thread context for ${meeting.client} (${thread.length} previous):\n`));
  for (const t of thread) {
    const title = t.calendar_title || t.id;
    console.log(`  ${c("dim", t.date)}  ${t.meeting_type || "?"} | ${title}`);
    if (t.summary) console.log(`    ${c("dim", t.summary.slice(0, 100))}`);
  }
  console.log();
}

// --- Dispatch ---

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case "status":
      cmdStatus();
      break;
    case "list":
      cmdList(args);
      break;
    case "show":
      if (!args[0]) {
        console.error("Usage: meeting-cli.ts show <id>");
        process.exit(1);
      }
      cmdShow(args[0]);
      break;
    case "ingest":
      cmdIngest();
      break;
    case "sync":
      cmdSync(args);
      break;
    case "thread":
      if (!args[0]) {
        console.error("Usage: meeting-cli.ts thread <id>");
        process.exit(1);
      }
      cmdThread(args[0]);
      break;
    case "retry":
      if (!args[0]) {
        console.error("Usage: meeting-cli.ts retry <id>");
        console.error("  Re-queues an error'd meeting for reprocessing.");
        process.exit(1);
      }
      {
        const m = getMeeting(args[0]);
        if (!m) { console.error(`  Not found. Run 'meeting-cli.ts list --state error' to see error'd meetings.`); process.exit(1); }
        if (m.state !== "error") { console.error(`  Meeting ${args[0]} is in state '${m.state}', not 'error'. Only error'd meetings can be retried.`); process.exit(1); }
        const target = m.transcript_id ? "transcript_received" : "registered";
        transitionState(args[0], target as any);
        console.log(c("green", "✓") + ` Meeting ${args[0]} retried → ${target}`);
      }
      break;
    case "questions": {
      const questions = getPendingQuestions();
      if (questions.length === 0) {
        console.log("  No pending entity questions.");
        break;
      }
      console.log(c("bold", `\n  Pending Entity Questions (${questions.length}):\n`));
      for (const q of questions) {
        const icon = q.type.includes("client") ? "🏢" :
          q.type.includes("contact") ? "👤" :
          q.type.includes("project") ? "📋" :
          q.type.includes("use_case") ? "🎯" : "❓";
        const ctx = JSON.parse(q.context || "{}");
        console.log(`  ${icon} ${c("yellow", q.id)}`);
        console.log(`    Type: ${q.type} | Name: ${c("bold", q.field)} | Meeting: ${q.meeting_id}`);
        if (ctx.client) console.log(`    Client: ${ctx.client}`);
        if (ctx.email) console.log(`    Email: ${ctx.email}`);
        console.log();
      }
      console.log(`  To resolve: bun meeting-cli.ts resolve <id> approve|skip`);
      console.log();
      break;
    }
    case "resolve": {
      if (!args[0] || !args[1]) {
        console.error("Usage: meeting-cli.ts resolve <question-id> approve|skip");
        process.exit(1);
      }
      const action = args[1] as "approve" | "skip";
      if (action !== "approve" && action !== "skip") {
        console.error("Action must be 'approve' or 'skip'");
        process.exit(1);
      }
      const ok = resolveEntityQuestion(args[0], action);
      if (ok) {
        console.log(c("green", "✓") + ` Question ${args[0]} → ${action}`);
      } else {
        console.error(`  Question ${args[0]} not found`);
        process.exit(1);
      }
      break;
    }
    default:
      console.log(`
  ${c("bold", "Meeting Pipeline v3 — CLI")}

  ${c("cyan", "Usage:")}
    bun meeting-cli.ts status                     Pipeline overview
    bun meeting-cli.ts list [--state X] [--client X]  List meetings
    bun meeting-cli.ts show <id>                  Meeting details
    bun meeting-cli.ts ingest                     Ingest calendar feed
    bun meeting-cli.ts sync [--month MM]          Scan new transcripts
    bun meeting-cli.ts thread <id>                Thread context
    bun meeting-cli.ts retry <id>                 Retry error'd meeting
    bun meeting-cli.ts questions                  Pending entity confirmations
    bun meeting-cli.ts resolve <id> approve|skip  Resolve entity question
`);
  }
} finally {
  closeDb();
}
