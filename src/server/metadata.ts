import fs from 'node:fs';
import path from 'node:path';
import { exiftool } from 'exiftool-vendored';

type MetadataValue = string | string[] | number | Date | undefined;
type MetadataMap = Record<string, MetadataValue>;
type MarkdownFrontmatter = {
  tags: string[];
  description: string;
  artist: string;
  body: string;
};

function asArray(value: MetadataValue): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function safeTag(value: string): string {
  return value
    .replace(/[\r\n\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s*(?:->|>|\\|\|\/|\|)\s*/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .replace(/^\/+|\/+$/g, '')
    .trim();
}

function firstString(...values: MetadataValue[]): string {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return String(value[0]);
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function firstNumber(...values: MetadataValue[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstDateIso(...values: MetadataValue[]): string | undefined {
  for (const value of values) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (typeof value === 'string') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return undefined;
}

export async function readMetadata(filePath: string): Promise<{
  tags: string[];
  description: string;
  artist: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  createdAt?: string;
}> {
  if (isMarkdownFile(filePath)) {
    const content = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
    const metadata = parseMarkdownFrontmatter(content);
    return {
      tags: metadata.tags,
      description: metadata.description,
      artist: metadata.artist,
    };
  }

  try {
    const raw = (await exiftool.read(filePath)) as MetadataMap;
    const tags = [
      ...asArray(raw.Keywords),
      ...asArray(raw.Subject),
      ...asArray(raw.HierarchicalSubject),
      ...asArray(raw.CatalogSets),
    ];
    const uniqueTags = Array.from(new Set(tags.map(safeTag).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b),
    );

    return {
      tags: uniqueTags,
      description: firstString(raw.Description, raw.ImageDescription, raw.Caption, raw['Caption-Abstract']),
      artist: firstString(raw.Artist, raw.Creator, raw.ByLine, raw['By-line']),
      width: firstNumber(raw.ImageWidth, raw.ExifImageWidth, raw.SourceImageWidth),
      height: firstNumber(raw.ImageHeight, raw.ExifImageHeight, raw.SourceImageHeight),
      durationSeconds: firstNumber(raw.Duration),
      createdAt: firstDateIso(raw.DateTimeOriginal, raw.CreateDate, raw.MediaCreateDate, raw.TrackCreateDate),
    };
  } catch (error) {
    console.warn(`Could not read metadata for ${filePath}:`, error);
    return { tags: [], description: '', artist: '' };
  }
}

export async function writeMetadata(
  filePath: string,
  updates: { tags?: string[]; description?: string },
): Promise<void> {
  if (isMarkdownFile(filePath)) {
    await writeMarkdownMetadata(filePath, updates);
    return;
  }

  const payload: Record<string, unknown> = {};
  if (updates.tags) {
    const tags = Array.from(new Set(updates.tags.map(safeTag).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b),
    );
    payload.Keywords = tags;
    payload.Subject = tags;
    payload.HierarchicalSubject = tags.map((tag) => tag.replaceAll('/', '|'));
  }
  if (updates.description !== undefined) {
    payload.Description = updates.description;
    payload.ImageDescription = updates.description;
  }
  await exiftool.write(filePath, payload, ['-overwrite_original']);
}

export async function closeMetadataTools(): Promise<void> {
  await exiftool.end();
}

function isMarkdownFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.md';
}

function parseMarkdownFrontmatter(content: string): MarkdownFrontmatter {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { tags: [], description: '', artist: '', body: content };
  }

  const newline = normalized.startsWith('---\r\n') ? '\r\n' : '\n';
  const start = 3 + newline.length;
  const closeNeedle = `${newline}---${newline}`;
  const closeIndex = normalized.indexOf(closeNeedle, start);
  if (closeIndex === -1) {
    return { tags: [], description: '', artist: '', body: content };
  }

  const rawFrontmatter = normalized.slice(start, closeIndex);
  const body = normalized.slice(closeIndex + closeNeedle.length);
  return {
    tags: parseFrontmatterTags(rawFrontmatter).map(safeTag).filter(Boolean),
    description: parseFrontmatterScalar(rawFrontmatter, 'description'),
    artist: parseFrontmatterScalar(rawFrontmatter, 'artist'),
    body,
  };
}

function parseFrontmatterTags(rawFrontmatter: string): string[] {
  const lines = rawFrontmatter.split(/\r?\n/);
  const tags: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const scalar = line.match(/^tags:\s*(.+?)\s*$/);
    if (scalar) {
      return parseTagScalar(scalar[1]);
    }
    if (!/^tags:\s*$/.test(line)) continue;
    for (let child = index + 1; child < lines.length; child += 1) {
      const item = lines[child].match(/^\s*-\s*(.+?)\s*$/);
      if (!item) break;
      tags.push(unquoteFrontmatterValue(item[1]));
    }
    return tags;
  }
  return [];
}

function parseTagScalar(value: string): string[] {
  const clean = value.trim();
  if (clean.startsWith('[') && clean.endsWith(']')) {
    return clean
      .slice(1, -1)
      .split(',')
      .map((part) => unquoteFrontmatterValue(part.trim()))
      .filter(Boolean);
  }
  return clean.split(',').map((part) => unquoteFrontmatterValue(part.trim())).filter(Boolean);
}

function parseFrontmatterScalar(rawFrontmatter: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = rawFrontmatter.match(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, 'm'));
  return match ? unquoteFrontmatterValue(match[1]) : '';
}

function unquoteFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

async function writeMarkdownMetadata(filePath: string, updates: { tags?: string[]; description?: string }): Promise<void> {
  const content = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
  const current = parseMarkdownFrontmatter(content);
  const tags = updates.tags
    ? Array.from(new Set(updates.tags.map(safeTag).filter(Boolean))).sort((a, b) => a.localeCompare(b))
    : current.tags;
  const description = updates.description !== undefined ? updates.description : current.description;
  const frontmatter = formatMarkdownFrontmatter({ ...current, tags, description });
  await fs.promises.writeFile(filePath, `${frontmatter}${current.body}`, 'utf8');
}

function formatMarkdownFrontmatter(metadata: Pick<MarkdownFrontmatter, 'tags' | 'description' | 'artist'>): string {
  const lines = ['---'];
  if (metadata.tags.length === 0) {
    lines.push('tags: []');
  } else {
    lines.push('tags:');
    metadata.tags.forEach((tag) => lines.push(`  - ${JSON.stringify(tag)}`));
  }
  if (metadata.description) lines.push(`description: ${JSON.stringify(metadata.description)}`);
  if (metadata.artist) lines.push(`artist: ${JSON.stringify(metadata.artist)}`);
  lines.push('---', '');
  return lines.join('\n');
}
