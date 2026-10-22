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
    paragraphs: [
      'ふつうに書くだけです。ルビや傍点は、青空文庫の注記で書き添えます。改行すると行頭に全角スペースが入り、「 で書き始めればそのスペースは自動で外れます。',
      '登場人物の名前や造語を登録しておくと、地の文で目立つ表示になります。⌥←・⌥→ では、カーソルが文の途中の区切りごとに止まります。',
    ],
    duration: 4.4,
  },
  {
    id: 'check',
    heading: '確かめる',
    paragraphs: [
      '「プレビューを横に開く」で、原稿の横に縦書きの組み上がりが表示されます。ルビ・傍点・縦中横も改ページの目印も、入力するたびにすぐ反映されます。1 ページ分の行数ごとに、ページの切れ目に薄い点線が入ります。カーソルを動かすと、プレビューも同じ場所へ移動します。',
      '注記にマウスを合わせると、何をする注記か、本文のどこにかかっているかが表示されます。本文の言葉と、注記の「」の中の言葉は、F2 でまとめて書き換えられます。',
    ],
    duration: 5.2,
  },
  {
    id: 'collect',
    heading: 'まとめる',
    paragraphs: ['章を読む順に並べたものが、本です。「本の一覧」で章の追加や並べ替え、タイトルやヘッダーの編集がその場でできます。キーボードでも、↑↓ で章を選び、⌥↑↓ で並べ替え、Delete で本から外せます。一覧の下には、本文のページ数・原稿用紙換算枚数・文字数が出ます。'],
    duration: 3.4,
  },
  {
    id: 'fix',
    heading: '整える',
    paragraphs: ['書いている間、原稿を静かに点検します。行頭の字下げや文末の句点など、指摘の多くは電球アイコンからその場で直せます。まとめて直すときは「自動修正できる問題をすべて修正（小説）」を使えます。本に入れた全章の問題は、「本の一覧」の「本の問題を修正…」で一覧にして直せます。'],
    duration: 2.8,
  },
  {
    id: 'book',
    heading: '一冊にする',
    paragraphs: [
      '「印刷／PDF 保存」を押すと、本がページ組版の縦書きでブラウザーに開きます。そのまま印刷でき、PDF にも保存できます。',
      '電子書籍にするなら「EPUB に出力」。縦書き・右開きのまま読めます。「テキスト」は青空文庫形式で出力します。',
    ],
    duration: 3,
  },
];

export const STAGE_HEADING = '書いて、確かめて、一冊にする';
