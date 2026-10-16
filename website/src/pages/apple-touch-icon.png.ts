import type { APIRoute } from 'astro';

import master from '../../../resources/icon.svg?raw';
import { png } from '../icon.ts';

export const GET: APIRoute = async () => new Response(new Uint8Array(await png(master, 180)), { headers: { 'Content-Type': 'image/png' } });
