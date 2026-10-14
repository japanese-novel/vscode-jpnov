volume1.jpbook ＝ 1 冊（本の情報＋読む順に 1 行 1 章）

```text
jpbook/1
title: 作品名　第一巻
author: ペンネーム
header: 作品名　一
headerAlign: center
footer: ［＃ここに「ページ番号」の値を表示］ / ［＃ここに「総ページ数」の値を表示］
footerAlign: right
divider:
---
first-chapter.jpnov
final-chapter.jpnov
```

「本の一覧」でチェック → 出力

```text
dist/volume1.html  … 縦書き・ページ組版（そのまま印刷・PDF 保存）
dist/volume1.txt   … 青空文庫形式テキスト
dist/volume1.epub  … 電子書籍
```
