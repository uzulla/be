# be

ブラウザで動く、シンプルで軽量なテキストエディタ。Cloudflare Workers の Static Assets で配信する。

- サーバーコードなし、依存ライブラリなし。`public/index.html` 1 ファイル(約 8.5KB、gzip 約 3.5KB)
- 内容はブラウザの localStorage に保存される

## 使い方

| 操作 | 内容 |
| --- | --- |
| `/` を開く | UUID を発番し、`/<uuid>` の編集画面になる |
| 編集 | 入力の 300ms 後に自動保存 |
| ファイル名 | ヘッダ左の入力欄で設定(未設定時は `untitled.txt`) |
| New | 新しい UUID のドキュメントを開く |
| Recent | この PC で開いたドキュメントの一覧。開く・削除ができる |
| Download / Ctrl(⌘)+S | ファイル名を付けてダウンロード |
| ファイルをドロップ | そのファイルを開く。複数ファイルはすべて保存し、1 つ目を表示 |

ドロップ時、今のドキュメントが空ならそこに読み込み、内容があれば新しい UUID で開く。
空のままの新規ドキュメントは保存されず、Recent にも出ない。

## 開発

Node とタスクは [mise](https://mise.jdx.dev/) で管理している。

```sh
mise trust && mise install   # 初回のみ。Node を用意する
mise run install             # 依存パッケージ (wrangler) を入れる
mise run dev                 # http://localhost:8787
mise run test                # dev サーバー起動中に実行する
```

`mise run test` はヘッドレス Chrome を起動して E2E チェックを行う。環境変数で変更できる。

| 変数 | 既定値 |
| --- | --- |
| `CHROME` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| `BASE` | `http://localhost:8787` |

## デプロイ

Cloudflare アカウントが必要。初回は `wrangler login` でログインする。

```sh
mise run deploy   # https://be.<サブドメイン>.workers.dev に公開される
```

### 独自ドメインで公開する

`wrangler.jsonc` をコピーして `wrangler.local.jsonc` を作り、`routes` を追加する。
このファイルは git 管理外(`.gitignore` 済み)。ドメインは同じ Cloudflare アカウントのゾーンにある必要がある。

```jsonc
{
  "name": "be",
  "compatibility_date": "2026-11-01",
  "routes": [{ "pattern": "be.example.com", "custom_domain": true }],
  "assets": {
    "directory": "./public",
    "not_found_handling": "single-page-application"
  }
}
```

```sh
mise run deploy:prod   # wrangler.local.jsonc の設定でデプロイする
```

DNS レコードと証明書はデプロイ時に自動で作られる。

## 構成

```
public/index.html   アプリ本体(HTML / CSS / JS をインライン)
wrangler.jsonc      Workers 設定。静的アセットのみ、/<uuid> は index.html にフォールバック
mise.toml           Node のバージョンとタスク定義
test/e2e.mjs        E2E テスト(Chrome DevTools Protocol を直接使用)
```

## 保存形式(localStorage)

| キー | 値 |
| --- | --- |
| `be:doc:<uuid>` | 本文(文字列) |
| `be:index` | `{ "<uuid>": { "n": ファイル名, "t": 更新時刻(ms) } }` |

localStorage の上限(約 5MB)を超えると、ステータス欄に「保存失敗」と表示される。
