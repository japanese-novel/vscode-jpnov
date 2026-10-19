/** The build-time renders (src/generated/renders.json) typed once, with each sample fetched as its kind. */
import renders from './generated/renders.json';
import type { Renders, SampleName, SampleRender } from '../scripts/contract.ts';

export const RENDERS = renders as Renders;

export function sampleOf<K extends SampleRender['kind']>(name: SampleName, kind: K): Extract<SampleRender, { kind: K }> {
  const sample = RENDERS.samples[name];
  if (sample.kind !== kind) {
    throw new Error(`${name} must be a ${kind} render`);
  }
  return sample as Extract<SampleRender, { kind: K }>;
}
