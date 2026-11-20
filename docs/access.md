# Google 認証で利用者を限定する(Cloudflare Access)

be 自体には認証がなく、UUID を知っていれば誰でも読み書きできる。
利用者を限定したい場合は、[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) で
サイト全体を保護する。アプリのコード変更は不要。

- 保護はドメイン単位。画面も API も、許可した人しか開けなくなる(「読むのは誰でも可」にはできない)
- 独自ドメインで公開していることが前提([README のデプロイ手順](../README.md#独自ドメインで公開する))
- 画面やメニューの名称は変わることがある

以下では公開ドメインを `be.example.com`、Zero Trust のチーム名を `<team>` と書く。

## 1. Zero Trust のチーム名を決める

Cloudflare ダッシュボードで「Zero Trust」を開く。初回はチーム名とプラン(Free で足りる)を選ぶ。
チーム名は `https://<team>.cloudflareaccess.com` というログイン用ドメインになる。

## 2. Google で OAuth クライアントを作る

[Google Cloud Console](https://console.cloud.google.com/) で行う(gcloud コマンドでは作れない)。

1. プロジェクトを選ぶ、または作る
2. 「API とサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」
3. 同意画面の構成を求められたら設定する(アプリ名は任意、対象は「外部」)
4. アプリケーションの種類で「ウェブ アプリケーション」を選び、次を入力して作成する

| 項目 | 値 |
| --- | --- |
| 承認済みの JavaScript 生成元 | `https://<team>.cloudflareaccess.com` |
| 承認済みのリダイレクト URI | `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` |

表示されるクライアント ID とクライアント シークレットを控える。

同意画面の公開ステータスが「テスト」の間は、テストユーザーに登録したアカウントしかログインできない。
自分の Google アカウントをテストユーザーに追加しておく。

## 3. Google をログイン方法に登録する

Zero Trust の「Settings」→「Authentication」→「Login methods」で Google を追加し、
2 のクライアント ID とシークレットを入力する。

## 4. アプリケーションとポリシーを作る

1. 「Access」→「Applications」で「Self-hosted」のアプリケーションを追加し、ドメインに `be.example.com` を指定する
2. ログイン方法は Google だけにする
3. ポリシーを作る
   - アクション: 「許可」(Allow)
   - 「含める」のセレクター: 「Emails」
   - 値: 許可する Google アカウントのメールアドレス

「Emails ending in」はドメイン単位の許可で、同じドメインの全員が通る。1 人だけにするなら「Emails」を使う。

## 5. 確認する

未ログインの状態では、画面も API もログイン画面へリダイレクト(302)される。

```sh
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://be.example.com/
# 302 https://<team>.cloudflareaccess.com/cdn-cgi/access/login/be.example.com?...
```

ブラウザのシークレットウィンドウで開き、Google ログインが出ること、許可したアカウントで入れることを確認する。

## プログラムから API を使う

Access のサービストークンを使う。

1. 「Access」→「Service Auth」でサービストークンを作る。Client ID と Client Secret が発行される(Secret は一度しか表示されない)
2. 4 のアプリケーションに、アクションが「Service Auth」で、そのトークンを含むポリシーを追加する
3. リクエストに 2 つのヘッダを付ける

```sh
# 読みだし
curl https://be.example.com/api/doc/<uuid> \
  -H "CF-Access-Client-Id: <id>" \
  -H "CF-Access-Client-Secret: <secret>"

# 保存(新規は x-base: 0、更新は読みだし時の x-version の値)
curl -X PUT https://be.example.com/api/doc/<uuid> \
  -H "CF-Access-Client-Id: <id>" \
  -H "CF-Access-Client-Secret: <secret>" \
  -H "x-base: 0" \
  -H "x-name: memo.md" \
  --data-binary @memo.md
```

API の仕様(上書き防止、256KB 上限、回数制限)は [README](../README.md#api-と-r2-の保存形式) のとおり。
サービストークンは秘密情報なので、リポジトリに入れない。

## 注意

- 編集中にログインの期限が切れると、クラウド保存が失敗して ☁ ⚠ になる。ページを再読み込みすると再ログインできる。
  入力内容は localStorage に残っている
- `workers.dev` の URL でも公開している場合、そちらは Access の保護対象外になる。
  `wrangler.jsonc` に `routes` を書くと `workers.dev` は既定で無効になる
