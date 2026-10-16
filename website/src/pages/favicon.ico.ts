import type { APIRoute } from 'astro';

import master from '../../../resources/icon.svg?raw';
import { framed, ico, png } from '../icon.ts';

export const GET: APIRoute = async () => {
  const tile = framed(master);
  const images = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(tile, size) })));
  return new Response(new Uint8Array(ico(images)), { headers: { 'Content-Type': 'image/x-icon' } });
};
