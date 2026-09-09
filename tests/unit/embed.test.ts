import { describe, expect, it } from 'vitest';

import { buildDiscordPayload, LIMITS, truncate } from '../../src/embed.ts';
import { SAMPLE_NOTIFICATION } from '../helpers.ts';

/**
 * Measured in UTF-16 units — deliberately NOT the code-point helper the
 * implementation used to share, so these assertions check the code against the
 * conservative reading of Discord's limit rather than agreeing with it.
 */
const units = (value: string) => value.length;

/** Everything Discord counts against the 6000 budget, for our embed shape. */
function budgetUsed(payload: ReturnType<typeof buildDiscordPayload>): number {
  return payload.embeds.reduce(
    (total, embed) =>
      total +
      units(embed.title ?? '') +
      units(embed.description ?? '') +
      units(embed.footer?.text ?? ''),
    0,
  );
}

describe('truncate', () => {
  it('leaves a short string untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('leaves a string of exactly the limit untouched', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('marks a truncated string with an ellipsis and respects the limit', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(units(truncate('hello world', 8))).toBe(8);
  });

  it('never splits a surrogate pair', () => {
    // Each 🚨 is one code point but two UTF-16 units, so a limit of 3 fits one
    // siren plus the ellipsis. A naive slice(0, n) would emit a lone surrogate.
    const result = truncate('🚨🚨🚨🚨', 3);

    expect(result).toBe('🚨…');
    expect(result.isWellFormed()).toBe(true);
  });

  it('leaves a unit unused rather than splitting the last code point', () => {
    // Budget 4 = ellipsis (1) + 3 units of room, but a siren costs 2, so only
    // one fits and the result is 3 units long.
    const result = truncate('🚨🚨🚨', 4);

    expect(result).toBe('🚨…');
    expect(units(result)).toBeLessThanOrEqual(4);
    expect(result.isWellFormed()).toBe(true);
  });

  it('caps in UTF-16 units, not code points', () => {
    // The regression this guards: counting code points here would return 8191
    // UTF-16 units for a 4096 budget, which Discord may reject outright.
    const result = truncate('🚨'.repeat(5000), 4096);

    expect(units(result)).toBeLessThanOrEqual(4096);
    expect(result.isWellFormed()).toBe(true);
  });

  it('returns an empty string for a non-positive limit', () => {
    expect(truncate('hello', 0)).toBe('');
    expect(truncate('hello', -5)).toBe('');
  });
});

describe('buildDiscordPayload', () => {
  it('maps the documented example onto a single embed', () => {
    const { embeds } = buildDiscordPayload(SAMPLE_NOTIFICATION);

    expect(embeds).toHaveLength(1);
    expect(embeds[0]).toEqual({
      title: SAMPLE_NOTIFICATION.subject,
      description: SAMPLE_NOTIFICATION.message,
      footer: { text: 'low_credit • 7e9a2c4e6f9e4a24a53b77c2d8e3f0aa' },
      timestamp: '2026-03-02T22:20:00.123Z',
    });
  });

  it('converts a fractional epoch to an ISO 8601 string', () => {
    const { embeds } = buildDiscordPayload({ ...SAMPLE_NOTIFICATION, timestamp: 1772490000 });

    expect(embeds[0]?.timestamp).toBe('2026-03-02T22:20:00.000Z');
  });

  it('truncates an oversized title to the Discord limit', () => {
    const { embeds } = buildDiscordPayload({
      ...SAMPLE_NOTIFICATION,
      subject: 'a'.repeat(LIMITS.title + 500),
    });

    expect(units(embeds[0]?.title ?? '')).toBe(LIMITS.title);
    expect(embeds[0]?.title?.endsWith('…')).toBe(true);
  });

  it('truncates an oversized description to the Discord limit', () => {
    const { embeds } = buildDiscordPayload({
      ...SAMPLE_NOTIFICATION,
      message: 'b'.repeat(LIMITS.description + 500),
    });

    expect(units(embeds[0]?.description ?? '')).toBe(LIMITS.description);
  });

  it('keeps the combined length within the 6000 total budget', () => {
    // Per-field caps alone allow 256 + 4096 + 2048 = 6400, which Discord would
    // reject outright. This is the case that guard exists for.
    const payload = buildDiscordPayload({
      ...SAMPLE_NOTIFICATION,
      subject: 'a'.repeat(1000),
      message: 'b'.repeat(10_000),
      notif_type: 'c'.repeat(1500),
      event_id: 'd'.repeat(1500),
    });

    expect(budgetUsed(payload)).toBeLessThanOrEqual(LIMITS.total);
    // The title and footer survive intact; only the description gives way.
    expect(units(payload.embeds[0]?.title ?? '')).toBe(LIMITS.title);
    expect(units(payload.embeds[0]?.footer?.text ?? '')).toBe(LIMITS.footer);
  });

  it('stays within budget for the worst case at every field cap', () => {
    const payload = buildDiscordPayload({
      ...SAMPLE_NOTIFICATION,
      subject: '🚨'.repeat(LIMITS.title),
      message: '🚨'.repeat(LIMITS.description),
      notif_type: '🚨'.repeat(LIMITS.footer),
      event_id: '🚨'.repeat(LIMITS.footer),
    });

    expect(budgetUsed(payload)).toBeLessThanOrEqual(LIMITS.total);
  });

  it('holds every per-field cap for an all-emoji payload', () => {
    // The F1 case: with code-point counting each of these came out at twice its
    // cap in UTF-16 units while appearing to be within budget.
    const embed = buildDiscordPayload({
      ...SAMPLE_NOTIFICATION,
      subject: '🚨'.repeat(5000),
      message: '🚨'.repeat(5000),
      notif_type: '🚨'.repeat(5000),
      event_id: '🚨'.repeat(5000),
    }).embeds[0];

    expect(units(embed?.title ?? '')).toBeLessThanOrEqual(LIMITS.title);
    expect(units(embed?.description ?? '')).toBeLessThanOrEqual(LIMITS.description);
    expect(units(embed?.footer?.text ?? '')).toBeLessThanOrEqual(LIMITS.footer);
    expect(JSON.stringify(embed).isWellFormed()).toBe(true);
  });

  it('omits the timestamp when the date falls outside year 0000-9999', () => {
    // toISOString() would emit `+275760-09-13T…`, which Discord's ISO 8601
    // parser rejects — losing the whole message rather than just the date.
    const { embeds } = buildDiscordPayload({ ...SAMPLE_NOTIFICATION, timestamp: 8.64e12 });

    expect(embeds[0]).not.toHaveProperty('timestamp');
    // The rest of the message still goes out.
    expect(embeds[0]?.title).toBe(SAMPLE_NOTIFICATION.subject);
    expect(embeds[0]?.footer?.text).toContain('low_credit');
  });

  it('keeps the timestamp for a date Discord can parse', () => {
    const { embeds } = buildDiscordPayload({ ...SAMPLE_NOTIFICATION, timestamp: 0 });

    expect(embeds[0]?.timestamp).toBe('1970-01-01T00:00:00.000Z');
  });

  it('omits an empty title and description rather than sending blanks', () => {
    const { embeds } = buildDiscordPayload({
      ...SAMPLE_NOTIFICATION,
      subject: '',
      message: '',
    });

    expect(embeds[0]).not.toHaveProperty('title');
    expect(embeds[0]).not.toHaveProperty('description');
    // The footer keeps the embed non-empty, which Discord requires.
    expect(embeds[0]?.footer?.text).toBe('low_credit • 7e9a2c4e6f9e4a24a53b77c2d8e3f0aa');
  });

  it('renders an unrecognised notif_type without special-casing', () => {
    const { embeds } = buildDiscordPayload({
      ...SAMPLE_NOTIFICATION,
      notif_type: 'some_future_event_type',
    });

    expect(embeds[0]?.footer?.text).toBe(
      'some_future_event_type • 7e9a2c4e6f9e4a24a53b77c2d8e3f0aa',
    );
  });
});
