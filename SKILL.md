---
name: MeetingPipeline
description: Plaud meeting transcript processing pipeline. USE WHEN meeting pipeline, process transcript, analyze meeting, pipeline plaud, CR meeting, batch transcripts, auto process meetings, enrich meetings.
---

# Meeting Pipeline

Processes Plaud meeting transcripts into structured knowledge artifacts in the Obsidian vault, aligned with the AIQ framework.

## Core Paths

- **Obsidian Vault**: `~/Library/CloudStorage/ProtonDrive-omrane.senouci@proton.me-folder/03 - Ressources/Omrane Vault/`
- **Enabler prompts**: `{VAULT}/40 - Areas/AIQ Framework/Enabler - *.md`
- **Convention de Notes**: `{VAULT}/40 - Areas/AIQ Framework/AIQ - Convention de Notes.md`
- **Output meetings**: `{VAULT}/30 - Meetings/`
- **Output tasks**: `{VAULT}/Tasks/`
- **Transcripts**: `~/Library/CloudStorage/OneDrive-SharedLibraries-LumaiConsulting/Lumai Consulting - Documents/04 - Ressources/20 - Transcripts/2026/`
- **Editorial backlog**: `{VAULT}/20 - Projects/Editorial/Backlog Posts.md`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **AutoProcess v2** | "auto", "headless", "scheduled", "automatic mode" | `Workflows/AutoProcess.md` |
| **ProcessTranscript** | "process transcript", "pipeline meeting", "CR meeting" | `Workflows/ProcessTranscript.md` |

**v3 Backend:** SQLite on SharePoint: `OneDrive/.../20 - Transcripts/00 - Processing/meetings.db`
**CLI:** `bun ~/.claude/skills/MeetingPipeline/Tools/meeting-cli.ts {status|list|show|ingest|sync|thread|retry|questions|resolve}`

## Meeting Types (9)

| Phase | Type | Description |
|-------|------|------------|
| Business Dev | `discovery` | Exploration besoin, premier contact |
| Business Dev | `proposal` | Présentation offre, négociation |
| Launch | `kickoff` | Lancement projet, gouvernance, RACI |
| Delivery | `working-session` | Travail collaboratif sur livrable |
| Delivery | `coordination` | Sync opérationnelle, suivi, revue d'avancement, blockers |
| Delivery | `workshop` | Session facilitée avec méthodologie |
| Governance | `steering` | COPIL : décisions stratégiques, go/no-go |
| Continuous | `relationship` | Networking, QBR, informel |
| Continuous | `internal` | Équipe seule, pas de client |

## Enablers (8)

Detail in `EnablerReference.md`. Prompts in vault at `{VAULT}/40 - Areas/AIQ Framework/Enabler - *.md`.

| Step | Enabler | Condition | Model |
|------|---------|-----------|-------|
| 1 | Routing | Always | Opus (smart) |
| 2 | CR Obsidian | Always (Full or Light per type) | Opus (smart) |
| 3 | CR Formel | discovery, proposal, kickoff, workshop, coordination, steering | Opus (smart) |
| 4 | Infos + Actions | All except relationship | Opus (smart) |
| 5 | Coaching | discovery, proposal, steering | Opus (smart) |
| 6 | AIQ Extraction | discovery, workshop + phase besoin/discovery + UCs | Opus (smart) |
| 7 | Convictions | discovery, proposal, working-session, workshop, steering | Opus (smart) |
| 8 | Process Extraction | UCs identified, not relationship/internal | Opus (smart) |

## Automation Modes

| Workflow | Interaction | Enablers | Tracking |
|----------|------------|----------|----------|
| AutoProcess v2 | Zero interaction | All 8 inline (per type conditions) | SQLite meetings.db |
| ProcessTranscript | Interactive | All 8 (per type conditions) | SQLite meetings.db |

**Confidence threshold**: 0.9 across all workflows. Below 0.9 = error state (auto) or user confirmation (interactive).

## Examples

**Example 1: Automatic processing (primary mode)**
```
Scheduled via Cowork every 4h or: /MeetingPipeline auto
> Invokes AutoProcess v2 workflow
> Calendar ingest + transcript sync via meeting-cli.ts
> Routes each meeting (calendar pre-registration or LLM inference)
> All 8 enablers execute inline (per type conditions)
> CR written to Obsidian vault, state tracked in meetings.db
> Error alerts via Discord/Telegram
```

**Example 2: Process a single meeting interactively**
```
User: "Process the transcript from this morning's meeting with Suez"
> Invokes ProcessTranscript workflow
> Routing (Opus) identifies client, project, type, UCs
> 8 enablers execute sequentially per type conditions
> CR Obsidian + email + actions + coaching + AIQ + convictions + process extraction
> State tracked in meetings.db
```

**Example 3: Check pipeline status**
```
User: "What's the pipeline status?"
> bun meeting-cli.ts status
> Shows meetings by state (like git status)
> Pending questions, error count
```

**Example 4: Retry failed meeting**
```
User: "Retry the failed meeting from yesterday"
> bun meeting-cli.ts retry <id>
> Requeues meeting to transcript_received or registered
> Will be picked up by next auto-process run
```
