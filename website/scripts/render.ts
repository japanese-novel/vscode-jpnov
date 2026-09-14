/** `npm run render`: writes src/generated/renders.json from the product's own renders (see pipeline.ts). */
import { writeIfChanged } from '../../scripts/write.ts';
import { assertGenerated, sitePath } from './root.ts';

await assertGenerated();
const { buildRenders, serialize } = await import('./pipeline.ts');
const out = sitePath('src/generated/renders.json');
const changed = await writeIfChanged(out, serialize(await buildRenders()));
console.log(`${changed ? 'wrote' : 'unchanged'} ${out}`);
