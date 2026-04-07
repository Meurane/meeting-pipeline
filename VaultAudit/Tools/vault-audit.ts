#!/usr/bin/env bun
/**
 * vault-audit.ts — Post-pipeline quality control for Obsidian vault.
 *
 * Scans meeting notes for structural errors (dead wikilinks, invalid frontmatter,
 * missing stubs), optionally auto-fixes safe issues, and logs root causes.
 *
 * Usage:
 *   bun vault-audit.ts scan              # Report only
 *   bun vault-audit.ts scan --fix        # Auto-fix safe issues + report
 *   bun vault-audit.ts scan --dry-run    # Preview fixes without writing
 *   bun vault-audit.ts suggest           # Propose canonical entity additions
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { join, basename } from "path";
import {
  norm,
  loadCanonicalEntities,
  normalizeMeetingType,
  normalizeProjectPhase,
  createUCStubs,
  createContactStubs,
  PATHS,
  MEETING_TYPES,
} from "../../MeetingPipeline/Tools/meeting-core";

// ============================================================================
// --- Paths & Config ---
// ============================================================================

const HOME = Bun.env.HOME!;
const VAULT_BASE = join(
  HOME,
  "Library/CloudStorage/ProtonDrive-omrane.senouci@proton.me-folder",
  "03 - Ressources/Omrane Vault"
);
const MEETINGS_DIR = join(VAULT_BASE, "30 - Meetings");
const PEOPLE_DIR = join(VAULT_BASE, "16 - People");
const PROJECTS_DIR = join(VAULT_BASE, "20 - Projects");
const REPORT_PATH = join(VAULT_BASE, "40 - Areas/AIQ Framework/Vault Audit Report.md");

const RULES_PATH = join(import.meta.dir, "../Data/audit-rules.json");

interface AuditRules {
  valid_meeting_types: string[];
  valid_project_phases: string[];
  tags_whitelist: string[];
  required_frontmatter_fields: string[];
  stub_templates: Record<string, Record<string, any>>;
  self_names: string[];
  recurring_threshold: number;
}

function loadRules(): AuditRules {
  return JSON.parse(readFileSync(RULES_PATH, "utf-8"));
}

// ============================================================================
// --- Frontmatter Parser ---
// ============================================================================

interface ParsedNote {
  filePath: string;
  fileName: string;
  frontmatter: Record<string, any>;
  body: string;
  raw: string;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fm: Record<string, any> = {};
  const lines = match[1].split("\n");
  let currentKey = "";
  let inArray = false;
  const arrayValues: string[] = [];

  for (const line of lines) {
    if (inArray) {
      if (line.match(/^\s+-\s+/)) {
        arrayValues.push(line.replace(/^\s+-\s+/, "").replace(/^"|"$/g, ""));
        continue;
      } else {
        fm[currentKey] = [...arrayValues];
        inArray = false;
        arrayValues.length = 0;
      }
    }

    const kvMatch = line.match(/^(\w[\w_-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value === "" || value === "[]") {
        fm[currentKey] = value === "[]" ? [] : "";
      } else {
        fm[currentKey] = value.replace(/^"|"$/g, "");
      }
    } else if (line.match(/^\s+-\s+/) && currentKey) {
      if (!inArray) {
        inArray = true;
        arrayValues.length = 0;
      }
      arrayValues.push(line.replace(/^\s+-\s+/, "").replace(/^"|"$/g, ""));
    }
  }
  if (inArray && currentKey) {
    fm[currentKey] = [...arrayValues];
  }

  return { frontmatter: fm, body: match[2] };
}

// ============================================================================
// --- Issue Types ---
// ============================================================================

interface AuditIssue {
  file: string;
  category: string;
  severity: "error" | "warning" | "info";
  message: string;
  rootCause: string;
  autoFixable: boolean;
  fixed?: boolean;
}

// ============================================================================
// --- Wikilink Extraction ---
// ============================================================================

function extractWikilinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g) || [];
  return matches.map(m => m.replace(/^\[\[/, "").replace(/(?:\|[^\]]+)?\]\]$/, "").replace(/#.*$/, ""));
}

function isUCWikilink(link: string): boolean {
  return /^UC\s*[—–-]/i.test(link);
}

function ucNameFromWikilink(link: string): string {
  return link
    .replace(/^UC\s*[—–]+\s*/i, "")  // em dash, en dash (one or more)
    .replace(/^UC\s*-{1,2}\s*/i, "")  // single/double hyphen
    .trim();
}

// ============================================================================
// --- File Resolution ---
// ============================================================================

/** Check if a wikilink resolves to an existing file anywhere in the vault */
function resolveWikilink(link: string): string | null {
  // Normalize UC format: try both "UC -- Name" and "UC — Name" variants, and sanitized filenames
  const variants = [link];
  if (isUCWikilink(link)) {
    const ucName = ucNameFromWikilink(link);
    const safeName = ucName.replace(/[/\\:*?"<>|]/g, "-");
    variants.push(`UC — ${ucName}`);       // em dash
    variants.push(`UC -- ${ucName}`);      // double hyphen
    if (safeName !== ucName) {
      variants.push(`UC — ${safeName}`);   // em dash + sanitized
    }
  }

  for (const variant of variants) {
    // People
    const peoplePath = join(PEOPLE_DIR, `${variant}.md`);
    if (existsSync(peoplePath)) return peoplePath;

    // Direct file in various locations
    const searchDirs = [MEETINGS_DIR, PROJECTS_DIR, VAULT_BASE];
    for (const dir of searchDirs) {
      const p = join(dir, `${variant}.md`);
      if (existsSync(p)) return p;
    }

    // UC in project subfolders
    if (existsSync(PROJECTS_DIR)) {
      for (const proj of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        const ucPath = join(PROJECTS_DIR, proj.name, "Use Cases", `${variant}.md`);
        if (existsSync(ucPath)) return ucPath;
      }
    }
  }

  return null;
}

// ============================================================================
// --- Core Audit Logic ---
// ============================================================================

function auditMeetingNote(note: ParsedNote, rules: AuditRules): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const fm = note.frontmatter;

  // Skip non-meeting notes
  if (fm.type !== "meeting") return issues;

  // 1. Required frontmatter fields
  for (const field of rules.required_frontmatter_fields) {
    if (!fm[field] && fm[field] !== 0) {
      issues.push({
        file: note.fileName,
        category: "missing_field",
        severity: "error",
        message: `Missing required frontmatter field: ${field}`,
        rootCause: "assembleFrontmatter produced incomplete output",
        autoFixable: false,
      });
    }
  }

  // 2. Invalid meeting_type
  if (fm.meeting_type) {
    const raw = fm.meeting_type.toString();
    if (!(rules.valid_meeting_types as string[]).includes(raw)) {
      const normalized = normalizeMeetingType(raw);
      issues.push({
        file: note.fileName,
        category: "invalid_meeting_type",
        severity: "error",
        message: `Invalid meeting_type "${raw}", should be "${normalized}"`,
        rootCause: `LLM returned non-canonical type: ${raw}`,
        autoFixable: true,
      });
    }
  }

  // 3. Invalid project_phase
  if (fm.project_phase) {
    const raw = fm.project_phase.toString();
    const normalized = normalizeProjectPhase(raw);
    if (!normalized) {
      issues.push({
        file: note.fileName,
        category: "invalid_project_phase",
        severity: "warning",
        message: `Invalid project_phase "${raw}"`,
        rootCause: `LLM returned invalid phase: ${raw}`,
        autoFixable: true,
      });
    }
  }

  // 4. Non-standard tags
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  for (const tag of tags) {
    const cleanTag = tag.replace(/^#/, "").replace(/^type\//, "");
    if (!rules.tags_whitelist.includes(cleanTag)) {
      issues.push({
        file: note.fileName,
        category: "non_standard_tag",
        severity: "warning",
        message: `Non-standard tag: "${tag}"`,
        rootCause: `LLM injected free-form tag: ${tag}`,
        autoFixable: true,
      });
    }
  }

  // 5. Dead wikilinks — participants
  const participants = Array.isArray(fm.participants) ? fm.participants : [];
  for (const p of participants) {
    const name = p.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/"/g, "").trim();
    if (!name) continue;
    // Skip self
    if (rules.self_names.some(s => norm(s) === norm(name))) continue;

    const resolved = resolveWikilink(name);
    if (!resolved) {
      issues.push({
        file: note.fileName,
        category: "missing_people_note",
        severity: "warning",
        message: `No People note for participant: ${name}`,
        rootCause: "Contact stub not created during pipeline",
        autoFixable: true,
      });
    }
  }

  // 6. Dead wikilinks — use cases
  const useCases = Array.isArray(fm.use_cases) ? fm.use_cases : [];
  for (const uc of useCases) {
    const link = uc.replace(/^"|"$/g, "").replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
    if (!link) continue;
    const resolved = resolveWikilink(link);
    if (!resolved) {
      const meetingType = fm.meeting_type || "unknown";
      issues.push({
        file: note.fileName,
        category: "missing_uc_note",
        severity: "error",
        message: `No UC note for: ${link}`,
        rootCause: `UC stub not created — AIQ Extraction skipped (type=${meetingType})`,
        autoFixable: true,
      });
    }
  }

  // 7. Body wikilinks that don't resolve
  const bodyLinks = extractWikilinks(note.body);
  for (const link of bodyLinks) {
    // Skip common patterns that don't need files
    if (/^\d{4}-\d{2}-\d{2}/.test(link)) continue; // Date-based meeting links (expected)
    if (link.startsWith("#")) continue; // Heading links

    // Only check UC and People links (not meetings, not project links)
    if (isUCWikilink(link)) {
      const resolved = resolveWikilink(link);
      if (!resolved) {
        issues.push({
          file: note.fileName,
          category: "dead_wikilink_body",
          severity: "info",
          message: `Dead UC wikilink in body: [[${link}]]`,
          rootCause: "UC referenced in CR body but no note exists",
          autoFixable: true,
        });
      }
    }
  }

  return issues;
}

// ============================================================================
// --- Fix Logic ---
// ============================================================================

function applyFix(issue: AuditIssue, note: ParsedNote, rules: AuditRules, dryRun: boolean): boolean {
  switch (issue.category) {
    case "invalid_meeting_type": {
      if (dryRun) return true;
      const raw = note.frontmatter.meeting_type;
      const normalized = normalizeMeetingType(raw);
      const newContent = note.raw.replace(
        `meeting_type: ${raw}`,
        `meeting_type: ${normalized}`
      );
      writeFileSync(note.filePath, newContent);
      return true;
    }

    case "invalid_project_phase": {
      if (dryRun) return true;
      // Remove the invalid field
      const newContent = note.raw.replace(/^project_phase:.*\n/m, "");
      writeFileSync(note.filePath, newContent);
      return true;
    }

    case "non_standard_tag": {
      if (dryRun) return true;
      const tag = issue.message.match(/"([^"]+)"/)?.[1];
      if (!tag) return false;
      // Remove the line with this tag from frontmatter
      const tagLine = new RegExp(`^\\s+-\\s+${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
      const newContent = note.raw.replace(tagLine, "");
      writeFileSync(note.filePath, newContent);
      return true;
    }

    case "missing_people_note": {
      const name = issue.message.match(/participant: (.+)$/)?.[1];
      if (!name) return false;
      const client = note.frontmatter.client?.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/"/g, "") || null;
      if (dryRun) return true;
      const result = createContactStubs([name], client);
      return result.created.length > 0;
    }

    case "missing_uc_note":
    case "dead_wikilink_body": {
      const linkMatch = issue.message.match(/(?:for|body): (?:\[\[)?(.+?)(?:\]\])?$/);
      if (!linkMatch) return false;
      const link = linkMatch[1];
      const ucName = isUCWikilink(link) ? ucNameFromWikilink(link) : link;
      const project = note.frontmatter.project?.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/"/g, "") || null;
      const client = note.frontmatter.client?.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/"/g, "") || null;
      if (dryRun) return true;
      const result = createUCStubs([ucName], project, client);
      return result.created.length > 0;
    }

    default:
      return false;
  }
}

// ============================================================================
// --- Suggest Mode ---
// ============================================================================

interface EntitySuggestion {
  name: string;
  type: "contact" | "client" | "project";
  occurrences: number;
  files: string[];
}

function suggestCanonicalAdditions(rules: AuditRules): EntitySuggestion[] {
  const entities = loadCanonicalEntities();
  const nameOccurrences = new Map<string, { count: number; files: string[] }>();

  const files = readdirSync(MEETINGS_DIR).filter(f => f.endsWith(".md"));

  for (const file of files) {
    const content = readFileSync(join(MEETINGS_DIR, file), "utf-8");
    const { frontmatter } = parseFrontmatter(content);
    if (frontmatter.type !== "meeting") continue;

    const participants = Array.isArray(frontmatter.participants) ? frontmatter.participants : [];
    for (const p of participants) {
      const name = p.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/"/g, "").trim();
      if (!name) continue;
      if (rules.self_names.some(s => norm(s) === norm(name))) continue;

      // Check if already canonical
      const n = norm(name);
      const isCanonical = Object.entries(entities.contacts).some(
        ([k, v]) => norm(k) === n || v.aliases.some(a => norm(a) === n)
      );
      if (isCanonical) continue;

      const entry = nameOccurrences.get(name) || { count: 0, files: [] };
      entry.count++;
      entry.files.push(file);
      nameOccurrences.set(name, entry);
    }
  }

  const suggestions: EntitySuggestion[] = [];
  for (const [name, data] of nameOccurrences) {
    if (data.count >= rules.recurring_threshold) {
      suggestions.push({
        name,
        type: "contact",
        occurrences: data.count,
        files: data.files.slice(0, 5),
      });
    }
  }

  return suggestions.sort((a, b) => b.occurrences - a.occurrences);
}

// ============================================================================
// --- Duplicate UC Detection ---
// ============================================================================

/**
 * Scan all project UC directories for duplicate UC notes.
 * Detects accent-variants (same name after NFD normalization) and cross-project duplicates.
 */
function auditDuplicateUCs(): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const ucIndex = new Map<string, { name: string; path: string; project: string }[]>();

  if (!existsSync(PROJECTS_DIR)) return issues;

  for (const proj of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const ucDir = join(PROJECTS_DIR, proj.name, "Use Cases");
    if (!existsSync(ucDir)) continue;

    for (const file of readdirSync(ucDir)) {
      if (!file.endsWith(".md")) continue;
      if (!file.startsWith("UC")) continue;

      // Extract UC name from filename
      const ucName = file
        .replace(/^UC\s*[—–]+\s*/i, "")
        .replace(/^UC\s*-{1,2}\s*/i, "")
        .replace(/\.md$/, "")
        .trim();
      if (!ucName) continue;

      const normalized = norm(ucName);
      const entry = { name: ucName, path: join(ucDir, file), project: proj.name };

      const existing = ucIndex.get(normalized) || [];
      existing.push(entry);
      ucIndex.set(normalized, existing);
    }
  }

  // Emit issues for groups with 2+ entries
  for (const [normalizedName, entries] of ucIndex) {
    if (entries.length < 2) continue;

    const projects = new Set(entries.map(e => e.project));
    const names = new Set(entries.map(e => e.name));

    let rootCause: string;
    if (projects.size > 1 && names.size === 1) {
      rootCause = `Cross-project duplicate: same UC "${entries[0].name}" in ${[...projects].join(", ")}`;
    } else if (names.size > 1) {
      rootCause = `Accent variant: ${[...names].map(n => `"${n}"`).join(" vs ")}`;
    } else {
      rootCause = `Cross-project duplicate: same UC in ${[...projects].join(", ")}`;
    }

    const filePaths = entries.map(e => e.path.replace(PROJECTS_DIR + "/", ""));

    issues.push({
      file: filePaths[0],
      category: "duplicate_uc",
      severity: "warning",
      message: `Duplicate UC (${entries.length} copies): ${filePaths.join(" | ")}`,
      rootCause,
      autoFixable: false,
    });
  }

  return issues;
}

// ============================================================================
// --- Report Generation ---
// ============================================================================

function generateReport(
  issues: AuditIssue[],
  suggestions: EntitySuggestion[],
  mode: string
): string {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const lines: string[] = [
    "---",
    "type: reference",
    `last_scan: ${now}`,
    `mode: ${mode}`,
    `total_issues: ${issues.length}`,
    `fixed: ${issues.filter(i => i.fixed).length}`,
    "---",
    "",
    "# Vault Audit Report",
    "",
    `> Last scan: ${now} | Mode: ${mode}`,
    "",
  ];

  // Group by category
  const byCategory = new Map<string, AuditIssue[]>();
  for (const issue of issues) {
    const list = byCategory.get(issue.category) || [];
    list.push(issue);
    byCategory.set(issue.category, list);
  }

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Category | Count | Fixed | Severity |`);
  lines.push(`|----------|-------|-------|----------|`);
  for (const [cat, catIssues] of byCategory) {
    const fixed = catIssues.filter(i => i.fixed).length;
    const severity = catIssues[0].severity;
    lines.push(`| ${cat} | ${catIssues.length} | ${fixed} | ${severity} |`);
  }
  lines.push("");

  // Details by category
  lines.push("## Details");
  lines.push("");

  for (const [cat, catIssues] of byCategory) {
    lines.push(`### ${cat} (${catIssues.length})`);
    lines.push("");
    for (const issue of catIssues.slice(0, 30)) {
      const status = issue.fixed ? "[FIXED]" : issue.autoFixable ? "[fixable]" : "";
      lines.push(`- ${status} **${issue.file}**: ${issue.message}`);
      lines.push(`  - Root cause: ${issue.rootCause}`);
    }
    if (catIssues.length > 30) {
      lines.push(`- ... and ${catIssues.length - 30} more`);
    }
    lines.push("");
  }

  // Root causes summary
  lines.push("## Root Causes");
  lines.push("");
  const rootCauses = new Map<string, number>();
  for (const issue of issues) {
    rootCauses.set(issue.rootCause, (rootCauses.get(issue.rootCause) || 0) + 1);
  }
  for (const [cause, count] of [...rootCauses.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${count}x** ${cause}`);
  }
  lines.push("");

  // Suggestions
  if (suggestions.length > 0) {
    lines.push("## Suggested Canonical Additions");
    lines.push("");
    lines.push("| Name | Type | Occurrences | Sample Files |");
    lines.push("|------|------|-------------|--------------|");
    for (const s of suggestions) {
      lines.push(`| ${s.name} | ${s.type} | ${s.occurrences} | ${s.files.slice(0, 3).join(", ")} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================================
// --- Main ---
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "scan";
  const fix = args.includes("--fix");
  const dryRun = args.includes("--dry-run");
  const mode = dryRun ? "dry-run" : fix ? "fix" : "scan";

  console.log(`\n=== VaultAudit: ${mode} mode ===\n`);

  if (!existsSync(MEETINGS_DIR)) {
    console.error(`ERROR: Meetings directory not found: ${MEETINGS_DIR}`);
    process.exit(1);
  }

  const rules = loadRules();
  const allIssues: AuditIssue[] = [];

  // Scan meeting notes
  const files = readdirSync(MEETINGS_DIR).filter(f => f.endsWith(".md"));
  console.log(`Scanning ${files.length} meeting notes...`);

  for (const file of files) {
    const filePath = join(MEETINGS_DIR, file);
    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    const note: ParsedNote = { filePath, fileName: file, frontmatter, body, raw };
    const issues = auditMeetingNote(note, rules);

    // Apply fixes if requested
    if ((fix || dryRun) && issues.length > 0) {
      for (const issue of issues) {
        if (issue.autoFixable) {
          const fixed = applyFix(issue, note, rules, dryRun);
          issue.fixed = fixed;
        }
      }
    }

    allIssues.push(...issues);
  }

  // Duplicate UC detection (vault-wide, not per-note)
  console.log("Checking for duplicate UC notes...");
  const duplicateIssues = auditDuplicateUCs();
  allIssues.push(...duplicateIssues);

  // Suggestions
  let suggestions: EntitySuggestion[] = [];
  if (command === "suggest" || fix) {
    console.log("Analyzing recurring unresolved entities...");
    suggestions = suggestCanonicalAdditions(rules);
  }

  // Print summary
  const errors = allIssues.filter(i => i.severity === "error").length;
  const warnings = allIssues.filter(i => i.severity === "warning").length;
  const infos = allIssues.filter(i => i.severity === "info").length;
  const fixed = allIssues.filter(i => i.fixed).length;

  console.log(`\nResults:`);
  console.log(`  Errors:   ${errors}`);
  console.log(`  Warnings: ${warnings}`);
  console.log(`  Info:     ${infos}`);
  if (fix || dryRun) {
    console.log(`  Fixed:    ${fixed}${dryRun ? " (dry-run, no writes)" : ""}`);
  }
  if (suggestions.length > 0) {
    console.log(`  Suggestions: ${suggestions.length} entities to add to canonical registry`);
  }

  // Write report
  if (!dryRun) {
    const report = generateReport(allIssues, suggestions, mode);
    writeFileSync(REPORT_PATH, report);
    console.log(`\nReport written to: ${REPORT_PATH}`);
  } else {
    const report = generateReport(allIssues, suggestions, mode);
    console.log("\n--- DRY RUN REPORT ---\n");
    console.log(report);
  }
}

main();
