import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyAutoTcy, materializeAutoTcy } from '../../../src/shared/compiler/autoTcy.ts';
import { concatBookText } from '../../../src/shared/compiler/document.ts';

// `none` is asserted globally below (applyAutoTcy returns the source UNCHANGED — same object).

test('E1: every exactly-2 pair on a line is wrapped, each binding its own run', () => {
  assert.equal(
    materializeAutoTcy('あ!!い!?う!!'),
    'あ!!［＃「!!」は縦中横］い!?［＃「!?」は縦中横］う!!［＃「!!」は縦中横］',
  );
});

test('E2: a pair at the line head wraps without creating a line-head annotation hazard', () => {
  assert.equal(materializeAutoTcy('!!です'), '!!［＃「!!」は縦中横］です');
});

test('E3/E4: pairs inside brackets and dialogue wrap; the delimiters stay untouched', () => {
  assert.equal(materializeAutoTcy('（!?）'), '（!?［＃「!?」は縦中横］）');
  assert.equal(materializeAutoTcy('「!?」'), '「!?［＃「!?」は縦中横］」');
});

test('E5: a pair adjacent to an unrelated annotation still wraps, order preserved', () => {
  assert.equal(materializeAutoTcy('!?［＃太字］'), '!?［＃「!?」は縦中横］［＃太字］');
});

test('E6: idempotent over the postfix form (a materialized txt round-trips unchanged)', () => {
  const once = materializeAutoTcy('えっ!?」と叫んだ');
  assert.equal(once, 'えっ!?［＃「!?」は縦中横］」と叫んだ');
  assert.equal(materializeAutoTcy(once), once);
  // A hand-written adjacent postfix counts as already marked too.
  assert.equal(materializeAutoTcy('!?［＃「!?」は縦中横］'), '!?［＃「!?」は縦中横］');
});

test('E7: pairs inside a manual ［＃縦中横］ span are already marked (手動 > 自動)', () => {
  const src = '［＃縦中横］!?［＃縦中横終わり］';
  assert.equal(materializeAutoTcy(src), src);
  // The manual span is line-local: a pair on the NEXT line is fair game again.
  assert.equal(
    materializeAutoTcy('［＃縦中横］!?\nまた!?'),
    '［＃縦中横］!?\nまた!?［＃「!?」は縦中横］',
  );
});

test('E8/E9: runs of 3+ are never touched — not even split into pairs', () => {
  for (const src of ['わっ!!!', 'え????', 'お!?!だ', '!!!!']) {
    assert.equal(materializeAutoTcy(src), src);
  }
});

test('E10: full-width ！？ never trigger (half-width 0x21/0x3F only)', () => {
  assert.equal(materializeAutoTcy('え！？'), 'え！？');
});

test('E11: a pair serving as a ruby base or reading is not body text — untouched', () => {
  const explicitBase = '｜!?《はてな》';
  assert.equal(materializeAutoTcy(explicitBase), explicitBase);
  const heldBase = '｜!?［＃x］《はてな》'; // a ｜ base holding an annotation is a base all the same
  assert.equal(materializeAutoTcy(heldBase), heldBase);
  const insideReading = '漢《!?》';
  assert.equal(materializeAutoTcy(insideReading), insideReading);
});

test('E12: single marks never trigger; no gate on adjacent Latin (What?! combines)', () => {
  assert.equal(materializeAutoTcy('あ!か'), 'あ!か');
  // No Latin-flank gate: an English-context pair combines like any other.
  assert.equal(materializeAutoTcy('What?!'), 'What?!［＃「?!」は縦中横］');
});

test('applyAutoTcy: none is byte-identical passthrough, punctuationPairs materializes', () => {
  const src = 'えっ!?';
  assert.equal(applyAutoTcy(src, 'none'), src);
  assert.equal(applyAutoTcy(src, 'punctuationPairs'), 'えっ!?［＃「!?」は縦中横］');
});

test('concatBookText materializes per file under punctuationPairs and round-trips', () => {
  const book = {
    files: [
      { name: 'a.jpnov', src: '驚き!!だ\n' },
      { name: 'b.jpnov', src: '次!?\n' },
    ],
  };
  const txt = concatBookText(book, 'punctuationPairs', 40);
  assert.equal(txt, '驚き!!［＃「!!」は縦中横］だ\n\n次!?［＃「!?」は縦中横］');
  // Feeding the materialized txt back through the pass changes nothing (idempotent).
  assert.equal(materializeAutoTcy(txt), txt);
  // none keeps the byte-faithful concat (chapters separated by the one blank glue line).
  assert.equal(concatBookText(book, 'none', 40), '驚き!!だ\n\n次!?');
});

test('CRLF: the rewrite keeps the \\r; the postfix lands before it', () => {
  const once = materializeAutoTcy('えっ!?\r\n次');
  assert.equal(once, 'えっ!?［＃「!?」は縦中横］\r\n次');
  assert.equal(materializeAutoTcy(once), once);
});
