import { describe, expect, it } from 'vitest';
import { mediaId, normalizeSlashes, normalizeTag, resolveKnownTagPath, tagExpressionMatches } from './scanner.js';

describe('scanner path helpers', () => {
  it('normalizes Windows separators for stable web paths', () => {
    expect(normalizeSlashes('Artist\\Pose\\image.jpg')).toBe('Artist/Pose/image.jpg');
  });

  it('creates stable ids from library and relative path', () => {
    expect(mediaId('default', 'Artist/Pose/image.jpg')).toBe(mediaId('default', 'Artist\\Pose\\image.jpg'));
    expect(mediaId('default', 'Artist/Pose/image.jpg')).not.toBe(mediaId('public', 'Artist/Pose/image.jpg'));
  });

  it('canonicalizes common nested tag separators', () => {
    expect(normalizeTag('Animals > Dogs -> Fido')).toBe('Animals/Dogs/Fido');
    expect(normalizeTag('Animals|Cats|Miso')).toBe('Animals/Cats/Miso');
  });

  it('resolves unique visible child tag labels back to their full hierarchy', () => {
    const knownTags = ['Animals', 'Animals/Dog', 'Animals/Dog/DogName', 'People/Dog'];
    expect(resolveKnownTagPath('Dog', ['Animals', 'Animals/Dog', 'Animals/Dog/DogName'])).toBe('Animals/Dog');
    expect(resolveKnownTagPath('Dog', ['Animals', 'Animals/Dog', 'Dog'])).toBe('Animals/Dog');
    expect(resolveKnownTagPath('DogName', knownTags)).toBe('Animals/Dog/DogName');
    expect(resolveKnownTagPath('Animals/Dog', knownTags)).toBe('Animals/Dog');
    expect(resolveKnownTagPath('Dog', knownTags)).toBe('Dog');
  });

  it('matches tag filter expressions with AND, OR, and parentheses', () => {
    expect(tagExpressionMatches('(dog OR cat) AND food', ['Animals/Dog/DogName', 'Food'])).toBe(true);
    expect(tagExpressionMatches('(dog OR cat) AND food', ['Animals/Cat/CatName'])).toBe(false);
    expect(tagExpressionMatches('dog OR cat AND food', ['Animals/Dog/DogName'])).toBe(true);
    expect(tagExpressionMatches('dog, food', ['Animals/Dog/DogName', 'Food'])).toBe(true);
  });
});
