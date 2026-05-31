#!/usr/bin/env node
/**
 * Bulk image importer
 * Uploads all images in a folder to Supabase Storage and registers them.
 *
 * Usage:
 *   node bulk.js <folder_path> <purpose> [--tags tag1,tag2]
 *
 * Example:
 *   node bulk.js ~/Downloads/images1 other --tags nature
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, extname, basename } from "path";
import { readFile } from "fs/promises";

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

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];

const [,, folderArg, purpose = "other", ...flags] = process.argv;

if (!folderArg) {
  console.error("Usage: node bulk.js <folder_path> <purpose> [--tags tag1,tag2]");
  process.exit(1);
}

const folderPath = resolve(folderArg.replace(/^~/, process.env.HOME));

if (!existsSync(folderPath)) {
  console.error(`Folder not found: ${folderPath}`);
  process.exit(1);
}

// Parse --tags
let tags = [];
const tagsIndex = flags.indexOf("--tags");
if (tagsIndex !== -1) tags = flags[tagsIndex + 1]?.split(",").map(t => t.trim()) ?? [];

// Get all image files
const files = readdirSync(folderPath).filter(f => IMAGE_EXTS.includes(extname(f).toLowerCase()));

if (!files.length) {
  console.error("No image files found in that folder.");
  process.exit(1);
}

console.log(`Found ${files.length} image(s) in ${folderPath}`);
console.log(`Purpose: ${purpose} | Tags: ${tags.join(", ") || "none"}\n`);

let success = 0, failed = 0;

for (const file of files) {
  const filePath = `${folderPath}/${file}`;
  const ext = extname(file).slice(1).toLowerCase();
  const mimeTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };
  const contentType = mimeTypes[ext] ?? "image/png";

  process.stdout.write(`${file}... `);

  // Check for duplicate in DB
  const { data: existing } = await supabase
    .from("images")
    .select("id")
    .eq("name", basename(file, extname(file)))
    .maybeSingle();

  if (existing) {
    console.log(`skipped (already exists)`);
    continue;
  }

  // Upload to Supabase Storage
  const fileBuffer = await readFile(filePath);
  const { error: uploadError } = await supabase.storage
    .from("images")
    .upload(file, fileBuffer, { contentType, upsert: true });

  if (uploadError) {
    console.log(`✗ Upload failed: ${uploadError.message}`);
    failed++;
    continue;
  }

  // Get public URL
  const { data: { publicUrl } } = supabase.storage.from("images").getPublicUrl(file);

  // Register in DB
  const { error: dbError } = await supabase
    .from("images")
    .insert({ name: basename(file, extname(file)), file_path: publicUrl, purpose, tags });

  if (dbError) {
    console.log(`✗ DB insert failed: ${dbError.message}`);
    failed++;
    continue;
  }

  console.log(`✓`);
  success++;
}

console.log(`\nDone. ${success} added, ${failed} failed.`);
