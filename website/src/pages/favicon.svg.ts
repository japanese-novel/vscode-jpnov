import type { APIRoute } from 'astro';

import master from '../../../resources/icon.svg?raw';
import { framed } from '../icon.ts';

export const GET: APIRoute = () => new Response(framed(master), { headers: { 'Content-Type': 'image/svg+xml' } });
