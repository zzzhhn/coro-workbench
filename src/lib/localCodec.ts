import { strFromU8, strToU8, Unzlib, zlibSync } from 'fflate';

const PREFIX = 'coro-z1:';
const MAX_BYTES = 128 * 1024 * 1024;

export function encodeLocalState(value: unknown): string {
  const raw = strToU8(JSON.stringify(value));
  if (raw.length > MAX_BYTES) throw new Error('本机工程库过大，请先导出重要工程备份。');
  const compressed = zlibSync(raw, { level: 6 });
  let binary = '';
  for (let i = 0; i < compressed.length; i += 8192)
    binary += String.fromCharCode(...compressed.subarray(i, i + 8192));
  return `${PREFIX}${raw.length}:${btoa(binary)}`;
}

export function decodeLocalState(value: string): unknown {
  if (!value.startsWith(PREFIX)) return JSON.parse(value);
  const separator = value.indexOf(':', PREFIX.length);
  const expected = Number(value.slice(PREFIX.length, separator));
  if (separator < 0 || !Number.isInteger(expected) || expected < 1 || expected > MAX_BYTES || value.length > MAX_BYTES)
    throw new Error('本机工程缓存大小无效。');
  const compressed = Uint8Array.from(atob(value.slice(separator + 1)), (char) => char.charCodeAt(0));
  const chunks: Uint8Array[] = [];
  let length = 0;
  const decoder = new Unzlib((chunk) => {
    length += chunk.length;
    if (length > expected) throw new Error('本机工程缓存超出声明大小。');
    chunks.push(chunk);
  });
  // Small input chunks bound temporary decompression memory for corrupt data.
  for (let i = 0; i < compressed.length; i += 2048)
    decoder.push(compressed.subarray(i, i + 2048), i + 2048 >= compressed.length);
  if (length !== expected) throw new Error('本机工程缓存不完整。');
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(strFromU8(raw));
}
