import { describe, expect, it } from 'vitest';
import { mediaId, normalizeSlashes, normalizeTag, resolveKnownTagPath, tagExpressionMatches } from './scanner.js';
import { isMediaExtension, mediaKindForExtension } from './thumbnails.js';

describe('scanner path helpers', () => {
  it('normalizes Windows separators for stable web paths', () => {
    expect(normalizeSlashes('Artist\\Pose\\image.jpg')).toBe('Artist/Pose/image.jpg');
  });

  it('creates stable ids from library and relative path', () => {
    expect(mediaId('default', 'Artist/Pose/image.jpg')).toBe(mediaId('default', 'Artist\\Pose\\image.jpg'));
    expect(mediaId('default', 'Artist/Pose/image.jpg')).not.toBe(mediaId('public', 'Artist/Pose/image.jpg'));
  });

  it('canonicalizes common nested tag separators', () => {
    expect(normalizeTag('Animals > Dogs -> Fido')).toBe('animals/dogs/fido');
    expect(normalizeTag('Animals|Cats|Miso')).toBe('animals/cats/miso');
  });

  it('resolves unique visible child tag labels back to their full hierarchy', () => {
    const knownTags = ['animals', 'animals/dog', 'animals/dog/dogname', 'people/dog'];
    expect(resolveKnownTagPath('Dog', ['animals', 'animals/dog', 'animals/dog/dogname'])).toBe('animals/dog');
    expect(resolveKnownTagPath('DOG', ['animals', 'animals/dog', 'dog'])).toBe('animals/dog');
    expect(resolveKnownTagPath('DogName', knownTags)).toBe('animals/dog/dogname');
    expect(resolveKnownTagPath('Animals/Dog', knownTags)).toBe('animals/dog');
    expect(resolveKnownTagPath('Dog', knownTags)).toBe('dog');
  });

  it('matches tag filter expressions with AND, OR, and parentheses', () => {
    expect(tagExpressionMatches('(dog OR cat) AND food', ['Animals/Dog/DogName', 'Food'])).toBe(true);
    expect(tagExpressionMatches('(dog OR cat) AND food', ['Animals/Cat/CatName'])).toBe(false);
    expect(tagExpressionMatches('dog OR cat AND food', ['Animals/Dog/DogName'])).toBe(true);
    expect(tagExpressionMatches('dog, food', ['Animals/Dog/DogName', 'Food'])).toBe(true);
  });

  it('classifies supported document and companion file extensions', () => {
    for (const extension of ['doc', 'docx', 'rtf', 'odt', 'md']) {
      expect(isMediaExtension(extension)).toBe(true);
      expect(mediaKindForExtension(extension)).toBe('text');
    }

    for (const extension of ['clip', 'html', 'wpe', 'wpb', 'tgs']) {
      expect(isMediaExtension(extension)).toBe(true);
      expect(mediaKindForExtension(extension)).toBe('file');
    }
  });
});
