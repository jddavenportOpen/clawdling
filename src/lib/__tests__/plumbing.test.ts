import { describe, it, expect } from 'vitest';
import { isPlumbingText, stripPlumbing } from '@/lib/plumbing';

describe('isPlumbingText', () => {
  it('flags whole-string plumbing markers', () => {
    expect(isPlumbingText('<task-notification>bg done</task-notification>')).toBe(true);
    expect(isPlumbingText('<local-command-caveat>x</local-command-caveat>')).toBe(true);
    expect(isPlumbingText('<command-name>/compact</command-name>')).toBe(true);
    expect(isPlumbingText('No response requested.')).toBe(true);
  });
  it('does not flag real prose that merely mentions a tag', () => {
    expect(isPlumbingText('can you run /compact for me?')).toBe(false);
    expect(isPlumbingText('I saw a <task-notification> earlier — here is the fix')).toBe(false);
    expect(isPlumbingText('')).toBe(false);
  });
});

describe('stripPlumbing', () => {
  it('removes a closed plumbing block but keeps surrounding prose', () => {
    const input = 'Here is your answer.\n<task-notification>bg task done</task-notification>\nMore text.';
    expect(stripPlumbing(input)).toBe('Here is your answer.\n\nMore text.');
  });

  it('removes an unclosed trailing block mid-stream', () => {
    const input = 'Done.\n<task-notification>still streaming the notif';
    expect(stripPlumbing(input)).toBe('Done.');
  });

  it('strips a standalone "No response requested." sentinel line', () => {
    expect(stripPlumbing('All set.\nNo response requested.')).toBe('All set.');
  });

  it('leaves clean assistant text untouched', () => {
    const text = '## Heading\n\nSome **bold** and a list:\n- a\n- b';
    expect(stripPlumbing(text)).toBe(text);
  });

  it('handles multiple interleaved blocks', () => {
    const input =
      '<command-name>/compact</command-name>\nReal content here.\n<local-command-stdout>dump</local-command-stdout>';
    expect(stripPlumbing(input)).toBe('Real content here.');
  });

  it('returns empty string for null/undefined', () => {
    expect(stripPlumbing(null)).toBe('');
    expect(stripPlumbing(undefined)).toBe('');
  });
});
