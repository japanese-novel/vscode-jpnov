/** The site's icon files, derived from the full-bleed master resources/icon.svg. */
import sharp from 'sharp';

const OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">';
const CLOSE = '</svg>';

/** The rounded tile of the marketplace icon: the master clipped 2px in, with a faint paper rim. */
export function framed(master: string): string {
  const body = master.trim();
  if (!body.startsWith(OPEN) || !body.endsWith(CLOSE)) {
    throw new Error('icon: the master is no longer a 128×128 <svg>; update OPEN here');
  }
  return `${OPEN}
  <clipPath id="tile"><rect x="2" y="2" width="124" height="124" rx="28"/></clipPath>
  <g clip-path="url(#tile)">${body.slice(OPEN.length, -CLOSE.length)}</g>
  <rect x="2.75" y="2.75" width="122.5" height="122.5" rx="27.4" fill="none" stroke="#F4EDDD" stroke-opacity=".08" stroke-width="1.5"/>
${CLOSE}
`;
}

export function png(svg: string, size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: (72 * size) / 128 }).resize(size, size).png().toBuffer();
}

/** An ICO that embeds each PNG as is (ICONDIR, one ICONDIRENTRY per image, then the data). */
export function ico(images: readonly { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    head.writeUInt8(size % 256, entry);
    head.writeUInt8(size % 256, entry + 1);
    head.writeUInt16LE(1, entry + 4);
    head.writeUInt16LE(32, entry + 6);
    head.writeUInt32LE(data.length, entry + 8);
    head.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(({ data }) => data)]);
}
