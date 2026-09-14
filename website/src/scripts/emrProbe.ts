/**
 * The product's 傍点 probe (src/client/webview/probe/emrShift.ts), run per embedded render: the
 * container is both the root to measure under and the element that carries `--emr-shift`,
 * where the product uses the document and its root element.
 */
import { pinEmrShift } from '../../../src/client/webview/probe/emrShift.ts';

export function probeAll(root: ParentNode = document): void {
  for (const scope of root.querySelectorAll<HTMLElement>('.jp-scope')) {
    if (scope.querySelector('.emr') !== null) {
      pinEmrShift(scope, scope);
    }
  }
}
