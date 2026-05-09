import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { paths } from './config.js';

const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff', 'bmp', 'svg']);
const videoExtensions = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogg', 'ogv', 'mkv']);

export type ThumbnailSize = 'grid' | 'preview';

const thumbnailSizes: Record<ThumbnailSize, number> = {
  grid: 360,
  preview: 960,
};

export function isImageExtension(extension: string): boolean {
  return imageExtensions.has(extension.toLowerCase());
}

export function isVideoExtension(extension: string): boolean {
  return videoExtensions.has(extension.toLowerCase());
}

export function isMediaExtension(extension: string): boolean {
  return isImageExtension(extension) || isVideoExtension(extension);
}

export function thumbnailPathFor(id: string, size: ThumbnailSize = 'grid'): string {
  return path.join(paths.thumbnailDir, `${id}-${size}.jpg`);
}

export async function ensureThumbnail(id: string, filePath: string, extension: string): Promise<boolean> {
  try {
    const source = await fs.promises.stat(filePath);
    await fs.promises.mkdir(paths.thumbnailDir, { recursive: true });

    for (const size of Object.keys(thumbnailSizes) as ThumbnailSize[]) {
      const outputPath = thumbnailPathFor(id, size);
      const existing = await fs.promises.stat(outputPath).catch(() => undefined);
      if (existing && existing.mtimeMs >= source.mtimeMs && existing.size > 0) continue;

      if (isImageExtension(extension)) {
        await sharp(filePath, { animated: false, limitInputPixels: false })
          .rotate()
          .resize({ width: thumbnailSizes[size], height: thumbnailSizes[size], fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: size === 'grid' ? 78 : 84, mozjpeg: true })
          .toFile(outputPath);
      } else if (isVideoExtension(extension)) {
        await renderVideoThumbnail(filePath, outputPath, thumbnailSizes[size]);
      }
    }
    return true;
  } catch (error) {
    console.warn(`Could not create thumbnail for ${filePath}:`, error);
  }
  return false;
}

function renderVideoThumbnail(inputPath: string, outputPath: string, width: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss',
      '00:00:01',
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-1:force_original_aspect_ratio=decrease`,
      outputPath,
    ];
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg exited with ${code}`));
    });
  });
}
