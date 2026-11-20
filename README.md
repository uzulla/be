# be

ブラウザで動く、シンプルで軽量なテキストエディタ。Cloudflare Workers の Static Assets で配信する。

- 依存ライブラリなし。画面は `public/index.html` 1 ファイル
- 入力内容はすぐにブラウザの localStorage に保存される
- クラウド(Cloudflare R2)にも UUID をキーに保存され、別の PC から同じ URL で読みだせる

## 使い方

| 操作 | 内容 |
| --- | --- |
| `/` を開く | UUID を発番し、`/<uuid>` の編集画面になる |
| 編集 | 入力の 300ms 後に自動保存 |
| ファイル名 | ヘッダ左の入力欄で設定。新規作成時は `untitled-YYYY-MM-DD-HHMM.txt`(作成日時)が入る |
| New | 新しい UUID のドキュメントを開く |
| 複製 | 今の内容を新しい UUID にコピーして開く |
| ☁ | クラウドに保存する。変更があれば 10 秒ごとに自動でも保存される |
| Recent | この PC で開いたドキュメントの一覧。開く・削除ができる |
| Download / Ctrl(⌘)+S | ファイル名を付けてダウンロード |
| ファイルをドロップ | そのファイルを開く。複数ファイルはすべて保存し、1 つ目を表示 |

ドロップ時、今のドキュメントが空ならそこに読み込み、内容があれば新しい UUID で開く。
空のままの新規ドキュメントは保存されず、Recent にも出ない。

### クラウド保存

☁ ボタンの表示で状態がわかる。

| 表示 | 状態 |
| --- | --- |
| ☁ ✓ | クラウドに保存済み |
| ☁ ● | クラウドに未保存の変更がある |
| ☁ ⚠ | 保存できなかった(自動で再試行する)、または競合している。ボタンにカーソルを置くと理由が出る |

クラウド側が別の場所で更新されていた場合は上書きせず、警告を出す。
「クラウド版を読みこむ」か「この内容で上書き」を選ぶ。両方残したいときは先に「複製」する。

クラウドに保存できるのは 1 件 256KB まで。超えた分は localStorage にだけ保存される。

UUID を知っていれば誰でも読み書きできる(認証はない)。URL が鍵の代わりになる。
利用者を限定したい場合は、[Google 認証で利用者を限定する](docs/access.md) を参照。
Recent から削除しても、クラウド側のデータは消えない。

## 開発

Node とタスクは [mise](https://mise.jdx.dev/) で管理している。

```sh
mise trust && mise install   # 初回のみ。Node を用意する
mise run install             # 依存パッケージ (wrangler) を入れる
mise run dev                 # http://localhost:8787
mise run test                # dev サーバー起動中に実行する
```

`mise run dev` では書きこみの回数制限を切っている(テストを繰り返し実行できるようにするため)。
ローカルでは R2 もエミュレートされる(データは `.wrangler/` に入る)ので、Cloudflare アカウントは不要。

`mise run test` はヘッドレス Chrome を起動して E2E チェックを行う。環境変数で変更できる。

| 変数 | 既定値 |
| --- | --- |
| `CHROME` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| `BASE` | `http://localhost:8787` |

## デプロイ

Cloudflare アカウントが必要で、R2 を有効にしておく。初回はログインしてバケットを作る。

```sh
wrangler login
wrangler r2 bucket create be-docs
mise run deploy   # https://be.<サブドメイン>.workers.dev に公開される
```

### 独自ドメインで公開する

`wrangler.jsonc` をコピーして `wrangler.local.jsonc` を作り、`routes` を追加する。
このファイルは git 管理外(`.gitignore` 済み)。ドメインは同じ Cloudflare アカウントのゾーンにある必要がある。

```jsonc
{
  // ...wrangler.jsonc の内容に、次の 1 行を追加する
  "routes": [{ "pattern": "be.example.com", "custom_domain": true }]
}
```

```sh
mise run deploy:prod   # wrangler.local.jsonc の設定でデプロイする
```

DNS レコードと証明書はデプロイ時に自動で作られる。

## 構成

```
public/index.html   画面(HTML / CSS / JS をインライン)
src/index.js        Worker。/api/doc/<uuid> で R2 を読み書きする
wrangler.jsonc      Workers 設定。/api/* 以外は静的アセットで、/<uuid> は index.html にフォールバック
mise.toml           Node のバージョンとタスク定義
docs/access.md      Cloudflare Access で利用者を限定する手順
test/e2e.mjs        E2E テスト(Chrome DevTools Protocol を直接使用)
```

## 保存形式(localStorage)

| キー | 値 |
| --- | --- |
| `be:doc:<uuid>` | 本文(文字列) |
| `be:index` | `{ "<uuid>": { "n": ファイル名, "t": 更新時刻(ms), "c": 最後に同期したクラウド側の version, "d": クラウド未保存なら 1 } }` |

localStorage の上限(約 5MB)を超えると、ステータス欄に「保存失敗」と表示される。

## API と R2 の保存形式

| メソッド | 内容 |
| --- | --- |
| `GET /api/doc/<uuid>` | 本文を返す。`x-version` / `x-name` / `x-updated` ヘッダにメタデータ。なければ 404 |
| `PUT /api/doc/<uuid>` | 本文を保存する(256KB まで)。`x-base` に最後に同期した version を付ける。IP ごとに 60 秒あたり 20 回まで(超えると 429) |

version は R2 に書きこまれた時刻(ms)。`PUT` の `x-base` が R2 上の現在の version と違えば、
別の場所で更新されたとみなして保存せず、409 で現在のメタデータを返す。

R2 のオブジェクトはキーが `doc/<uuid>`、中身が本文。customMetadata に `name`(ファイル名を
`encodeURIComponent` したもの)と `updated`(編集時刻 ms)を持つ。履歴は持たない。
