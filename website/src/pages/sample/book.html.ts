/** The sample book as the product builds it, byte for byte: the stage's 印刷／PDF 保存 link opens it. */
import type { APIRoute } from 'astro';

import { RENDERS } from '../../renders.ts';

export const GET: APIRoute = () => new Response(RENDERS.artifacts.book, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
