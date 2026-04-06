# ProcessTranscript

Interactive processing of a single meeting transcript through all 8 enablers.

## Required Context

Before starting, read from the vault:
- Enabler prompts: `{VAULT}/40 - Areas/AIQ Framework/Enabler - *.md`
- Convention de Notes: `{VAULT}/40 - Areas/AIQ Framework/AIQ - Convention de Notes.md`
- Enabler reference: `~/.claude/skills/MeetingPipeline/EnablerReference.md`

## Steps

### Step 1: Obtain transcript

Ask user to paste the transcript or provide a file path.
If pasted, save to `/tmp/meeting-transcript-{timestamp}.txt`.

### Step 2: Routing (Step 1 enabler)

**Precondition:** Transcript available.

1. Read `Enabler - Routing.md` for the system prompt
2. Build known entities roster by scanning the vault: clients, contacts, projects, UCs
3. Execute routing via PAI Inference Tool (`level: 'smart'`)
4. Expected output: JSON with date, heure, client, project, participants, summary, topics, use_cases, meeting_type, meeting_type_confidence, language, business_signals

**Interactive confirmation:**
```
Routing identified:
- Client: {client}
- Project: {project}
- Type: {meeting_type} (confidence: {confidence})
- Use cases: {use_cases}
- Participants: {participants}
```

- If `confidence < 0.9`: present the 9 meeting type options via AskUserQuestion, grouped by phase:
  **Business Development:**
  - discovery: Exploration besoin, premier contact, nouveau use case
  - proposal: Présentation offre, négociation scope/prix
  **Launch:**
  - kickoff: Lancement projet, gouvernance, RACI, cadence
  **Delivery:**
  - working-session: Travail collaboratif sur un livrable
  - coordination: Sync opérationnelle, blockers, status
  - workshop: Session facilitée avec méthodologie
  **Governance:**
  - steering: COPIL, décisions stratégiques, go/no-go
  **Continuous:**
  - relationship: Networking, QBR, informel, pas de projet
  - internal: Équipe seule, pas de client
- For each UC with `known: false`: ask user to confirm the name and project association

### Step 2b: Entity Confirmation Gate (MANDATORY)

**After routing, before any enabler runs**, detect new structural entities:

```bash
bun -e "import {detectNewEntities} from '$TOOLS_DIR/meeting-core'; console.log(JSON.stringify(detectNewEntities(ROUTING_OUTPUT, '<MEETING_ID>')))"
```

For each new entity detected, ask user via AskUserQuestion:

**New Client:** "Le routing a détecté un nouveau client: {name}. L'ajouter au registre ?"
- Approve → `addClient(name)` writes to canonical-entities.json
- Skip → meeting proceeds with client as raw string (no wikilink resolution)

**New Contact:** "Nouveau contact détecté: {name}. L'ajouter au registre ?"
- Approve → `addContact(name, {client, email})` writes to canonical-entities.json
- Skip → participant appears as `[[Raw Name]]` in CR (dead link until resolved)

**New Project/Mission:** "Nouveau projet détecté: {name}. L'ajouter au registre ?"
- Approve → `addProject(name, {client})` writes to canonical-entities.json
- Skip → project field stored as raw string

**New Use Case:** "Nouveau UC détecté: {name} (confidence: {conf}). L'ajouter ?"
- Approve → UC wikilink included in CR, note created later by AIQ Extraction
- Skip → UC excluded from CR frontmatter

Only proceed to enablers after ALL entity confirmations are resolved.

### Step 3: Resolve project_phase

**Precondition:** Routing confirmed.

1. If a project is identified, read frontmatter of `{VAULT}/20 - Projects/{Project}.md`
2. Look for `status` field (values: besoin, discovery, qualification, proposition, cadrage, delivery, mesure)
3. If field is missing or file doesn't exist: ask user with AskUserQuestion listing the 7 phases

### Step 4: Execute enablers (sequential)

Each enabler reads its prompt from the vault (`Enabler - *.md`).
Execute via PAI Inference Tool (`level: 'smart'` for Opus).

**Error handling:** If an enabler fails, log the error, continue with remaining enablers, report all errors in the summary.

#### Step 2 enabler — CR Obsidian (always)

- Read `Enabler - CR Obsidian.md`
- Generate DINA-structured CR
- Assemble frontmatter per Convention de Notes (fields: type, date, client, project, meeting_type, use_cases, participants, summary, project_phase, tags)
- Write to `{VAULT}/30 - Meetings/YYYY-MM-DD_HHmm {Client} - {Subject}.md`
- **Output:** file path created

#### Step 3 enabler — CR Formel (condition: meeting_type in {discovery, proposal, kickoff, workshop, coordination, steering})

- Read `Enabler - CR Formel.md`
- Generate professional email
- Present to user for review before copy/send
- Update CR frontmatter: `cr_formel: draft`
- **Output:** email subject + body
- **Skip for:** working-session, relationship, internal

#### Step 4 enabler — Infos + Actions (condition: meeting_type != relationship)

- Read `Enabler - Infos Actions.md`
- Extract key infos: append to project journal
- Extract actions: create individual task notes (Omrane only)
- Task frontmatter: Obsidian Tasks addon format (scheduled, projects array, dateCreated/dateModified ISO, tags, type: task)
- **Output:** count of infos + count of actions created
- **Skip for:** relationship only

#### Step 5 enabler — Coaching (condition: meeting_type in {discovery, proposal, steering})

- Read `Enabler - Coaching.md`
- Extract quantitative metrics (listening ratio, open questions, closing effectiveness, score /10)
- Append coaching section to CR Obsidian created in step 2 enabler, using `[coaching_score:: N]` inline Dataview field (not `- Score: N/10`)
- **Output:** raw score /10

#### Step 6 enabler — AIQ Extraction (condition: meeting_type in {discovery, workshop} AND project_phase in {besoin, discovery} AND UCs identified)

- Read `Enabler - AIQ Extraction.md`
- **For each UC identified** (1 call per UC):
  - If UC note exists: read existing data for incremental upsert
  - Execute extraction with WSJF rubrics (V, TC, RR with sub-scores, D/T/O, Effort T-shirt)
  - Upsert `## AIQ Qualification` section in UC note
  - If UC note doesn't exist: create with Convention de Notes template
- **Output:** count of UCs enriched + names
- **Skip for:** proposal, kickoff, working-session, coordination, steering, relationship, internal

#### Step 7 enabler — Convictions (condition: meeting_type in {discovery, proposal, working-session, workshop, steering})

- Read `Enabler - Convictions.md`
- Extract convictions/insights for LinkedIn
- If no convictions found (conviction_count = 0): skip silently
- Score >= 3: append to `{VAULT}/20 - Projects/Editorial/Convictions.md`
- Score >= 4: append to `{VAULT}/20 - Projects/Editorial/Backlog Posts.md` (Status: Idea)
- **Append summary to CR:** `## Convictions` section with `[conviction_count:: N]` inline Dataview field + one-line per conviction (hook + score + type). Omit section if 0 convictions.
- **Output:** count of convictions + count added to editorial backlog

#### Step 8 enabler — Process Extraction (condition: UCs identified, meeting_type not in {relationship, internal})

- Read `Enabler - Process Extraction.md`
- For each UC identified: extract process knowledge from transcript
- Append process intelligence to UC note
- If LLM returns `has_content: false`: skip write silently
- **Output:** count of UCs with process content extracted
- **Skip for:** relationship, internal, or meetings without UCs

### Step 5: Summary

```
Pipeline complete:
- CR Obsidian: {path}
- CR Formel: {email subject} (clipboard)
- Infos + Actions: {n} key infos, {m} actions created
- Coaching: score {raw_score}/10
- AIQ Extraction: {n} UC(s) enriched - {uc_names}
- Convictions: {n} identified, {m} added to editorial backlog
- Errors: {list or "none"}
```

### Step 5b: Contact stubs

After CR Obsidian, create stub notes for unknown participants:
- Read `participants` from CR frontmatter
- For each `[[Name]]`: check if `{VAULT}/16 - People/{Name}.md` exists
- If not, create stub (type: contact, company from routing, role blank)
- Skip Omrane Senouci (self)

### Step 6: Follow-up

- Offer to review/edit CR Formel before sending
- If UCs were created/enriched, offer to review WSJF scores
- If open questions were identified, list them for the next meeting

## Tracking

After all enablers complete, record the meeting in SQLite via meeting-core.ts:

```bash
TOOLS_DIR="$HOME/.claude/skills/MeetingPipeline/Tools"
bun -e "
import {transitionState, setEnabler, closeDb} from '$TOOLS_DIR/meeting-core';
transitionState('<ID>', 'enriched', {processed_at: new Date().toISOString(), enriched_at: new Date().toISOString(), cr_file: '<FILENAME.md>'});
setEnabler('<ID>', 'cr_obsidian', 'done');
setEnabler('<ID>', 'cr_formel', 'done');  // or 'skipped' if not applicable
setEnabler('<ID>', 'infos_actions', 'done');
setEnabler('<ID>', 'coaching', 'done');   // or 'skipped'
setEnabler('<ID>', 'aiq_extraction', 'done'); // or 'skipped'
setEnabler('<ID>', 'convictions', 'done');
setEnabler('<ID>', 'process_extraction', 'done'); // or 'skipped'
closeDb();
"
```

Adjust enabler status to reflect which actually ran (some are conditional on meeting_type).

## Rules

- Enablers execute sequentially (Step 5 Coaching appends to Step 2 CR)
- Each enabler uses its exact system prompt from the vault enabler file
- AIQ Extraction does upsert (merge), never replace
- CRs in meeting language, journal and coaching in English
- Convictions always in French (LinkedIn FR audience)
- Tasks for Omrane only, Obsidian Tasks addon format
