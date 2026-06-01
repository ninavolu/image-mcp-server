#!/usr/bin/env node
/**
 * One-time migration: re-uploads all existing images from Supabase Storage to R2
 * and updates their file_path in the database to the new R2 public URL.
 *
 * Usage: node migrate-to-r2.js
 */

import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync } from "fs";

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

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Fetch all images from DB
const { data: images, error } = await supabase.from("images").select("*");
if (error) { console.error("DB error:", error.message); process.exit(1); }
if (!images.length) { console.log("No images found."); process.exit(0); }

console.log(`Migrating ${images.length} image(s) to R2...\n`);

let success = 0, failed = 0, skipped = 0;

for (const img of images) {
  // Skip if already on R2
  if (img.file_path.includes("r2.dev")) {
    console.log(`${img.name} — skipped (already on R2)`);
    skipped++;
    continue;
  }

  process.stdout.write(`${img.name}... `);

  // Download from Supabase Storage
  const filename = img.file_path.split("/").pop();
  const { data: fileData, error: downloadError } = await supabase.storage
    .from("images")
    .download(filename);

  if (downloadError) {
    console.log(`✗ Download failed: ${downloadError.message}`);
    failed++;
    continue;
  }

  const buffer = Buffer.from(await fileData.arrayBuffer());
  const ext = filename.split(".").pop().toLowerCase();
  const contentTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  const contentType = contentTypes[ext] ?? "image/jpeg";

  // Upload to R2
  try {
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: filename,
      Body: buffer,
      ContentType: contentType,
    }));
  } catch (e) {
    console.log(`✗ R2 upload failed: ${e.message}`);
    failed++;
    continue;
  }

  // Update DB with new R2 URL
  const newUrl = `${process.env.R2_PUBLIC_URL}/${filename}`;
  const { error: updateError } = await supabase
    .from("images")
    .update({ file_path: newUrl })
    .eq("id", img.id);

  if (updateError) {
    console.log(`✗ DB update failed: ${updateError.message}`);
    failed++;
    continue;
  }

  console.log(`✓ ${newUrl}`);
  success++;
}

console.log(`\nDone. ${success} migrated, ${skipped} skipped, ${failed} failed.`);
