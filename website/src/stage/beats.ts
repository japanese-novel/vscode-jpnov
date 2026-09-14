/** The five beats of the stage: id, caption, and scroll budget in timeline seconds. */
export type BeatId = 'write' | 'check' | 'collect' | 'fix' | 'book';

export interface Beat {
  readonly id: BeatId;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  /** Timeline seconds; one second is 50 vh of scroll. */
  readonly duration: number;
}

export const BEATS: readonly Beat[] = [
  {
    id: 'write',
    heading: '書く',
    paragraphs: ['ふつうに書くだけです。ルビや傍点は、青空文庫の注記で書き添えます。改行すると行頭に全角スペースが入り、「 で書き始めればそのスペースは自動で外れます。'],
    duration: 3,
  },
  {
    id: 'check',
    heading: '確かめる',
    paragraphs: ['「プレビューを横に開く」で、原稿の横に縦書きの組み上がりが表示されます。ルビ・傍点・縦中横も改ページの目印も、入力するたびにすぐ反映されます。カーソルを動かすと、プレビューも同じ場所へ移動します。'],
    duration: 2.4,
  },
  {
    id: 'collect',
    heading: 'まとめる',
    paragraphs: ['章を読む順に並べたものが、本です。「本の一覧」で章の追加や並べ替え、タイトルやヘッダーの編集がその場でできます。'],
    duration: 2.6,
  },
  {
    id: 'fix',
    heading: '整える',
    paragraphs: ['書いている間、原稿を静かに点検します。行頭の字下げや文末の句点など、指摘の多くは電球アイコンからその場で直せます。まとめて直すときは「自動修正できる問題をすべて修正（小説）」を使えます。'],
    duration: 2.4,
  },
  {
    id: 'book',
    heading: '一冊にする',
    paragraphs: [
      '「印刷／PDF 保存」を押すと、本がページ組版の縦書きでブラウザーに開きます。そのまま印刷でき、PDF にも保存できます。',
      '電子書籍にするなら「EPUB に出力」。縦書き・右開きのまま読めます。投稿サイトへの受け渡しには「テキスト」。青空文庫形式で、既定は Shift JIS です。',
    ],
    duration: 2.6,
  },
];

export const STAGE_HEADING = '書いて、確かめて、一冊にする';
