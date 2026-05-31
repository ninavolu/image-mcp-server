#!/usr/bin/env node
/**
 * Image Library Manager
 * Your personal tool to add/remove images from the database.
 * Claude only gets read access — this is yours.
 *
 * Usage:
 *   node manage.js add <file_path> <purpose> [--tags tag1,tag2] [--desc "text"] [--name "name"]
 *   node manage.js remove <id>
 *   node manage.js list
 *
 * Purposes: landing-page | hero | document | thumbnail | icon | background | product | avatar | other
 *
 * Examples:
 *   node manage.js add ~/photos/hero.png hero --tags dark,minimal --desc "Dark hero shot"
 *   node manage.js add ~/photos/logo.svg icon --tags brand,white --name "Main Logo"
 *   node manage.js list
 *   node manage.js remove 3f2a1b4c-...
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Load .env
try {
  const env = readFileSync(new URL(".env", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
} catch {}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PURPOSES = [
  "landing-page","hero","document","thumbnail",
  "icon","background","product","avatar","other",
];

const [,, command, ...rest] = process.argv;

if (command === "add") {
  const [filePath, purpose] = rest;

  if (!filePath || !purpose) {
    console.error("Usage: node manage.js add <file_path> <purpose> [--tags t1,t2] [--desc '...'] [--name '...']");
    process.exit(1);
  }

  if (!PURPOSES.includes(purpose)) {
    console.error(`Invalid purpose. Choose from: ${PURPOSES.join(", ")}`);
    process.exit(1);
  }

  const absPath = resolve(filePath.replace(/^~/, process.env.HOME));
  if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  // Parse optional flags
  let tags = [], desc = "", name = "";
  for (let i = 2; i < rest.length; i++) {
    if (rest[i] === "--tags") tags = rest[++i]?.split(",").map(t => t.trim()) ?? [];
    if (rest[i] === "--desc") desc = rest[++i] ?? "";
    if (rest[i] === "--name") name = rest[++i] ?? "";
  }
  if (!name) name = absPath.split("/").pop(); // default to filename

  const { data, error } = await supabase
    .from("images")
    .insert({ name, file_path: absPath, purpose, tags, description: desc || null })
    .select()
    .single();

  if (error) { console.error("Error:", error.message); process.exit(1); }

  console.log(`✓ Added "${data.name}" [${data.id}]`);
  console.log(`  Purpose: ${data.purpose} | Tags: ${data.tags?.join(", ") || "none"}`);

} else if (command === "remove") {
  const [id] = rest;
  if (!id) { console.error("Usage: node manage.js remove <id>"); process.exit(1); }

  const { error } = await supabase.from("images").delete().eq("id", id);
  if (error) { console.error("Error:", error.message); process.exit(1); }
  console.log(`✓ Removed ${id}`);

} else if (command === "list") {
  const { data, error } = await supabase
    .from("images")
    .select("*")
    .order("purpose")
    .order("name");

  if (error) { console.error("Error:", error.message); process.exit(1); }
  if (!data.length) { console.log("No images in library."); process.exit(0); }

  // Group by purpose
  const grouped = {};
  for (const img of data) {
    (grouped[img.purpose] ??= []).push(img);
  }

  for (const [purpose, imgs] of Object.entries(grouped)) {
    console.log(`\n── ${purpose} (${imgs.length}) ──`);
    for (const img of imgs) {
      console.log(`  [${img.id}] ${img.name}`);
      console.log(`    ${img.file_path}`);
      if (img.tags?.length) console.log(`    tags: ${img.tags.join(", ")}`);
      if (img.description) console.log(`    ${img.description}`);
    }
  }
  console.log(`\nTotal: ${data.length} image(s)`);

} else {
  console.log(`Commands:
  add <file_path> <purpose> [--tags t1,t2] [--name "name"] [--desc "text"]
  remove <id>
  list

Purposes: ${PURPOSES.join(" | ")}`);
}
