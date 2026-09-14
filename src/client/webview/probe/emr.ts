/** The compiler's inline probe (css.ts emrProbe()): pins the document's --emr-shift once at load. */
import { pinEmrShift } from './emrShift.ts';

pinEmrShift(document, document.documentElement);
