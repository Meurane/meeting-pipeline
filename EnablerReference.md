# Enabler Reference

Reference documentation for the 8 enablers in the Meeting Pipeline. Each enabler has its full system prompt in the Obsidian vault.

## Vault Path

All enabler prompts: `{VAULT}/40 - Areas/AIQ Framework/Enabler - *.md`
Convention de Notes: `{VAULT}/40 - Areas/AIQ Framework/AIQ - Convention de Notes.md`

Where `{VAULT}` is the Obsidian vault path from SKILL.md Core Paths.

## Meeting Types (9)

| Phase | Type | Description |
|-------|------|------------|
| Business Dev | `discovery` | Exploration besoin, premier contact |
| Business Dev | `proposal` | Présentation offre, négociation |
| Launch | `kickoff` | Lancement projet, gouvernance, RACI |
| Delivery | `working-session` | Travail collaboratif sur livrable |
| Delivery | `coordination` | Sync opérationnelle, suivi, revue avancement, blockers |
| Delivery | `workshop` | Session facilitée avec méthodologie |
| Governance | `steering` | COPIL : décisions stratégiques |
| Continuous | `relationship` | Networking, QBR, informel |
| Continuous | `internal` | Équipe seule, pas de client |

## Enabler Trigger Matrix

| Step | Enabler | discovery | proposal | kickoff | working-session | coordination | workshop | steering | relationship | internal |
|------|---------|-----------|----------|---------|----------------|--------------|----------|----------|--------------|----------|
| 1 | Routing (+biz signals) | Always | Always | Always | Always | Always | Always | Always | Always | Always |
| 2 | CR Obsidian | Full | Full | Full | Full | Light | Full | Full | Light | Light |
| 3 | CR Formel | Yes | Yes | Yes | No | Yes | Yes | Yes | No | No |
| 4 | Infos + Actions | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No | Yes |
| 5 | Coaching | Yes | Yes | No | No | No | No | Yes | No | No |
| 6 | AIQ Extraction | Yes* | No | No | No | No | Yes* | No | No | No |
| 7 | Convictions | Yes | Yes | No | Yes | No | Yes | Yes | No | No |
| 8 | Process Extraction | Yes* | Yes* | Yes* | Yes* | Yes* | Yes* | Yes* | No | No |

*AIQ Extraction: only if project_phase in {besoin, discovery} AND UCs identified.
*Process Extraction: only if UCs identified. Skips write if LLM returns has_content: false.

**CR Depth:**
- **Full** = Complete DINA (Infos, Décisions, Informations, Prochaines étapes, Alertes, Signaux)
- **Light** = Infos + Décisions + Prochaines étapes (skip others if sparse)

## Enabler Summary

| Step | Name | File | Model | Condition | Output |
|------|------|------|-------|-----------|--------|
| 1 | Routing | `Enabler - Routing.md` | Opus (smart) | Always | JSON: entities, type, UCs, confidence, business_signals |
| 2 | CR Obsidian | `Enabler - CR Obsidian.md` | Opus (smart) | Always (Full or Light per type) | DINA meeting note in Meetings/ |
| 3 | CR Formel | `Enabler - CR Formel.md` | Opus (smart) | discovery, proposal, kickoff, workshop, coordination, steering | Professional email draft |
| 4 | Infos + Actions | `Enabler - Infos Actions.md` | Opus (smart) | All except relationship | Project journal + task files |
| 5 | Coaching | `Enabler - Coaching.md` | Opus (smart) | discovery, proposal, steering | Coaching metrics appended to CR |
| 6 | AIQ Extraction | `Enabler - AIQ Extraction.md` | Opus (smart) | discovery, workshop + phase besoin/discovery + UCs | AIQ Qualification in UC note |
| 7 | Convictions | `Enabler - Convictions.md` | Opus (smart) | discovery, proposal, working-session, workshop, steering | LinkedIn insights to vault + editorial backlog |
| 8 | Process Extraction | `Enabler - Process Extraction.md` | Opus (smart) | UC-tagged meetings (all types except relationship, internal) | Process intelligence appended to UC note |

## Automation Classification

| Step | Enabler | Auto-safe | Reason |
|------|---------|-----------|--------|
| 1 | Routing | Yes | Deterministic extraction, confidence-gated |
| 2 | CR Obsidian | Yes | Deterministic template, no external side effects |
| 3 | CR Formel | No | External email requires human review |
| 4 | Infos + Actions | Yes | Automated extraction, internal vault writes only |
| 5 | Coaching | Yes | Append-only to CR, internal self-reflection, no external side effects |
| 6 | AIQ Extraction | No | Accumulative upsert, errors propagate across meetings |
| 7 | Convictions | Yes | Vault append (Convictions.md) + editorial backlog append (Backlog Posts.md), all internal writes |
| 8 | Process Extraction | Yes | Append-only to UC notes, no data loss risk, skips if no content |

## Enabler File Structure

All enabler files follow the same template:

```
# Enabler — {Name}
> Step {N} | Model: {standard|smart} | Condition: {when to execute}

## System Prompt       — The actual prompt sent to the LLM
## Output Schema       — JSON fields the LLM must produce
## Write Rules         — Where each output field is written
## Language            — Input/output language rules
## Validation          — Hard limits and constraints to check post-inference
```

## Confidence Threshold

**Unified to 0.9 across all workflows:**
- ProcessTranscript: below 0.9 = ask user to confirm
- AutoProcess v2: below 0.9 AND no calendar data = move to `error` state with note "low confidence routing"

## Language Rules

| Output | Language |
|--------|----------|
| CR Obsidian | Meeting language |
| CR Formel | Meeting language |
| Infos + Actions (journal, tasks) | English |
| Coaching metrics | English |
| AIQ Extraction | English |
| Convictions | French (LinkedIn FR audience) |
| Process Extraction | Meeting language |
