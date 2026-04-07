#!/usr/bin/env bun
/**
 * meeting-core.ts — Meeting Pipeline v3: types, paths, DB, CRUD, state machine,
 *                   notifications, and frontmatter assembly.
 *
 * Single source of truth for meeting entities. All state transitions go through here.
 * Consolidated from: meeting-lib.ts, meeting-core.ts, meeting-notify.ts, FrontmatterAssembler.ts
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

// ============================================================================
// --- Paths & Types ---
// ============================================================================

export const HOME = Bun.env.HOME!;

const ONEDRIVE_BASE = join(
  HOME,
  "Library/CloudStorage/OneDrive-SharedLibraries-LumaiConsulting",
  "Lumai Consulting - Documents/04 - Ressources/20 - Transcripts"
);

const PROCESSING_DIR = join(ONEDRIVE_BASE, "00 - Processing");

export const PATHS = {
  pipelineDir: PROCESSING_DIR,
  db: join(PROCESSING_DIR, "meetings.db"),
  calendarFeed: join(PROCESSING_DIR, "calendar-feed"),
  transcriptsBase: ONEDRIVE_BASE,
  vaultMeetings: join(
    HOME,
    "Library/CloudStorage/ProtonDrive-omrane.senouci@proton.me-folder",
    "03 - Ressources/Omrane Vault/30 - Meetings"
  ),
  vaultPeople: join(
    HOME,
    "Library/CloudStorage/ProtonDrive-omrane.senouci@proton.me-folder",
    "03 - Ressources/Omrane Vault/16 - People"
  ),
  canonicalEntities: join(import.meta.dir, "../Data/canonical-entities.json"),
} as const;

// --- Meeting States ---

export const MEETING_STATES = [
  "registered",
  "transcript_received",
  "routed",
  "processing",
  "cr_written",
  "enriched",
  "skipped",
  "error",
] as const;

export type MeetingState = (typeof MEETING_STATES)[number];

export const VALID_TRANSITIONS: Record<MeetingState, MeetingState[]> = {
  registered: ["transcript_received", "skipped", "error"],
  transcript_received: ["routed", "skipped", "error"],
  routed: ["processing", "skipped", "error"],
  processing: ["cr_written", "error"],
  cr_written: ["enriched", "error"],
  enriched: [],
  skipped: [],
  error: ["registered", "transcript_received", "routed", "processing"],
};

export function canTransition(from: MeetingState, to: MeetingState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// --- Meeting & Recording Types ---

export const MEETING_TYPES = [
  "discovery", "proposal", "kickoff", "working-session",
  "coordination", "workshop", "steering", "relationship", "internal",
] as const;

export type MeetingType = (typeof MEETING_TYPES)[number];

export const RECORDING_TYPES = ["meeting", "call", "note"] as const;
export type RecordingType = (typeof RECORDING_TYPES)[number];

// --- Enabler Types ---

export const ENABLER_NAMES = [
  "routing", "cr_obsidian", "cr_formel", "infos_actions",
  "coaching", "convictions", "aiq_extraction", "process_extraction",
] as const;

export type EnablerName = (typeof ENABLER_NAMES)[number];
export type EnablerStatus = "pending" | "running" | "done" | "failed" | "skipped";

// --- Calendar Feed Types ---

export interface CalendarAttendee {
  name: string;
  email: string;
  required?: boolean;
}

export interface CalendarEvent {
  outlook_id: string;
  title: string;
  date: string;       // YYYY-MM-DD
  time_start: string;  // HHmm
  time_end?: string;
  organizer?: string;
  attendees: CalendarAttendee[];
  body?: string;
  location?: string;
  is_recurring?: boolean;
  categories?: string[];
}

export interface CalendarFeedFile {
  events: CalendarEvent[];
  synced_at: string;
  source: string;
}

// --- Canonical Entities ---

export interface CanonicalEntities {
  clients: Record<string, { wikilink: string; aliases: string[] }>;
  projects: Record<string, { wikilink: string; client: string; aliases: string[] }>;
  contacts: Record<
    string,
    {
      aliases: string[];
      client: string | null;
      is_self?: boolean;
      needs_resolution?: boolean;
      calendar_email?: string;
    }
  >;
  meeting_types: string[];
}

export function loadCanonicalEntities(): CanonicalEntities {
  if (!existsSync(PATHS.canonicalEntities)) {
    return { clients: {}, projects: {}, contacts: {}, meeting_types: [] };
  }
  return JSON.parse(readFileSync(PATHS.canonicalEntities, "utf-8"));
}

// ============================================================================
// --- Utility Functions ---
// ============================================================================

export function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function generateMeetingId(
  date: string,
  timeStart: string,
  clientSlug?: string
): string {
  const slug = clientSlug
    ? norm(clientSlug).replace(/\s+/g, "-").slice(0, 20)
    : "unknown";
  return `${date}T${timeStart}_${slug}`;
}

/**
 * Extract time from Plaud meta file header.
 * Handles formats: "12h31", "2026-04-02 17:16:35", "2026-04-01 09:17"
 */
export function extractTimeFromMeta(content: string): string | null {
  const isoMatch = content.match(/\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2})(?::\d{2})?/);
  if (isoMatch) return `${isoMatch[1]}${isoMatch[2]}`;

  const frMatch = content.match(/(\d{1,2})h(\d{2})/);
  if (frMatch) return `${frMatch[1].padStart(2, "0")}${frMatch[2]}`;

  const colonMatch = content.match(/(?:heure|time)\s*[:=]\s*(\d{1,2}):(\d{2})/i);
  if (colonMatch) return `${colonMatch[1].padStart(2, "0")}${colonMatch[2]}`;

  return null;
}

/** Extract date from transcript ID (e.g. "2026-04-03_Reunion" -> "2026-04-03") */
export function extractDateFromTranscriptId(id: string): string | null {
  const m = id.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Calculate time difference in minutes between two HHmm strings */
export function timeDiffMinutes(t1: string, t2: string): number {
  const m1 = parseInt(t1.slice(0, 2)) * 60 + parseInt(t1.slice(2));
  const m2 = parseInt(t2.slice(0, 2)) * 60 + parseInt(t2.slice(2));
  const diff = Math.abs(m1 - m2);
  return Math.min(diff, 1440 - diff);
}

// ============================================================================
// --- Validation & Normalization ---
// ============================================================================

const VALID_PROJECT_PHASES = [
  "besoin", "discovery", "qualification", "proposition",
  "cadrage", "delivery", "mesure",
] as const;

/**
 * Fuzzy-match a raw meeting_type string from LLM to canonical type.
 * Handles common LLM variations like "Discovery meeting", "sync", "copil", etc.
 */
export function normalizeMeetingType(raw: string): MeetingType {
  if (!raw) return "coordination";
  const n = norm(raw);

  // Exact match first
  if ((MEETING_TYPES as readonly string[]).includes(n)) return n as MeetingType;

  // Common LLM variations → canonical mapping
  const aliases: Record<string, MeetingType> = {
    "sync": "coordination",
    "synchronisation": "coordination",
    "point": "coordination",
    "standup": "coordination",
    "status": "coordination",
    "suivi": "coordination",
    "revue": "coordination",
    "review": "coordination",
    "copil": "steering",
    "comite de pilotage": "steering",
    "comite": "steering",
    "gouvernance": "steering",
    "atelier": "workshop",
    "session de travail": "working-session",
    "travail": "working-session",
    "lancement": "kickoff",
    "kick-off": "kickoff",
    "decouverte": "discovery",
    "exploration": "discovery",
    "premier contact": "discovery",
    "offre": "proposal",
    "proposition": "proposal",
    "negociation": "proposal",
    "networking": "relationship",
    "informel": "relationship",
    "qbr": "relationship",
    "equipe": "internal",
    "interne": "internal",
  };

  // Direct alias match
  if (aliases[n]) return aliases[n];

  // Substring match: check if raw contains a known type or alias
  for (const mt of MEETING_TYPES) {
    if (n.includes(mt)) return mt;
  }
  for (const [alias, mt] of Object.entries(aliases)) {
    if (n.includes(alias)) return mt;
  }

  // Fallback
  console.warn(`[meeting-core] Unknown meeting_type "${raw}", defaulting to coordination`);
  return "coordination";
}

/**
 * Validate project_phase against known values. Returns null if invalid.
 */
export function normalizeProjectPhase(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const n = norm(raw);
  if ((VALID_PROJECT_PHASES as readonly string[]).includes(n)) return n;

  // Common variations
  const phaseAliases: Record<string, string> = {
    "besoin": "besoin",
    "besoins": "besoin",
    "need": "besoin",
    "needs": "besoin",
    "decouverte": "discovery",
    "explore": "discovery",
    "qualif": "qualification",
    "qualifying": "qualification",
    "proposal": "proposition",
    "offre": "proposition",
    "framing": "cadrage",
    "setup": "cadrage",
    "execution": "delivery",
    "production": "delivery",
    "run": "delivery",
    "measurement": "mesure",
    "measure": "mesure",
    "bilan": "mesure",
  };

  if (phaseAliases[n]) return phaseAliases[n];

  console.warn(`[meeting-core] Invalid project_phase "${raw}", dropping`);
  return null;
}

/** Resolve a client name against canonical entities */
export function resolveClient(
  raw: string,
  entities: CanonicalEntities
): string | null {
  const n = norm(raw);
  for (const [name, data] of Object.entries(entities.clients)) {
    if (norm(name) === n || data.aliases.some((a) => norm(a) === n)) {
      return name;
    }
  }
  return null;
}

/** Resolve a contact name/email against canonical entities */
export function resolveContact(
  nameOrEmail: string,
  entities: CanonicalEntities
): string | null {
  const n = norm(nameOrEmail);
  for (const [name, data] of Object.entries(entities.contacts)) {
    if (norm(name) === n) return name;
    if (data.aliases.some((a) => norm(a) === n)) return name;
    if (data.calendar_email && norm(data.calendar_email) === n) return name;
  }
  return null;
}

// ============================================================================
// --- Database ---
// ============================================================================

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  if (!existsSync(PATHS.pipelineDir)) {
    mkdirSync(PATHS.pipelineDir, { recursive: true });
  }

  const dbPath = PATHS.db;
  // DB is on OneDrive (SharePoint) by design — single-writer guaranteed (CLI tools only).
  // Block other cloud providers that have worse sync semantics.
  if (/Dropbox|iCloud/.test(dbPath)) {
    throw new Error(`FATAL: meetings.db is on ${dbPath}. Only OneDrive/SharePoint is supported.`);
  }

  _db = new Database(dbPath, { create: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA busy_timeout = 5000");
  _db.exec("PRAGMA foreign_keys = ON");
  initSchema(_db);

  try { require("fs").chmodSync(dbPath, 0o600); } catch {}

  return _db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'registered',
      type TEXT NOT NULL DEFAULT 'meeting',

      client TEXT,
      project TEXT,
      meeting_type TEXT,
      participants TEXT,
      routing_confidence REAL,
      routing_source TEXT,

      transcript_id TEXT,
      transcript_path TEXT,

      calendar_event_id TEXT UNIQUE,
      calendar_title TEXT,
      calendar_agenda TEXT,

      cr_file TEXT,
      summary TEXT,

      thread_previous TEXT,

      date TEXT NOT NULL,
      time_start TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processed_at TEXT,
      enriched_at TEXT
    );

    CREATE TABLE IF NOT EXISTS enablers (
      meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      enabler TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      PRIMARY KEY (meeting_id, enabler)
    );

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      field TEXT,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_state ON meetings(state);
    CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
    CREATE INDEX IF NOT EXISTS idx_meetings_client ON meetings(client);
    CREATE INDEX IF NOT EXISTS idx_meetings_calendar_event ON meetings(calendar_event_id);
    CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
  `);

  // Schema migrations — add columns if missing (safe for existing DBs)
  const cols = new Set(
    (db.query("PRAGMA table_info('meetings')").all() as Array<{ name: string }>)
      .map(c => c.name)
  );
  if (!cols.has("time_end")) db.exec("ALTER TABLE meetings ADD COLUMN time_end TEXT");
  if (!cols.has("duration_min")) db.exec("ALTER TABLE meetings ADD COLUMN duration_min INTEGER");
  if (!cols.has("calendar_attendees")) db.exec("ALTER TABLE meetings ADD COLUMN calendar_attendees TEXT");
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================================
// --- CRUD ---
// ============================================================================

export interface CreateMeetingOpts {
  id?: string;
  state?: MeetingState;
  type?: RecordingType;
  date: string;
  time_start?: string;
  time_end?: string;
  duration_min?: number;
  client?: string;
  project?: string;
  meeting_type?: string;
  participants?: string[];
  calendar_attendees?: CalendarAttendee[];
  routing_confidence?: number;
  routing_source?: string;
  transcript_id?: string;
  transcript_path?: string;
  calendar_event_id?: string;
  calendar_title?: string;
  calendar_agenda?: string;
  cr_file?: string;
  summary?: string;
}

export interface MeetingRow {
  id: string;
  state: MeetingState;
  type: RecordingType;
  client: string | null;
  project: string | null;
  meeting_type: string | null;
  participants: string | null;  // JSON array of canonical names
  calendar_attendees: string | null;  // JSON array of {name, email}
  routing_confidence: number | null;
  routing_source: string | null;
  transcript_id: string | null;
  transcript_path: string | null;
  calendar_event_id: string | null;
  calendar_title: string | null;
  calendar_agenda: string | null;
  cr_file: string | null;
  summary: string | null;
  thread_previous: string | null;
  date: string;
  time_start: string | null;
  time_end: string | null;
  duration_min: number | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
  enriched_at: string | null;
}

export function createMeeting(opts: CreateMeetingOpts): string {
  const db = getDb();
  const now = nowISO();
  const id =
    opts.id || generateMeetingId(opts.date, opts.time_start || "0000", opts.client);

  // Dedup by calendar_event_id — upsert: update date, participants, attendees, times
  if (opts.calendar_event_id) {
    const existing = db
      .query("SELECT id, date FROM meetings WHERE calendar_event_id = ?")
      .get(opts.calendar_event_id) as { id: string; date: string } | null;
    if (existing) {
      const updates: string[] = ["updated_at = ?"];
      const params: any[] = [nowISO()];
      if (opts.date && opts.date !== existing.date) {
        updates.push("date = ?"); params.push(opts.date);
      }
      if (opts.time_start) { updates.push("time_start = ?"); params.push(opts.time_start); }
      if (opts.time_end) { updates.push("time_end = ?"); params.push(opts.time_end); }
      if (opts.duration_min != null) { updates.push("duration_min = ?"); params.push(opts.duration_min); }
      if (opts.calendar_title) { updates.push("calendar_title = ?"); params.push(opts.calendar_title); }
      if (opts.calendar_agenda) { updates.push("calendar_agenda = ?"); params.push(opts.calendar_agenda); }
      if (opts.participants && opts.participants.length > 0) {
        updates.push("participants = ?"); params.push(JSON.stringify(opts.participants));
      }
      if (opts.calendar_attendees && opts.calendar_attendees.length > 0) {
        updates.push("calendar_attendees = ?"); params.push(JSON.stringify(opts.calendar_attendees));
      }
      if (opts.client) { updates.push("client = ?"); params.push(opts.client); }
      if (opts.routing_confidence != null) { updates.push("routing_confidence = ?"); params.push(opts.routing_confidence); }
      params.push(existing.id);
      db.query(`UPDATE meetings SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return existing.id;
    }
  }

  // Dedup by id
  const existingById = db
    .query("SELECT id FROM meetings WHERE id = ?")
    .get(id) as { id: string } | null;
  if (existingById) return existingById.id;

  db.query(`
    INSERT INTO meetings (
      id, state, type, date, time_start, time_end, duration_min,
      client, project, meeting_type, participants, calendar_attendees,
      routing_confidence, routing_source,
      transcript_id, transcript_path,
      calendar_event_id, calendar_title, calendar_agenda,
      cr_file, summary,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?
    )
  `).run(
    id,
    opts.state || "registered",
    opts.type || "meeting",
    opts.date,
    opts.time_start || null,
    opts.time_end || null,
    opts.duration_min ?? null,
    opts.client || null,
    opts.project || null,
    opts.meeting_type || null,
    opts.participants ? JSON.stringify(opts.participants) : null,
    opts.calendar_attendees ? JSON.stringify(opts.calendar_attendees) : null,
    opts.routing_confidence ?? null,
    opts.routing_source || null,
    opts.transcript_id || null,
    opts.transcript_path || null,
    opts.calendar_event_id || null,
    opts.calendar_title || null,
    opts.calendar_agenda || null,
    opts.cr_file || null,
    opts.summary || null,
    now,
    now
  );

  return id;
}

export function getMeeting(id: string): MeetingRow | null {
  const db = getDb();
  return db.query("SELECT * FROM meetings WHERE id = ?").get(id) as MeetingRow | null;
}

export function listMeetings(filters?: {
  state?: MeetingState;
  client?: string;
  date?: string;
  limit?: number;
}): MeetingRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: any[] = [];

  if (filters?.state) {
    clauses.push("state = ?");
    params.push(filters.state);
  }
  if (filters?.client) {
    clauses.push("client = ?");
    params.push(filters.client);
  }
  if (filters?.date) {
    clauses.push("date = ?");
    params.push(filters.date);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const hasLimit = filters?.limit && Number.isFinite(filters.limit) && filters.limit > 0;
  if (hasLimit) params.push(Math.min(filters!.limit!, 1000));

  return db
    .query(`SELECT * FROM meetings ${where} ORDER BY date DESC, time_start DESC ${hasLimit ? "LIMIT ?" : ""}`)
    .all(...params) as MeetingRow[];
}

// ============================================================================
// --- State Machine ---
// ============================================================================

export function transitionState(
  id: string,
  newState: MeetingState,
  updates?: Partial<
    Pick<
      MeetingRow,
      | "client" | "project" | "meeting_type" | "participants"
      | "routing_confidence" | "routing_source" | "transcript_id"
      | "transcript_path" | "cr_file" | "summary" | "thread_previous"
      | "processed_at" | "enriched_at"
    >
  >
): boolean {
  const db = getDb();
  const meeting = getMeeting(id);
  if (!meeting) throw new Error(`Meeting ${id} not found`);

  if (!canTransition(meeting.state, newState)) {
    throw new Error(
      `Invalid transition: ${meeting.state} -> ${newState} for meeting ${id}`
    );
  }

  const ALLOWED_TRANSITION_COLUMNS = new Set([
    "client", "project", "meeting_type", "participants",
    "routing_confidence", "routing_source", "transcript_id",
    "transcript_path", "cr_file", "summary", "thread_previous",
    "processed_at", "enriched_at",
  ]);

  const setClauses = ["state = ?", "updated_at = ?"];
  const params: any[] = [newState, nowISO()];

  if (updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && ALLOWED_TRANSITION_COLUMNS.has(key)) {
        setClauses.push(`${key} = ?`);
        params.push(
          key === "participants" && Array.isArray(value)
            ? JSON.stringify(value)
            : value
        );
      }
    }
  }

  params.push(id);
  db.query(`UPDATE meetings SET ${setClauses.join(", ")} WHERE id = ?`).run(
    ...params
  );
  return true;
}

const ALLOWED_UPDATE_COLUMNS = new Set([
  "state", "type", "client", "project", "meeting_type", "participants",
  "calendar_attendees", "routing_confidence", "routing_source",
  "transcript_id", "transcript_path",
  "calendar_event_id", "calendar_title", "calendar_agenda", "cr_file",
  "summary", "thread_previous", "date", "time_start", "time_end",
  "duration_min", "updated_at", "processed_at", "enriched_at",
]);

export function updateMeeting(
  id: string,
  fields: Record<string, any>
): boolean {
  const db = getDb();
  const setClauses: string[] = ["updated_at = ?"];
  const params: any[] = [nowISO()];

  for (const [key, value] of Object.entries(fields)) {
    if (key === "id" || key === "created_at") continue;
    if (!ALLOWED_UPDATE_COLUMNS.has(key)) continue;
    setClauses.push(`${key} = ?`);
    params.push(
      (key === "participants" || key === "thread_previous" || key === "calendar_attendees") &&
        value !== null && typeof value === "object"
        ? JSON.stringify(value)
        : value
    );
  }

  params.push(id);
  const result = db
    .query(`UPDATE meetings SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...params);
  return result.changes > 0;
}

// ============================================================================
// --- Enablers ---
// ============================================================================

export function setEnabler(
  meetingId: string,
  enabler: string,
  status: EnablerStatus,
  error?: string
): void {
  const db = getDb();
  const now = nowISO();

  db.query(`
    INSERT INTO enablers (meeting_id, enabler, status, started_at, completed_at, error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(meeting_id, enabler) DO UPDATE SET
      status = excluded.status,
      started_at = COALESCE(enablers.started_at, excluded.started_at),
      completed_at = excluded.completed_at,
      error = excluded.error
  `).run(
    meetingId,
    enabler,
    status,
    status === "running" || status === "done" || status === "failed" ? now : null,
    status === "done" || status === "failed" ? now : null,
    error || null
  );
}

export function getEnablers(
  meetingId: string
): Array<{ enabler: string; status: string; error: string | null }> {
  const db = getDb();
  return db
    .query("SELECT enabler, status, error FROM enablers WHERE meeting_id = ?")
    .all(meetingId) as Array<{
    enabler: string;
    status: string;
    error: string | null;
  }>;
}

// ============================================================================
// --- Calendar Ingest ---
// ============================================================================

/**
 * Parse attendee name from calendar format "LastName, FirstName (ext)" → "FirstName LastName".
 * Also handles "LastName, FirstName" without suffix.
 */
export function parseAttendeeName(raw: string): string {
  // "Kababa, Nathalie (ext)" → "Nathalie Kababa"
  const match = raw.match(/^([^,]+),\s*([^(]+?)(?:\s*\(.*\))?$/);
  if (match) return `${match[2].trim()} ${match[1].trim()}`;
  // Already "FirstName LastName" or single name
  return raw.trim();
}

export function ingestCalendarFeed(): {
  inserted: number;
  updated: number;
  files: string[];
} {
  const feedDir = PATHS.calendarFeed;
  if (!existsSync(feedDir)) return { inserted: 0, updated: 0, files: [] };

  const files = readdirSync(feedDir).filter((f) => f.endsWith(".json"));
  let inserted = 0;
  let updated = 0;
  const entities = loadCanonicalEntities();

  for (const file of files) {
    const content = readFileSync(join(feedDir, file), "utf-8");
    let feed: CalendarFeedFile;
    try {
      feed = JSON.parse(content);
    } catch (e) {
      console.error(`WARNING: Skipping malformed calendar feed ${file}: ${e}`);
      continue;
    }

    for (const event of feed.events) {
      // Resolve client from title or attendee domains
      let client: string | null = null;
      for (const [name] of Object.entries(entities.clients)) {
        if (
          norm(event.title).includes(norm(name)) ||
          event.attendees.some((a) => norm(a.email).includes(norm(name)))
        ) {
          client = name;
          break;
        }
      }

      // Resolve participants: parse names, resolve against canonical, filter self
      const participants: string[] = [];
      const rawAttendees: CalendarAttendee[] = [];
      for (const att of event.attendees) {
        rawAttendees.push({ name: att.name, email: att.email });
        const parsed = parseAttendeeName(att.name);
        const resolved = resolveContact(att.email, entities) ||
          resolveContact(parsed, entities) ||
          resolveContact(att.name, entities) ||
          parsed;
        // Filter self
        const contact = entities.contacts[resolved];
        if (contact?.is_self) continue;
        participants.push(resolved);
      }

      // Compute duration from time_start and time_end
      let durationMin: number | undefined;
      if (event.time_start && event.time_end) {
        const s = parseInt(event.time_start.slice(0, 2)) * 60 + parseInt(event.time_start.slice(2));
        const e = parseInt(event.time_end.slice(0, 2)) * 60 + parseInt(event.time_end.slice(2));
        durationMin = e > s ? e - s : undefined;
      }

      const alreadyExists = event.outlook_id
        ? getDb().query("SELECT id FROM meetings WHERE calendar_event_id = ?").get(event.outlook_id)
        : null;

      createMeeting({
        state: "registered",
        date: event.date,
        time_start: event.time_start,
        time_end: event.time_end,
        duration_min: durationMin,
        client,
        participants,
        calendar_attendees: rawAttendees,
        routing_source: "calendar",
        routing_confidence: client ? 0.95 : 0.5,
        calendar_event_id: event.outlook_id,
        calendar_title: event.title,
        calendar_agenda: event.body || null,
      });

      if (alreadyExists) {
        updated++;
      } else {
        inserted++;
      }
    }
  }

  // After ingest, reconcile orphan transcripts with newly ingested calendar entries
  const reconciled = reconcileOrphans();
  if (reconciled.matched > 0) {
    console.log(`  Reconciled: ${reconciled.matched} transcripts matched to calendar entries`);
  }
  if (reconciled.ambiguous > 0) {
    console.log(`  Ambiguous: ${reconciled.ambiguous} transcripts need manual matching`);
  }

  return { inserted, updated, files };
}

// ============================================================================
// --- Transcript Sync ---
// ============================================================================

export function syncTranscripts(month?: string): {
  newTranscripts: number;
  matched: number;
} {
  const currentYear = new Date().getFullYear();
  const years = month ? [currentYear.toString()] : [currentYear.toString(), (currentYear - 1).toString()];

  const monthsPerYear: Array<{ year: string; month: string }> = [];
  for (const yr of years) {
    const yearDir = join(PATHS.transcriptsBase, yr);
    if (!existsSync(yearDir)) continue;
    const dirs = month
      ? [month]
      : readdirSync(yearDir).filter((d) => /^\d{2}$/.test(d));
    for (const m of dirs) monthsPerYear.push({ year: yr, month: m });
  }

  let newTranscripts = 0;
  let matched = 0;
  const db = getDb();

  for (const { year, month: m } of monthsPerYear) {
    const monthDir = join(PATHS.transcriptsBase, year, m);
    if (!existsSync(monthDir)) continue;

    const files = readdirSync(monthDir).filter((f) =>
      f.endsWith("_transcript.txt")
    );

    for (const file of files) {
      const transcriptId = file.replace("_transcript.txt", "");
      const transcriptPath = join(monthDir, file);

      const existing = db
        .query("SELECT id FROM meetings WHERE transcript_id = ?")
        .get(transcriptId) as { id: string } | null;
      if (existing) continue;

      const date = extractDateFromTranscriptId(transcriptId);
      if (!date) continue;

      let timeStart: string | null = null;
      for (const suffix of ["_summary.txt", "_other.txt"]) {
        const metaPath = join(monthDir, transcriptId + suffix);
        if (existsSync(metaPath)) {
          const metaContent = readFileSync(metaPath, "utf-8").slice(0, 500);
          timeStart = extractTimeFromMeta(metaContent);
          if (timeStart) break;
        }
      }

      const matchResult = matchTranscriptToRegistered(date, timeStart);

      if (matchResult) {
        transitionState(matchResult.id, "transcript_received", {
          transcript_id: transcriptId,
          transcript_path: transcriptPath,
        });
        matched++;
      } else {
        createMeeting({
          state: "transcript_received",
          date,
          time_start: timeStart || undefined,
          transcript_id: transcriptId,
          transcript_path: transcriptPath,
          type: "meeting",
        });
        newTranscripts++;
      }
    }
  }

  // After sync, reconcile orphan transcripts with calendar entries
  const reconciled = reconcileOrphans();
  if (reconciled.matched > 0) {
    console.log(`  Reconciled: ${reconciled.matched} transcripts matched to calendar entries`);
    matched += reconciled.matched;
  }

  return { newTranscripts, matched };
}

function matchTranscriptToRegistered(
  date: string,
  timeStart: string | null
): MeetingRow | null {
  const db = getDb();

  const candidates = db
    .query(
      "SELECT * FROM meetings WHERE date = ? AND state = 'registered' AND transcript_id IS NULL"
    )
    .all(date) as MeetingRow[];

  if (candidates.length === 0) return null;
  if (candidates.length === 1 && !timeStart) return candidates[0]; // Tier 2: trivial 1:1
  if (!timeStart) return null; // Multiple candidates, no time → can't decide

  // Tier 3: time-based matching (30-min window, Plaud time ≈ calendar start + 1-2 min)
  const scored = candidates
    .filter((c) => c.time_start)
    .map((c) => ({
      meeting: c,
      diff: timeDiffMinutes(timeStart, c.time_start!),
    }))
    .filter((s) => s.diff <= 30)
    .sort((a, b) => a.diff - b.diff);

  if (scored.length === 1) return scored[0].meeting;
  // Ambiguity check: best must be 5+ min better than second
  if (scored.length > 1 && scored[0].diff < scored[1].diff - 5) {
    return scored[0].meeting;
  }

  return null;
}

// ============================================================================
// --- Reconcile Orphans ---
// ============================================================================

/**
 * 4-tier reconciliation: matches orphan transcript entries to unmatched calendar entries.
 * Called after both ingest and sync to be order-independent.
 *
 * Tier 1: Date partition
 * Tier 2: Trivial 1:1 (1 transcript + 1 calendar on same date)
 * Tier 3: Time-based greedy (30-min window, ambiguity check)
 * Tier 4: Elimination (remaining no-time transcript + single remaining calendar)
 */
export function reconcileOrphans(): {
  matched: number;
  ambiguous: number;
  ambiguousDetails: Array<{ transcript_id: string; date: string; candidates: string[] }>;
} {
  const db = getDb();
  let matched = 0;
  let ambiguous = 0;
  const ambiguousDetails: Array<{ transcript_id: string; date: string; candidates: string[] }> = [];

  // Get all orphan transcripts (have transcript_id but no calendar_event_id)
  const orphanTx = db.query(
    "SELECT * FROM meetings WHERE transcript_id IS NOT NULL AND calendar_event_id IS NULL AND state IN ('transcript_received', 'routed', 'processing')"
  ).all() as MeetingRow[];

  if (orphanTx.length === 0) return { matched: 0, ambiguous: 0, ambiguousDetails: [] };

  // Group by date
  const txByDate = new Map<string, MeetingRow[]>();
  for (const tx of orphanTx) {
    const list = txByDate.get(tx.date) || [];
    list.push(tx);
    txByDate.set(tx.date, list);
  }

  for (const [date, transcripts] of txByDate) {
    // Get unmatched calendar entries on same date
    const calendars = db.query(
      "SELECT * FROM meetings WHERE date = ? AND calendar_event_id IS NOT NULL AND transcript_id IS NULL AND state = 'registered'"
    ).all(date) as MeetingRow[];

    if (calendars.length === 0) continue;

    const matchedTxIds = new Set<string>();
    const matchedCalIds = new Set<string>();

    // Tier 2: trivial 1:1
    if (transcripts.length === 1 && calendars.length === 1) {
      mergeTranscriptIntoCalendar(transcripts[0], calendars[0]);
      matched++;
      continue;
    }

    // Tier 3: time-based greedy
    type ScoredPair = { tx: MeetingRow; cal: MeetingRow; diff: number };
    const pairs: ScoredPair[] = [];
    for (const tx of transcripts) {
      if (!tx.time_start) continue;
      for (const cal of calendars) {
        if (!cal.time_start) continue;
        const diff = timeDiffMinutes(tx.time_start, cal.time_start);
        if (diff <= 30) pairs.push({ tx, cal, diff });
      }
    }
    pairs.sort((a, b) => a.diff - b.diff);

    for (const pair of pairs) {
      if (matchedTxIds.has(pair.tx.id) || matchedCalIds.has(pair.cal.id)) continue;
      // Check ambiguity: any rival pair with same tx within 5 min?
      const rivals = pairs.filter(
        p => p.tx.id === pair.tx.id && p.cal.id !== pair.cal.id && Math.abs(p.diff - pair.diff) < 5
      );
      if (rivals.length > 0) {
        ambiguous++;
        ambiguousDetails.push({
          transcript_id: pair.tx.transcript_id!,
          date,
          candidates: [pair.cal.calendar_title || pair.cal.id, ...rivals.map(r => r.cal.calendar_title || r.cal.id)],
        });
        matchedTxIds.add(pair.tx.id); // Skip this transcript
        continue;
      }
      mergeTranscriptIntoCalendar(pair.tx, pair.cal);
      matchedTxIds.add(pair.tx.id);
      matchedCalIds.add(pair.cal.id);
      matched++;
    }

    // Tier 4: elimination for no-time transcripts
    const remainTx = transcripts.filter(t => !t.time_start && !matchedTxIds.has(t.id));
    const remainCal = calendars.filter(c => !matchedCalIds.has(c.id));
    if (remainTx.length === 1 && remainCal.length === 1) {
      mergeTranscriptIntoCalendar(remainTx[0], remainCal[0]);
      matched++;
    }
  }

  // Send Discord notification for ambiguous matches
  if (ambiguousDetails.length > 0) {
    const msg = ambiguousDetails.map(a =>
      `**${a.date}** — \`${a.transcript_id}\`\nCandidates: ${a.candidates.join(", ")}`
    ).join("\n\n");
    notifyDiscord(
      `Matching ambigu: ${ambiguousDetails.length} transcripts`,
      msg,
      16776960 // yellow
    ).catch(() => {});
  }

  return { matched, ambiguous, ambiguousDetails };
}

/**
 * Merge a transcript-only entry INTO a calendar entry.
 * Copies transcript fields to the calendar row, then deletes the orphan transcript row.
 */
function mergeTranscriptIntoCalendar(txRow: MeetingRow, calRow: MeetingRow): void {
  const db = getDb();
  db.transaction(() => {
    db.query(`
      UPDATE meetings SET
        transcript_id = ?,
        transcript_path = ?,
        state = 'transcript_received',
        updated_at = ?
      WHERE id = ?
    `).run(txRow.transcript_id, txRow.transcript_path, nowISO(), calRow.id);
    db.query("UPDATE enablers SET meeting_id = ? WHERE meeting_id = ?").run(calRow.id, txRow.id);
    db.query("DELETE FROM meetings WHERE id = ?").run(txRow.id);
  })();
}

// ============================================================================
// --- Thread Detection ---
// ============================================================================

export function getThreadContext(
  client: string,
  date: string,
  limit: number = 5
): Array<{
  id: string;
  date: string;
  summary: string | null;
  participants: string | null;
  meeting_type: string | null;
  calendar_title: string | null;
}> {
  const db = getDb();
  return db
    .query(
      `SELECT id, date, summary, participants, meeting_type, calendar_title
       FROM meetings
       WHERE client = ?
         AND date >= date(?, '-30 days')
         AND date < ?
         AND state IN ('cr_written', 'enriched')
       ORDER BY date DESC
       LIMIT ?`
    )
    .all(client, date, date, limit) as any[];
}

// ============================================================================
// --- Stats ---
// ============================================================================

export function getStats(): Record<string, number> {
  const db = getDb();
  const rows = db
    .query("SELECT state, COUNT(*) as count FROM meetings GROUP BY state")
    .all() as Array<{ state: string; count: number }>;

  const stats: Record<string, number> = { total: 0 };
  for (const row of rows) {
    stats[row.state] = row.count;
    stats.total += row.count;
  }

  const qRow = db
    .query("SELECT COUNT(*) as count FROM questions WHERE status = 'pending'")
    .get() as { count: number };
  stats.pending_questions = qRow.count;

  return stats;
}

// ============================================================================
// --- Discord Notifications ---
// ============================================================================

/**
 * Send a Discord webhook notification.
 * Reads DISCORD_WEBHOOK_URL from environment. Returns false if not configured or on failure.
 */
export async function notifyDiscord(
  title: string,
  message: string,
  color?: number
): Promise<boolean> {
  const url = Bun.env.DISCORD_WEBHOOK_URL;
  if (!url) return false;

  const embed = {
    title,
    description: message.slice(0, 4000),
    color: color || 3447003,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// --- Frontmatter Assembly ---
// ============================================================================

interface FrontmatterRouting {
  client?: string;
  project?: string;
  meeting_type?: string;
  participants?: string[];
  use_cases?: string[];
  confidence?: number;
  project_phase?: string;
  business_signals?: any[];
}

interface FrontmatterCROutput {
  tags?: string[];
  use_cases?: string[];
  summary?: string;
}

const CR_FORMEL_PENDING = ["discovery", "proposal", "kickoff", "workshop", "steering"];
const CR_FORMEL_AUTO_DRAFT = ["coordination"];

/** Resolve client name to wikilink via canonical entities */
function resolveClientWikilink(raw: string, entities: CanonicalEntities): string {
  const n = norm(raw);
  for (const [name, data] of Object.entries(entities.clients)) {
    if (norm(name) === n || data.aliases.some(a => norm(a) === n)) {
      return data.wikilink;
    }
  }
  return `[[${raw}]]`;
}

/** Resolve project name to wikilink via canonical entities */
function resolveProjectWikilink(raw: string, clientName: string, entities: CanonicalEntities): string {
  const n = norm(raw);
  for (const [name, data] of Object.entries(entities.projects)) {
    if (norm(name) === n || data.aliases.some(a => norm(a) === n)) {
      return data.wikilink;
    }
    if (data.client === clientName && data.aliases.some(a => n.includes(norm(a)))) {
      return data.wikilink;
    }
  }
  return `[[${raw}]]`;
}

/** Resolve participant name to wikilink via canonical entities */
function resolveParticipantWikilink(raw: string, entities: CanonicalEntities): string {
  const n = norm(raw);
  const self = Object.entries(entities.contacts).find(([_, d]) => d.is_self);
  if (self && (norm(self[0]) === n || self[1].aliases.some(a => norm(a) === n))) {
    return `[[${self[0]}]]`;
  }
  for (const [name] of Object.entries(entities.contacts)) {
    if (norm(name) === n) return `[[${name}]]`;
  }
  for (const [name, data] of Object.entries(entities.contacts)) {
    if (data.aliases.some(a => norm(a) === n)) return `[[${name}]]`;
  }
  return `[[${raw}]]`;
}

/**
 * Build deterministic YAML frontmatter for a meeting CR.
 * Normalizes wikilinks against canonical-entities.json. No LLM involved.
 */
export function assembleFrontmatter(
  routing: FrontmatterRouting,
  crOutput: FrontmatterCROutput,
  transcriptId: string
): string {
  const entities = loadCanonicalEntities();

  const clientRaw = routing.client || "Unknown";
  const client = resolveClientWikilink(clientRaw, entities);
  const project = resolveProjectWikilink(routing.project || clientRaw, clientRaw, entities);

  // Normalize meeting_type — deterministic, no LLM pass-through
  const meetingType = normalizeMeetingType(routing.meeting_type || "coordination");

  const crFormel = CR_FORMEL_PENDING.includes(meetingType) ? "pending"
    : CR_FORMEL_AUTO_DRAFT.includes(meetingType) ? "auto-draft"
    : "skipped";

  const participants = (routing.participants || [])
    .map(p => resolveParticipantWikilink(p, entities))
    .filter((v, i, a) => a.indexOf(v) === i);

  // Use cases: normalize to "[[UC — Name]]" format (em dash, not double hyphen)
  const useCases = (crOutput.use_cases || routing.use_cases || [])
    .map(uc => {
      // Strip existing wikilink/prefix syntax
      let clean = uc.replace(/^\[\[/, "").replace(/\]\]$/, "")
        .replace(/^UC\s*[—–-]{1,2}\s*/i, "").trim();
      return `"[[UC — ${clean}]]"`;
    })
    .filter((v, i, a) => a.indexOf(v) === i);

  const summary = (crOutput.summary || "").slice(0, 120);

  // Tags: deterministic — meeting + normalized meeting_type only. No LLM tags.
  const tags = ["meeting", meetingType];

  const dateMatch = transcriptId.match(/^(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

  // Normalize project_phase — strict validation, null if invalid
  const projectPhase = normalizeProjectPhase(routing.project_phase);

  // Build YAML
  const lines: string[] = [
    "---",
    "type: meeting",
    `date: ${date}`,
    `source_transcript: "${transcriptId}"`,
    "pipeline_version: 3",
    `cr_formel: ${crFormel}`,
    `client: ${client.startsWith('"') ? client : `"${client}"`}`,
    `project: ${project.startsWith('"') ? project : `"${project}"`}`,
    `meeting_type: ${meetingType}`,
  ];

  if (useCases.length > 0) {
    lines.push("use_cases:");
    for (const uc of useCases) lines.push(`  - ${uc}`);
  } else {
    lines.push("use_cases: []");
  }

  if (participants.length > 0) {
    lines.push("participants:");
    for (const p of participants) lines.push(`  - "${p.replace(/"/g, '\\"')}"`);
  } else {
    lines.push("participants: []");
  }

  // Escape quotes and newlines for valid YAML
  lines.push(`summary: "${summary.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '')}"`);

  if (projectPhase) {
    lines.push(`project_phase: ${projectPhase}`);
  }

  lines.push("tags:");
  for (const t of tags) lines.push(`  - ${t}`);

  lines.push("---");

  return lines.join("\n");
}

// ============================================================================
// --- Entity Confirmation Gates ---
// ============================================================================

export interface NewEntity {
  type: "client" | "contact" | "project" | "use_case";
  name: string;
  context: Record<string, any>; // email, meeting_id, source, etc.
}

/**
 * Detect new structural entities from routing output that don't exist in canonical-entities.json.
 * Returns list of unknowns requiring confirmation before creation.
 */
export function detectNewEntities(
  routingOutput: {
    client?: string | null;
    project?: string | null;
    participants?: string[];
    use_cases?: Array<{ name: string; known: boolean; confidence?: number }>;
  },
  meetingId: string
): NewEntity[] {
  const entities = loadCanonicalEntities();
  const newEntities: NewEntity[] = [];

  // Check client
  if (routingOutput.client) {
    const resolved = resolveClient(routingOutput.client, entities);
    if (!resolved) {
      newEntities.push({
        type: "client",
        name: routingOutput.client,
        context: { meeting_id: meetingId, source: "routing" },
      });
    }
  }

  // Check project
  if (routingOutput.project) {
    const n = norm(routingOutput.project);
    const known = Object.entries(entities.projects).some(
      ([name, data]) => norm(name) === n || data.aliases.some(a => norm(a) === n)
    );
    if (!known) {
      newEntities.push({
        type: "project",
        name: routingOutput.project,
        context: { meeting_id: meetingId, client: routingOutput.client, source: "routing" },
      });
    }
  }

  // Check participants
  if (routingOutput.participants) {
    for (const participant of routingOutput.participants) {
      const resolved = resolveContact(participant, entities);
      if (!resolved) {
        // Skip self-like names
        if (norm(participant).includes("omrane") || norm(participant).includes("oman")) continue;
        newEntities.push({
          type: "contact",
          name: participant,
          context: { meeting_id: meetingId, source: "routing" },
        });
      }
    }
  }

  // Check use cases (only those flagged as unknown)
  if (routingOutput.use_cases) {
    for (const uc of routingOutput.use_cases) {
      if (!uc.known) {
        newEntities.push({
          type: "use_case",
          name: uc.name,
          context: { meeting_id: meetingId, confidence: uc.confidence, source: "routing" },
        });
      }
    }
  }

  return newEntities;
}

/**
 * Queue unknown entities as HITL questions in the DB.
 * Used by AutoProcess to continue without blocking.
 */
export function queueEntityQuestions(
  meetingId: string,
  newEntities: NewEntity[]
): number {
  const db = getDb();
  let queued = 0;

  for (const entity of newEntities) {
    const id = `${meetingId}_${entity.type}_${norm(entity.name).replace(/\s+/g, "-").slice(0, 30)}`;
    db.query(`
      INSERT OR IGNORE INTO questions (id, meeting_id, type, field, context, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id,
      meetingId,
      `new_${entity.type}`,
      entity.name,
      JSON.stringify(entity.context),
      nowISO()
    );
    queued++;
  }

  return queued;
}

/**
 * Get all pending entity questions.
 */
export function getPendingQuestions(): Array<{
  id: string;
  meeting_id: string;
  type: string;
  field: string;
  context: string;
  status: string;
  created_at: string;
}> {
  const db = getDb();
  return db
    .query("SELECT * FROM questions WHERE status = 'pending' ORDER BY created_at DESC")
    .all() as any[];
}

/**
 * Resolve an entity question: approve (add to canonical) or skip.
 */
export function resolveEntityQuestion(
  questionId: string,
  action: "approve" | "skip",
  overrides?: Record<string, any>
): boolean {
  const db = getDb();
  const q = db.query("SELECT * FROM questions WHERE id = ?").get(questionId) as any;
  if (!q) return false;

  if (action === "approve") {
    const context = JSON.parse(q.context || "{}");
    const entityName = overrides?.name || q.field;

    switch (q.type) {
      case "new_contact":
        addContact(entityName, {
          client: overrides?.client || context.client || null,
          calendar_email: overrides?.email || context.email,
        });
        break;
      case "new_client":
        addClient(entityName, { aliases: overrides?.aliases || [] });
        break;
      case "new_project":
        addProject(entityName, {
          client: overrides?.client || context.client || null,
          aliases: overrides?.aliases || [],
        });
        break;
      case "new_use_case":
        // UCs are wikilinks in CRs — no canonical entry needed, just acknowledge
        break;
    }
  }

  db.query("UPDATE questions SET status = ?, answer = ?, resolved_at = ? WHERE id = ?")
    .run(action === "approve" ? "resolved" : "skipped", action, nowISO(), questionId);
  return true;
}

// --- Canonical Entities Write Functions ---

/**
 * Atomically save canonical entities to JSON file.
 * Writes to temp file then renames to prevent corruption.
 */
function saveCanonicalEntities(entities: CanonicalEntities): void {
  const tmpPath = PATHS.canonicalEntities + ".tmp";
  const content = JSON.stringify(entities, null, 2) + "\n";
  require("fs").writeFileSync(tmpPath, content);
  require("fs").renameSync(tmpPath, PATHS.canonicalEntities);
}

export function addContact(
  name: string,
  opts: { client?: string | null; calendar_email?: string; aliases?: string[] }
): void {
  const entities = loadCanonicalEntities();
  if (entities.contacts[name]) return; // Never overwrite existing
  entities.contacts[name] = {
    aliases: opts.aliases || [],
    client: opts.client || null,
    ...(opts.calendar_email ? { calendar_email: opts.calendar_email } : {}),
  };
  saveCanonicalEntities(entities);
}

export function addClient(
  name: string,
  opts: { aliases?: string[]; wikilink?: string }
): void {
  const entities = loadCanonicalEntities();
  if (entities.clients[name]) return;
  entities.clients[name] = {
    wikilink: opts.wikilink || `[[${name}]]`,
    aliases: opts.aliases || [norm(name)],
  };
  saveCanonicalEntities(entities);
}

export function addProject(
  name: string,
  opts: { client?: string | null; aliases?: string[]; wikilink?: string }
): void {
  const entities = loadCanonicalEntities();
  if (entities.projects[name]) return;
  entities.projects[name] = {
    wikilink: opts.wikilink || `[[${name}]]`,
    client: opts.client || "",
    aliases: opts.aliases || [],
  };
  saveCanonicalEntities(entities);
}

// ============================================================================
// --- Stub Creation (UC + Contact) ---
// ============================================================================

const VAULT_BASE = join(
  HOME,
  "Library/CloudStorage/ProtonDrive-omrane.senouci@proton.me-folder",
  "03 - Ressources/Omrane Vault"
);

/**
 * Create stub notes for use cases that don't exist yet in the vault.
 * Called after routing, before enablers. Follows Convention de Notes UC schema.
 *
 * @param useCases - Array of UC names (without "UC — " prefix or wikilink syntax)
 * @param projectName - Project name for frontmatter linkage
 * @param clientName - Client name for folder resolution
 * @returns Object with created and skipped counts + paths
 */
export function createUCStubs(
  useCases: string[],
  projectName: string | null,
  clientName: string | null
): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];

  if (!useCases || useCases.length === 0) return { created, skipped };

  // Resolve project folder — Convention: 20 - Projects/{Project}/Use Cases/
  const projectDir = projectName
    ? join(VAULT_BASE, "20 - Projects", projectName)
    : null;
  const ucDir = projectDir
    ? join(projectDir, "Use Cases")
    : join(VAULT_BASE, "20 - Projects", "Use Cases");

  if (!existsSync(ucDir)) {
    mkdirSync(ucDir, { recursive: true });
  }

  const entities = loadCanonicalEntities();
  const today = new Date().toISOString().slice(0, 10);

  for (const rawUC of useCases) {
    // Normalize: strip "UC — ", "UC -- ", "UC - " prefix and wikilink syntax if present
    let ucName = rawUC
      .replace(/^\[\[/, "").replace(/\]\]$/, "")
      .replace(/^UC\s*[—–]+\s*/i, "")  // em dash, en dash
      .replace(/^UC\s*-{1,2}\s*/i, "")  // single/double hyphen
      .trim();
    if (!ucName) continue;

    // Sanitize filename: replace / \ : * ? " < > | with -
    const safeName = ucName.replace(/[/\\:*?"<>|]/g, "-");
    const fileName = `UC — ${safeName}.md`;
    const filePath = join(ucDir, fileName);

    if (existsSync(filePath)) {
      skipped.push(ucName);
      continue;
    }

    // Also check if file exists elsewhere in vault (search by name)
    const altPaths = [
      join(VAULT_BASE, "20 - Projects", fileName),
    ];
    if (altPaths.some(p => existsSync(p))) {
      skipped.push(ucName);
      continue;
    }

    // Build stub from Convention de Notes UC schema
    const projectWikilink = projectName
      ? resolveProjectWikilink(projectName, clientName || "", entities)
      : "";
    const projectField = projectWikilink
      ? `project: "${projectWikilink}"`
      : `project: ""`;

    const stub = [
      "---",
      "type: use-case",
      projectField,
      'function: ""',
      "status: besoin",
      'owner: ""',
      "decision: null",
      `created: ${today}`,
      "---",
      "",
      `# UC — ${ucName}`,
      "",
      "## Résumé",
      "",
      "*À compléter après le premier échange.*",
      "",
      "## AIQ Qualification",
      "",
      "> En attente de qualification.",
      "",
      "## Historique des échanges",
      "",
      "## Notes & Décisions",
      "",
      "## Prochaines étapes",
      "",
    ].join("\n");

    require("fs").writeFileSync(filePath, stub);
    created.push(ucName);
  }

  return { created, skipped };
}

/**
 * Create stub People notes for participants that don't have vault entries.
 * Called after CR is written. Follows Convention de Notes Contact schema.
 *
 * @param participants - Array of participant names (canonical or raw)
 * @param clientName - Client name for company field
 * @returns Object with created and skipped counts
 */
export function createContactStubs(
  participants: string[],
  clientName: string | null
): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];

  if (!participants || participants.length === 0) return { created, skipped };

  const entities = loadCanonicalEntities();
  const peopleDir = PATHS.vaultPeople;

  if (!existsSync(peopleDir)) {
    mkdirSync(peopleDir, { recursive: true });
  }

  for (const rawName of participants) {
    // Strip wikilink syntax
    const name = rawName.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/"/g, "").trim();
    if (!name) continue;

    // Skip self
    const contact = entities.contacts[name];
    if (contact?.is_self) continue;
    const selfEntry = Object.entries(entities.contacts).find(([_, d]) => d.is_self);
    if (selfEntry && (norm(selfEntry[0]) === norm(name) || selfEntry[1].aliases.some(a => norm(a) === norm(name)))) continue;

    const filePath = join(peopleDir, `${name}.md`);
    if (existsSync(filePath)) {
      skipped.push(name);
      continue;
    }

    // Resolve company wikilink
    const companyWikilink = clientName
      ? resolveClientWikilink(clientName, entities)
      : '""';

    const stub = [
      "---",
      "type: contact",
      `company: "${companyWikilink}"`,
      'role: ""',
      "---",
      "",
      `# ${name}`,
      "",
      "## Bio",
      `- Entreprise : ${companyWikilink}`,
      "- Rôle : ",
      "- Contexte : ",
      "",
      "## Notes",
      "",
    ].join("\n");

    require("fs").writeFileSync(filePath, stub);
    created.push(name);
  }

  return { created, skipped };
}
