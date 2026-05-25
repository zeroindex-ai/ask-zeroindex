// Ingest pipeline: parse zeroindex.ai HTML, chunk by section, embed via Voyage-3, upsert to Turso.
// Run: pnpm ingest
//
// The website is an Astro static site (repo: zeroindex-site, deployed to Vercel).
// `astro build` emits a single static dist/index.html with the same <section id>
// structure cheerio walks below, so the single-file ingest mechanism is unchanged.
// Default source: ../zeroindex-site/dist/index.html (sibling clone, post-build).
// Override: INGEST_SOURCE=/path/to/file.html pnpm ingest

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { db, initSchema } from '@/lib/db';
import { embedDocuments } from '@/lib/embeddings';
import { runMain } from './_run';

const TARGET_CHARS = 1600;
const OVERLAP_CHARS = 200;
const EMBED_BATCH = 128;

type RawChunk = { sourcePath: string; section: string | null; content: string };

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function extractChunks(html: string, sourcePath: string): RawChunk[] {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, header, footer').remove();

  const sections = $('section').toArray();
  const out: RawChunk[] = [];

  for (const sec of sections) {
    const $sec = $(sec);
    const id = $sec.attr('id') ?? null;
    const headingEl = $sec.find('h1, h2').first();
    const heading = headingEl.length ? normalizeText(headingEl.text()) : null;
    const sectionName = heading ?? id;

    const subsections = $sec.find('h3').toArray();
    if (subsections.length === 0) {
      const text = normalizeText($sec.text());
      if (text) out.push({ sourcePath, section: sectionName, content: text });
      continue;
    }

    // Chunk per h3 within the section, prefixed with section + h3 for retrieval context
    for (let i = 0; i < subsections.length; i++) {
      const $h3 = $(subsections[i]);
      const subTitle = normalizeText($h3.text());
      const parts: string[] = [];
      let node = $h3.next();
      while (node.length && !node.is('h3')) {
        const t = normalizeText(node.text());
        if (t) parts.push(t);
        node = node.next();
      }
      const body = parts.join(' ').trim();
      if (!body) continue;
      const label = sectionName ? `${sectionName} — ${subTitle}` : subTitle;
      out.push({ sourcePath, section: label, content: `${subTitle}: ${body}` });
    }
  }

  // Also grab anything outside sections (intro/hero copy)
  const orphans = normalizeText($('body').clone().find('section').remove().end().text());
  if (orphans && orphans.length > 80) {
    out.push({ sourcePath, section: 'overview', content: orphans });
  }

  return splitOversized(out);
}

function splitOversized(chunks: RawChunk[]): RawChunk[] {
  const out: RawChunk[] = [];
  for (const c of chunks) {
    if (c.content.length <= TARGET_CHARS) {
      out.push(c);
      continue;
    }
    let start = 0;
    while (start < c.content.length) {
      const end = Math.min(start + TARGET_CHARS, c.content.length);
      out.push({ ...c, content: c.content.slice(start, end) });
      if (end === c.content.length) break;
      start = end - OVERLAP_CHARS;
    }
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const source =
    process.env.INGEST_SOURCE ?? resolve(process.cwd(), '../zeroindex-site/dist/index.html');
  console.log(`source: ${source}`);

  const html = await readFile(source, 'utf-8');
  const chunks = extractChunks(html, source);
  if (chunks.length === 0) {
    console.error('extracted 0 chunks — refusing to wipe table; check source HTML');
    process.exit(1);
  }
  const avgChars = Math.round(chunks.reduce((a, c) => a + c.content.length, 0) / chunks.length);
  console.log(`extracted ${chunks.length} chunks (avg ${avgChars} chars)`);

  await initSchema();

  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const v = await embedDocuments(batch.map((b) => b.content));
    embeddings.push(...v);
    console.log(`  embedded ${Math.min(i + EMBED_BATCH, chunks.length)}/${chunks.length}`);
  }

  // Atomic swap: delete old chunks, insert new ones, rebuild FTS — all in one
  // transaction so a mid-pipeline failure can't leave the table empty/partial.
  const c = db();
  const tx = await c.transaction('write');
  try {
    await tx.execute('DELETE FROM chunks');
    for (const [i, chunk] of chunks.entries()) {
      await tx.execute({
        sql: 'INSERT INTO chunks (source_path, section, content, embedding) VALUES (?, ?, ?, vector32(?))',
        args: [chunk.sourcePath, chunk.section, chunk.content, JSON.stringify(embeddings[i])],
      });
    }
    await tx.execute(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✓ ingested ${chunks.length} chunks in ${dt}s`);
}

runMain(main);
