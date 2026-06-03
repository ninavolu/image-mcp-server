#!/usr/bin/env node
/**
 * Migrates image URLs back from Cloudflare R2 to Supabase Storage.
 * Files are already in Supabase Storage — this just updates the DB URLs.
 * Run: node migrate-back-to-supabase.js
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

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

const { data: images, error } = await supabase.from("images").select("*");
if (error) { console.error("DB error:", error.message); process.exit(1); }

console.log(`Found ${images.length} image(s)\n`);

let success = 0, skipped = 0, failed = 0;

for (const img of images) {
  const filename = img.file_path.split("/").pop();

  // Already on Supabase
  if (img.file_path.includes("supabase.co")) {
    console.log(`${img.name} — skipped (already on Supabase)`);
    skipped++;
    continue;
  }

  process.stdout.write(`${img.name}... `);

  // Check file exists in Supabase Storage
  const { data: list } = await supabase.storage.from("images").list("", { search: filename });
  const exists = list?.some(f => f.name === filename);

  if (!exists) {
    // File not in Supabase Storage — re-upload from R2
    process.stdout.write(`downloading from R2... `);
    try {
      const r2Res = await fetch(img.file_path);
      if (!r2Res.ok) throw new Error(`R2 fetch failed: ${r2Res.status}`);
      const buffer = Buffer.from(await r2Res.arrayBuffer());
      const ext = filename.split(".").pop().toLowerCase();
      const contentTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
      await supabase.storage.from("images").upload(filename, buffer, {
        contentType: contentTypes[ext] ?? "image/jpeg",
        upsert: true,
      });
    } catch (e) {
      console.log(`✗ ${e.message}`);
      failed++;
      continue;
    }
  }

  // Get Supabase public URL
  const { data: { publicUrl } } = supabase.storage.from("images").getPublicUrl(filename);

  // Update DB
  const { error: updateError } = await supabase
    .from("images")
    .update({ file_path: publicUrl })
    .eq("id", img.id);

  if (updateError) {
    console.log(`✗ DB update failed: ${updateError.message}`);
    failed++;
    continue;
  }

  console.log(`✓ ${publicUrl}`);
  success++;
}

console.log(`\nDone. ${success} updated, ${skipped} skipped, ${failed} failed.`);
