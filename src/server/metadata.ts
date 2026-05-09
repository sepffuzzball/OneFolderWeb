import { exiftool } from 'exiftool-vendored';

type MetadataValue = string | string[] | number | Date | undefined;
type MetadataMap = Record<string, MetadataValue>;

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
