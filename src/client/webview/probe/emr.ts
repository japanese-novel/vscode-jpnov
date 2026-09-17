/** The compiler's inline probe (css.ts emrProbe()): pins each 傍点 line's --emr-shift once at load. */
import { pinEmrShift } from './emrShift.ts';

pinEmrShift(document);
