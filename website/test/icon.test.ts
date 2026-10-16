import assert from 'node:assert/strict';
import { test } from 'node:test';

import sharp from 'sharp';

import { readRootText } from '../scripts/root.ts';
import { framed, ico, png } from '../src/icon.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('the tile wraps the master and refuses anything else', async () => {
  const master = await readRootText('resources/icon.svg');
  const body = master.trim().replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  assert.ok(framed(master).includes(`<g clip-path="url(#tile)">${body}</g>`));
  assert.throws(() => framed('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>'), /no longer a 128×128/);
});

test('the tile leaves its corners transparent and the master does not', async () => {
  const master = await readRootText('resources/icon.svg');
  const corner = async (svg: string) => (await sharp(await png(svg, 64)).raw().toBuffer())[3];
  assert.equal(await corner(master), 255);
  assert.equal(await corner(framed(master)), 0);
});

test('the ICO directory points at each embedded PNG', async () => {
  const tile = framed(await readRootText('resources/icon.svg'));
  const images = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(tile, size) })));
  const file = ico(images);
  assert.equal(file.readUInt16LE(2), 1);
  assert.equal(file.readUInt16LE(4), images.length);
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    assert.equal(file.readUInt8(entry), size);
    assert.equal(file.readUInt32LE(entry + 8), data.length);
    const offset = file.readUInt32LE(entry + 12);
    assert.deepEqual(file.subarray(offset, offset + 8), PNG_SIGNATURE);
  });
});
