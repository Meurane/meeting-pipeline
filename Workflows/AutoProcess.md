# AutoProcess v3

Headless automatic meeting processing. Designed for scheduled execution via Cowork with zero user interaction. Uses SQLite `meetings.db` as backend.

## Architecture

**Orchestrator + Agent-per-meeting.** The main agent (this workflow) handles collection and listing. Each meeting is processed by a **dedicated spawned agent** with its own fresh context. This prevents context saturation when processing large backlogs.

```
Orchestrator (this workflow)
  ├── Step 0: Preflight
  ├── Step 1: Calendar extract + ingest + sync
  ├── Step 2: List all transcript_received meetings
  └── Step 3: For each meeting → spawn Agent
                                    ├── Route (LLM)
                                    ├── Entity gate (non-blocking)
                                    ├── Confidence gate
                                    ├── Enablers 1-7 inline
                                    └── Track in DB
```

## Design Principle

Better an imperfect CR than no CR at all. Every enabler that can run automatically runs inline. No deferred enrichment.

## Prerequisites

- ProtonDrive synced (Obsidian vault accessible)
- OneDrive synced (transcripts accessible)
- API keys in `.env` (Inference)
- `OneDrive/.../20 - Transcripts/00 - Processing/meetings.db` exists

## Tools

```bash
TOOLS_DIR="$HOME/.claude/skills/MeetingPipeline/Tools"
```

**IMPORTANT: NEVER use raw `sqlite3` commands.** All DB operations MUST go through the TypeScript API.

## Steps

### Step 0: Preflight

Verify vault and transcripts are online:
```bash
VAULT="$HOME/Library/CloudStorage/ProtonDrive-omrane.senouci@proton.me-folder/03 - Ressources/Omrane Vault/30 - Meetings"
TRANSCRIPTS="$HOME/Library/CloudStorage/OneDrive-SharedLibraries-LumaiConsulting/Lumai Consulting - Documents/04 - Ressources/20 - Transcripts"
```
Check both directories exist. If either is missing, STOP.

### Step 1: Calendar Extract + Ingest + Transcript Sync

```bash
bun $TOOLS_DIR/calendar-extract.ts daily   # extract today+tomorrow from macOS Calendar
bun $TOOLS_DIR/meeting-cli.ts ingest       # reads calendar-feed/*.json → registered
bun $TOOLS_DIR/meeting-cli.ts sync         # scans OneDrive → transcript_received
```

Note counts of new events, meetings ingested, and transcripts matched.

### Step 2: List meetings to process

Query ALL meetings needing processing:
```bash
bun $TOOLS_DIR/meeting-cli.ts list --state transcript_received --limit 200
```

Display the full backlog with date, client, calendar title, transcript ID.

### Step 3: Spawn agents for processing

**For each meeting in chronological order**, spawn a dedicated Agent using the Agent tool:

```
Agent(
  description: "Process meeting {ID}",
  subagent_type: "general-purpose",
  prompt: <MEETING_PROCESSING_PROMPT>,
  run_in_background: true
)
```

**Concurrency:** Spawn agents **one at a time** (sequential, not parallel). Wait for each agent to complete before spawning the next. This prevents DB write conflicts and ensures thread context is up-to-date for subsequent meetings with the same client.

**Alternative for large backlogs (50+ meetings):** Spawn up to **3 agents in parallel** if they are for DIFFERENT clients (no thread context dependency). Same-client meetings must remain sequential.

### Meeting Processing Prompt (for spawned agent)

Each agent receives this self-contained prompt with all context needed:

```
You are processing a single meeting for the MeetingPipeline v3. Zero interaction mode.

TOOLS_DIR="$HOME/.claude/skills/MeetingPipeline/Tools"
VAULT="$HOME/Library/CloudStorage/ProtonDrive-omrane.senouci@proton.me-folder/03 - Ressources/Omrane Vault"

## Meeting to process
- ID: {meeting_id}
- Date: {date}
- Client: {client or "unknown"}
- Calendar title: {calendar_title or "none"}
- Transcript ID: {transcript_id}
- Routing source: {routing_source}

## Instructions

Follow these steps exactly. Track each enabler in the DB as you go.

### 1. Read context
- Read the transcript: `{TRANSCRIPTS}/2026/{MM}/{transcript_id}_transcript.txt`
- Read the meta file: `{TRANSCRIPTS}/2026/{MM}/{transcript_id}_other.txt` or `_summary.txt`
- Read canonical entities: `$TOOLS_DIR/../Data/canonical-entities.json`
- Get thread context: `bun -e "import {getThreadContext} from '$TOOLS_DIR/meeting-core'; ..."`

### 2. Routing
- Read `{VAULT}/40 - Areas/AIQ Framework/Enabler - Routing.md`
- Build routing prompt with pre-registered metadata (if calendar) or transcript-only
- Call Inference Tool (level: smart, timeout: 180000)
- Parse JSON response

### 3. Entity gate (non-blocking)
- Call `detectNewEntities()` on routing output
- If new entities: `queueEntityQuestions()` + Discord notification
- Processing continues regardless

### 3b. Create UC stubs (MANDATORY)
After routing, create stub notes for any use cases that don't exist in the vault yet:
```bash
bun -e "
import {createUCStubs} from '$TOOLS_DIR/meeting-core';
const ucs = ROUTING_OUTPUT.use_cases.map(uc => typeof uc === 'string' ? uc : uc.name);
const result = createUCStubs(ucs, ROUTING_OUTPUT.project || null, ROUTING_OUTPUT.client || null);
console.log(JSON.stringify(result));
"
```
This ensures UC wikilinks in the CR resolve to actual notes, even when AIQ Extraction is skipped.

### 4. Confidence gate
- `is_meeting = false` → transition to 'skipped', STOP
- `confidence < 0.9` AND no calendar data → transition to 'error', STOP
- Otherwise → transition to 'routed'

### 5. Execute enablers
Transition to 'processing'. Read each enabler prompt from vault. Call Inference (level: smart, timeout: 180000).

**Enabler matrix (by meeting_type):**

| Enabler | Condition | Write to |
|---------|-----------|----------|
| CR Obsidian | Always (Full or Light per type) | {VAULT}/30 - Meetings/ |
| CR Formel | discovery, proposal, kickoff, workshop, coordination, steering | Callout in CR |
| Infos + Actions | All except relationship | Project journal + Tasks/ |
| Coaching | discovery, proposal, steering | Append to CR with [coaching_score:: N] |
| Convictions | discovery, proposal, working-session, workshop, steering | Convictions.md + Backlog Posts.md + CR summary [conviction_count:: N] |
| AIQ Extraction | discovery, workshop + UCs identified | UC note |
| Process Extraction | UCs identified, not relationship/internal | UC note |

For each enabler: `setEnabler('{meeting_id}', '{enabler_name}', 'done'|'skipped'|'failed')`

### 6. Finalize
- **Contact stubs** — programmatic, not textual instructions:
```bash
bun -e "
import {createContactStubs} from '$TOOLS_DIR/meeting-core';
const participants = ROUTING_OUTPUT.participants || [];
const result = createContactStubs(participants, ROUTING_OUTPUT.client || null);
console.log(JSON.stringify(result));
"
```
- **People sync** — enrich all contact notes with latest data:
```bash
bun $TOOLS_DIR/people-sync.ts sync
```
- Transition: processing → cr_written → enriched
- Report: which enablers ran, which skipped, stubs created, any errors

### 7. Frontmatter assembly
Use `assembleFrontmatter()` from meeting-core.ts (NOT manual YAML). Pass routing output + CR output.

### Key rules
- Use `bun -e "import {...} from '$TOOLS_DIR/meeting-core'; ..."` for all DB operations
- Use PAI Inference Tool for all LLM calls: `import {inference} from '$HOME/.claude/PAI/Tools/Inference'`
- CRs in meeting language, journal and coaching in English, convictions in French
- Override LLM date with meeting date from DB (LLM often returns today's date)
- Inline Dataview fields: [coaching_score:: N], [conviction_count:: N], [business_signal:: type], plus type-specific fields
```

### Step 4: Monitor progress

After spawning agents, periodically check status:
```bash
bun $TOOLS_DIR/meeting-cli.ts status
```

When all transcript_received meetings are processed (enriched or error), output summary.

### Step 5: Summary

```
AutoProcess v3 complete:
- Calendar: {n} events extracted, {m} ingested
- Transcripts: {n} new, {m} matched
- Processed: {p} meetings → {e} enriched, {s} skipped, {err} errors
- Pending questions: {q}
- Total in DB: {total}
```

## Rules

- **Zero interaction**: no questions, no confirmations
- **Chronological order**: oldest to newest
- **One agent per meeting**: fresh context, no accumulation
- **Sequential by default**: parallel only for different clients
- **ALL enablers inline**: no deferred enrichment
- **Track after each enabler**: resilient to interruptions
- **CRs in meeting language**, journal and coaching in English
- **Contact stubs created automatically** for unknown participants
- **Entity questions non-blocking**: Discord + questions table, processing continues

## Invocation

Scheduled via Cowork (every 4h) or manually:
```
/MeetingPipeline auto
```
