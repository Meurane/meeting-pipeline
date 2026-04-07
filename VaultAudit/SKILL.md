---
name: VaultAudit
description: Scan Obsidian vault for structural errors in meeting notes, fix safe issues, log root causes. USE WHEN vault audit, check vault, scan errors, fix frontmatter, dead links, quality check, verify meetings.
---

# VaultAudit

Post-pipeline quality control for the Obsidian vault. Detects structural errors in meeting notes, People stubs, UC stubs, and frontmatter. Can auto-fix safe issues and log root causes for correction at the source.

## Core Paths

- **Vault**: `~/Library/CloudStorage/ProtonDrive-omrane.senouci@proton.me-folder/03 - Ressources/Omrane Vault/`
- **Meetings**: `{VAULT}/30 - Meetings/`
- **People**: `{VAULT}/16 - People/`
- **Projects**: `{VAULT}/20 - Projects/`
- **Audit report**: `{VAULT}/40 - Areas/AIQ Framework/Vault Audit Report.md`
- **Audit rules**: `~/.claude/skills/VaultAudit/Data/audit-rules.json`
- **Meeting core**: `~/.claude/skills/MeetingPipeline/Tools/meeting-core.ts`

## Modes

| Mode | Behavior | Invocation |
|------|----------|------------|
| `scan` | Report errors only, no writes | `bun vault-audit.ts scan` |
| `fix` | Auto-fix safe issues + report | `bun vault-audit.ts scan --fix` |
| `dry-run` | Preview fixes without writing | `bun vault-audit.ts scan --dry-run` |
| `suggest` | Propose additions to canonical-entities | `bun vault-audit.ts suggest` |

## Checks Performed

| Check | Detection | Auto-fix | Root Cause Logged |
|-------|-----------|----------|-------------------|
| Dead wikilinks in CRs | `[[...]]` not resolving to file | Create stub (people/UC) | "Entity identified but no stub created" |
| Invalid `meeting_type` | Value not in 9 canonical types | Replace with fuzzy match | "LLM returned non-canonical type: {raw}" |
| Invalid `project_phase` | Value not in 7 phases | Remove field | "LLM returned invalid phase: {raw}" |
| Non-standard tags | Tag not in whitelist | Remove tag | "LLM injected free-form tag: {tag}" |
| Missing People notes | `[[Name]]` in participants, no file | Create stub | "Contact stub not created during pipeline" |
| Missing UC notes | `[[UC -- X]]` in CR, no file | Create stub | "UC stub not created (AIQ Extraction skipped)" |
| Missing frontmatter fields | CR missing required fields | Log only | "assembleFrontmatter produced incomplete output" |
| Unresolved entities | Name not in canonical-entities | Log + suggest | "Entity not in canonical registry" |
| Recurring unknowns | Same name in 3+ CRs, not canonical | Suggest add | "Recurring unresolved entity: {name}" |

## Examples

**Example 1: Scan vault for errors**
```
User: /VaultAudit scan
> bun vault-audit.ts scan
> Reports all errors found, grouped by category
```

**Example 2: Fix safe issues**
```
User: /VaultAudit fix
> bun vault-audit.ts scan --fix
> Creates missing stubs, fixes invalid frontmatter, writes report
```

**Example 3: Suggest canonical additions**
```
User: /VaultAudit suggest
> bun vault-audit.ts suggest
> Identifies recurring unresolved entities, proposes additions
```

## Workflow

1. Read audit rules from `Data/audit-rules.json`
2. Scan all meeting notes in `30 - Meetings/`
3. For each note: parse frontmatter, check wikilinks, validate fields
4. Cross-reference with `16 - People/` and `20 - Projects/` for dead links
5. Load canonical-entities.json for entity resolution checks
6. Generate report with errors, fixes applied, root causes
7. Write report to `{VAULT}/40 - Areas/AIQ Framework/Vault Audit Report.md`

## Invocation

```
/VaultAudit scan        # Report only
/VaultAudit fix         # Auto-fix + report
/VaultAudit suggest     # Canonical entity suggestions
```

Or run directly:
```bash
TOOLS_DIR="$HOME/.claude/skills/VaultAudit/Tools"
bun $TOOLS_DIR/vault-audit.ts scan [--fix] [--dry-run]
bun $TOOLS_DIR/vault-audit.ts suggest
```
