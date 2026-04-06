#!/usr/bin/env bun
/**
 * people-sync.ts — Sync canonical entities data to Obsidian People notes
 *
 * Enriches People note frontmatter with email, lifecycle, last_seen, meeting_count.
 * Creates stub notes for contacts without an existing People note.
 * NEVER overwrites manually-edited content (body, role, bio sections).
 *
 * Usage:
 *   bun people-sync.ts sync           Sync all contacts → vault People notes
 *   bun people-sync.ts preview        Preview changes without writing
 *   bun people-sync.ts show <name>    Show what would be written for one contact
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { PATHS, loadCanonicalEntities, norm } from "./meeting-core";

const VAULT_PEOPLE = PATHS.vaultPeople;
const VAULT_MEETINGS = PATHS.vaultMeetings;

interface PeopleNoteUpdate {
  name: string;
  filePath: string;
  exists: boolean;
  changes: string[];
  newFrontmatter: Record<string, any>;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { frontmatter, body } where body is everything after the closing ---.
 */
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
      if (value === "") {
        // Could be start of array or empty value
        inArray = false;
        fm[currentKey] = "";
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

/**
 * Serialize frontmatter back to YAML string.
 * Preserves order: type, client, role, email, phone, lifecycle, last_seen, meeting_count, created, aliases.
 */
function serializeFrontmatter(fm: Record<string, any>): string {
  const lines: string[] = ["---"];
  const orderedKeys = [
    "type", "client", "company", "role", "email", "phone",
    "lifecycle", "last_seen", "meeting_count", "created", "aliases",
  ];

  const written = new Set<string>();
  for (const key of orderedKeys) {
    if (fm[key] !== undefined && fm[key] !== null && fm[key] !== "") {
      written.add(key);
      if (Array.isArray(fm[key])) {
        lines.push(`${key}:`);
        for (const v of fm[key]) {
          lines.push(`  - "${v}"`);
        }
      } else {
        const val = fm[key];
        // Quote strings that contain special chars
        if (typeof val === "string" && (val.includes(":") || val.includes("[") || val.includes('"') || val.startsWith("[[") || val.includes("@"))) {
          lines.push(`${key}: "${val}"`);
        } else {
          lines.push(`${key}: ${val}`);
        }
      }
    }
  }

  // Write remaining keys not in ordered list
  for (const [key, val] of Object.entries(fm)) {
    if (written.has(key) || val === undefined || val === null || val === "") continue;
    if (Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const v of val) lines.push(`  - "${v}"`);
    } else {
      if (typeof val === "string" && (val.includes(":") || val.includes("[") || val.includes('"') || val.startsWith("[[") || val.includes("@"))) {
        lines.push(`${key}: "${val}"`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
  }

  lines.push("---");
  return lines.join("\n");
}

/**
 * Count meetings for a contact by scanning Meeting CRs frontmatter.
 */
function countMeetings(contactName: string): { count: number; lastSeen: string | null } {
  if (!existsSync(VAULT_MEETINGS)) return { count: 0, lastSeen: null };

  const files = readdirSync(VAULT_MEETINGS).filter(f => f.endsWith(".md"));
  let count = 0;
  let lastDate: string | null = null;

  for (const file of files) {
    try {
      const content = readFileSync(join(VAULT_MEETINGS, file), "utf-8").slice(0, 2000);
      // Check if contact is mentioned in participants frontmatter or body wikilinks
      if (content.includes(`[[${contactName}]]`)) {
        count++;
        // Extract date from filename (YYYY-MM-DD format)
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const date = dateMatch[1];
          if (!lastDate || date > lastDate) lastDate = date;
        }
      }
    } catch {}
  }

  return { count, lastSeen: lastDate };
}

/**
 * Find existing People note for a contact.
 */
function findPeopleNote(contactName: string): string | null {
  if (!existsSync(VAULT_PEOPLE)) return null;
  const files = readdirSync(VAULT_PEOPLE).filter(f => f.endsWith(".md"));

  // Exact match
  const exact = files.find(f => f.replace(".md", "") === contactName);
  if (exact) return join(VAULT_PEOPLE, exact);

  // Normalized match (accent-insensitive)
  const contactNorm = norm(contactName);
  const normalized = files.find(f => norm(f.replace(".md", "")) === contactNorm);
  if (normalized) return join(VAULT_PEOPLE, normalized);

  // First name match for ambiguous contacts (e.g., "Emma" → "Emma.md")
  const firstName = contactName.split(" ")[0];
  const firstNameMatch = files.find(f => norm(f.replace(".md", "")) === norm(firstName));
  if (firstNameMatch) return join(VAULT_PEOPLE, firstNameMatch);

  return null;
}

/**
 * Generate a stub People note for a new contact.
 */
function generateStub(name: string, email: string | undefined, client: string | null, role: string | undefined): string {
  const fm: Record<string, any> = {
    type: "person",
  };
  if (client) fm.client = `[[${client}]]`;
  if (role) fm.role = role;
  if (email) fm.email = email;
  fm.lifecycle = "active";
  fm.created = new Date().toISOString().slice(0, 10);

  const header = serializeFrontmatter(fm);
  return `${header}
# ${name}

#area/career

## Infos

| Champ | Valeur |
|-------|--------|
| **Client** | ${client ? `[[${client}]]` : "?"} |
| **Email** | ${email || "?"} |

## Interactions

\`\`\`dataview
LIST
FROM "30 - Meetings"
WHERE contains(file.outlinks, this.file.link)
SORT file.mtime DESC
LIMIT 10
\`\`\`
`;
}

/**
 * Compute updates for all contacts.
 */
function computeUpdates(preview: boolean): PeopleNoteUpdate[] {
  const entities = loadCanonicalEntities();
  const updates: PeopleNoteUpdate[] = [];

  for (const [name, data] of Object.entries(entities.contacts)) {
    if (data.is_self) continue;

    const notePath = findPeopleNote(name);
    const email = (data as any).calendar_email;
    const { count, lastSeen } = countMeetings(name);

    if (notePath && existsSync(notePath)) {
      // Update existing note
      const content = readFileSync(notePath, "utf-8");
      const { frontmatter: fm, body } = parseFrontmatter(content);
      const changes: string[] = [];

      // Normalize type
      if (fm.type === "contact") {
        fm.type = "person";
        changes.push("type: contact → person");
      }

      // Normalize client (company → client)
      if (fm.company && !fm.client) {
        fm.client = fm.company;
        delete fm.company;
        changes.push(`client: set from company field`);
      }

      // Add email if not present
      if (email && !fm.email) {
        fm.email = email;
        changes.push(`email: ${email}`);
      }

      // Update lifecycle
      const lifecycle = lastSeen && daysSince(lastSeen) <= 60 ? "active" : (count > 0 ? "dormant" : "discovered");
      if (fm.lifecycle !== lifecycle) {
        fm.lifecycle = lifecycle;
        changes.push(`lifecycle: ${lifecycle}`);
      }

      // Update last_seen
      if (lastSeen && fm.last_seen !== lastSeen) {
        fm.last_seen = lastSeen;
        changes.push(`last_seen: ${lastSeen}`);
      }

      // Update meeting_count
      if (count > 0 && fm.meeting_count !== String(count)) {
        fm.meeting_count = count;
        changes.push(`meeting_count: ${count}`);
      }

      if (changes.length > 0) {
        updates.push({
          name,
          filePath: notePath,
          exists: true,
          changes,
          newFrontmatter: fm,
        });

        if (!preview) {
          const newContent = serializeFrontmatter(fm) + "\n" + body;
          writeFileSync(notePath, newContent);
        }
      }
    } else {
      // Create stub note
      const stubPath = join(VAULT_PEOPLE, `${name}.md`);
      const changes = [`CREATE stub note`];
      if (email) changes.push(`email: ${email}`);
      if (data.client) changes.push(`client: ${data.client}`);

      updates.push({
        name,
        filePath: stubPath,
        exists: false,
        changes,
        newFrontmatter: {},
      });

      if (!preview) {
        const stub = generateStub(name, email, data.client, undefined);
        writeFileSync(stubPath, stub);
      }
    }
  }

  return updates;
}

function daysSince(dateStr: string): number {
  const then = new Date(dateStr + "T00:00:00");
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / (24 * 3600 * 1000));
}

// --- CLI ---

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "preview": {
    console.log("\n  People Sync — Preview\n");
    const updates = computeUpdates(true);
    if (updates.length === 0) {
      console.log("  No changes needed.");
      break;
    }
    for (const u of updates) {
      const icon = u.exists ? "~" : "+";
      console.log(`  ${icon} ${u.name}`);
      for (const c of u.changes) console.log(`    ${c}`);
    }
    console.log(`\n  Total: ${updates.length} notes to update\n`);
    break;
  }
  case "sync": {
    console.log("\n  People Sync — Writing...\n");
    const updates = computeUpdates(false);
    let created = 0, updated = 0;
    for (const u of updates) {
      const icon = u.exists ? "\x1b[33m~\x1b[0m" : "\x1b[32m+\x1b[0m";
      console.log(`  ${icon} ${u.name}: ${u.changes.join(", ")}`);
      if (u.exists) updated++; else created++;
    }
    console.log(`\n  \x1b[32m✓\x1b[0m ${created} created, ${updated} updated\n`);
    break;
  }
  case "show": {
    const name = args.join(" ");
    if (!name) { console.error("Usage: people-sync.ts show <name>"); process.exit(1); }
    const entities = loadCanonicalEntities();
    const data = entities.contacts[name];
    if (!data) { console.error(`Contact "${name}" not found in canonical-entities.json`); process.exit(1); }
    const notePath = findPeopleNote(name);
    const email = (data as any).calendar_email;
    const { count, lastSeen } = countMeetings(name);
    console.log(`\n  ${name}`);
    console.log(`  Email:         ${email || "(none)"}`);
    console.log(`  Client:        ${data.client || "(none)"}`);
    console.log(`  Vault note:    ${notePath || "(will create)"}`);
    console.log(`  Meetings:      ${count}`);
    console.log(`  Last seen:     ${lastSeen || "(never)"}`);
    console.log();
    break;
  }
  default:
    console.log(`
  People Sync — Enrich Obsidian People notes from pipeline data

  bun people-sync.ts preview              Preview changes
  bun people-sync.ts sync                 Write changes to vault
  bun people-sync.ts show <name>          Show contact details
`);
}
