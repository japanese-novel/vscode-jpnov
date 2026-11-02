// Entry for `node --import ./test/register.mjs --test …` (all test scripts route through it).
import { registerHooks } from 'node:module';

import { resolve } from './resolve-hooks.mjs';

registerHooks({ resolve });
