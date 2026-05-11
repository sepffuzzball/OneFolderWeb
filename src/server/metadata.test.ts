import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMetadata, writeMetadata } from './metadata.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

async function tempMarkdown(content: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'onefolder-md-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'note.md');
  await fs.promises.writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('markdown metadata', () => {
  it('reads tags and description from frontmatter', async () => {
    const filePath = await tempMarkdown(`---
tags:
  - Animals > Dogs
  - "People/Family"
description: "A field note"
---
# Hello
`);

    await expect(readMetadata(filePath)).resolves.toMatchObject({
      tags: ['Animals/Dogs', 'People/Family'],
      description: 'A field note',
    });
  });

  it('writes tags and description without changing the markdown body', async () => {
    const filePath = await tempMarkdown('# Hello\n\nBody text.\n');

    await writeMetadata(filePath, { tags: ['Projects > OneFolder', 'notes'], description: 'Readable note' });

    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(content).toContain('tags:\n  - "notes"\n  - "Projects/OneFolder"');
    expect(content).toContain('description: "Readable note"');
    expect(content.endsWith('# Hello\n\nBody text.\n')).toBe(true);
    await expect(readMetadata(filePath)).resolves.toMatchObject({
      tags: ['notes', 'Projects/OneFolder'],
      description: 'Readable note',
    });
  });
});
