/**
 * The preview bundle's entry (runs in the preview panel's browser realm): the cursor-follow
 * scroller, then the layout widget. Both read the host's `__INIT` bootstrap and share the one
 * VS Code API instance in api.ts.
 */
import './scroll.ts';
import './widget.ts';
