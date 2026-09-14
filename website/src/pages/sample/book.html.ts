/** The sample book as the product builds it, byte for byte: the stage's 印刷／PDF 保存 link opens it. */
import type { APIRoute } from 'astro';

import renders from '../../generated/renders.json';
import type { Renders } from '../../../scripts/contract.ts';

export const GET: APIRoute = () =>
  new Response((renders as Renders).artifacts.book, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
