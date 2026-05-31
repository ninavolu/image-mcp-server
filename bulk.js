#!/usr/bin/env node
/**
 * Bulk image importer with auto-tagging via Claude Haiku vision
 * Uploads all images in a folder to Supabase Storage,
 * auto-generates purpose + tags + description, and registers them.
 *
 * Usage:
 *   node bulk.js <folder_path>
 *
 * Example:
 *   node bulk.js ~/Downloads/images1
 */

import Anthropic from "@anthropic-ai/sdk";
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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const PURPOSES = ["landing-page","hero","document","thumbnail","icon","background","product","avatar","other"];

const [,, folderArg] = process.argv;

if (!folderArg) {
  console.error("Usage: node bulk.js <folder_path>");
  process.exit(1);
}

const folderPath = resolve(folderArg.replace(/^~/, process.env.HOME));

if (!existsSync(folderPath)) {
  console.error(`Folder not found: ${folderPath}`);
  process.exit(1);
}

const files = readdirSync(folderPath).filter(f => IMAGE_EXTS.includes(extname(f).toLowerCase()));

if (!files.length) {
  console.error("No image files found in that folder.");
  process.exit(1);
}

console.log(`Found ${files.length} image(s) — auto-tagging with Claude Haiku\n`);

async function analyzeImage(publicUrl) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 256,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "url", url: publicUrl }
        },
        {
          type: "text",
          text: `Analyze this image and respond with ONLY a JSON object, no other text:
{
  "purpose": "<one of: landing-page, hero, document, thumbnail, icon, background, product, avatar, other>",
  "tags": ["<3-6 descriptive tags like: dark, minimal, colorful, nature, tech, people, abstract, warm, cool, outdoor, indoor>"],
  "description": "<one sentence describing the image>"
}`
        }
      ]
    }]
  });

  const text = response.content[0].text.trim();
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  const parsed = JSON.parse(json);

  if (!PURPOSES.includes(parsed.purpose)) parsed.purpose = "other";
  parsed.tags = (parsed.tags || []).slice(0, 6).map(t => String(t).toLowerCase());

  return parsed;
}

let success = 0, failed = 0;

for (const file of files) {
  const filePath = `${folderPath}/${file}`;
  const ext = extname(file).slice(1).toLowerCase();
  const contentTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  const contentType = contentTypes[ext] ?? "image/jpeg";

  process.stdout.write(`${file}... `);

  // Check for duplicate
  const { data: existing } = await supabase
    .from("images")
    .select("id")
    .eq("name", basename(file, extname(file)))
    .maybeSingle();

  if (existing) {
    console.log(`skipped (already exists)`);
    continue;
  }

  // Read file
  const fileBuffer = await readFile(filePath);

  // Upload to Supabase Storage first
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

  // Auto-tag with Claude Haiku using the public URL (no size limit)
  let analysis;
  try {
    analysis = await analyzeImage(publicUrl);
  } catch (e) {
    console.log(`✗ Tagging failed: ${e.message}`);
    failed++;
    continue;
  }

  // Register in DB with AI-generated metadata
  const { error: dbError } = await supabase.from("images").insert({
    name: basename(file, extname(file)),
    file_path: publicUrl,
    purpose: analysis.purpose,
    tags: analysis.tags,
    description: analysis.description,
  });

  if (dbError) {
    console.log(`✗ DB insert failed: ${dbError.message}`);
    failed++;
    continue;
  }

  console.log(`✓ [${analysis.purpose}] ${analysis.tags.join(", ")}`);
  success++;
}

console.log(`\nDone. ${success} added, ${failed} failed.`);
