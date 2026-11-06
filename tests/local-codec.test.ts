import { describe, expect, it } from 'vitest';
import { decodeLocalState, encodeLocalState } from '../src/lib/localCodec';

describe('compact local workspace storage', () => {
  it('preserves multilingual text, fractional timings and separate documents', () => {
    const source = { title: '合声 · 测试', notes: [{ start: .125, duration: .375, lyric: '你好 🌙' }], arrangement: { title: 'SATB' } };
    expect(decodeLocalState(encodeLocalState(source))).toEqual(source);
  });
  it('reads existing plain JSON without changing it', () => {
    const value = '{"title":"old workspace","parts":[]}';
    expect(decodeLocalState(value)).toEqual(JSON.parse(value));
  });
  it('substantially reduces repeated note-field storage without dropping events', () => {
    const value = { notes: Array.from({ length: 5000 }, (_, i) => ({ id: `note-${i}`, midi: 60 + i % 8, start: i / 2, duration: .375, velocity: .8, origin: 'transcribed' })) };
    const encoded = encodeLocalState(value);
    expect(encoded.length).toBeLessThan(JSON.stringify(value).length * .2);
    expect(decodeLocalState(encoded)).toEqual(value);
  });
  it('rejects malformed lengths and a compressed payload exceeding its declaration', () => {
    const encoded = encodeLocalState({ text: 'x'.repeat(10000) });
    expect(() => decodeLocalState(encoded.replace(/^coro-z1:\d+:/, 'coro-z1:2:'))).toThrow();
    expect(() => decodeLocalState('coro-z1:99999999999:AAAA')).toThrow();
    expect(() => decodeLocalState(encoded.slice(0, -4))).toThrow();
  });
});
