# ひらり

縦にスワイプしてイラストを次々見られて、写真を1枚選ぶだけで投稿できるサイトです。
Node.js（Express）とPostgreSQLで動き、Renderにそのままデプロイできます。

## Renderに公開する手順

1. このフォルダの中身をGitHubのリポジトリに push する。
2. Renderのダッシュボードで **New > Blueprint** を選び、そのリポジトリを指定する。
3. `render.yaml` の内容（Webサービス1つ＋Postgres1つ）が表示されるので、そのまま Apply する。
4. ビルドが終わると `https://hirari-xxxx.onrender.com` のようなURLで公開される。

`render.yaml` が `DATABASE_URL`（DBとの接続）と `ADMIN_TOKEN`（管理用の合言葉）を自動で設定します。
手作業での環境変数の設定は要りません。

## 仕組み

- 投稿された写真は、サーバー側で向きを直し、長辺1600pxのJPEGに作り直してPostgreSQLに保存します。
  作り直す過程で、位置情報などのメタデータは消えます。
- 投稿したブラウザには「削除キー」が保存され、そのブラウザからだけ自分の投稿を削除できます。
  ブラウザのデータを消すと、自分の投稿を削除できなくなります。
- 他の人の投稿は「通報」できます。3回通報された投稿は自動で非表示になります。
- 荒らし対策として、同じIPからの投稿は1時間に12回まで、通報は1時間に30回までです。

## 管理者として投稿を消す

Renderのダッシュボードで `ADMIN_TOKEN` の値を確認し、投稿のIDを指定して実行します。
投稿のIDは、画像のURL（`/img/<ID>`）に含まれています。

```
curl -X DELETE https://あなたのURL/api/admin/posts/<ID> \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

## Renderの無料プランの制限（2026年10月時点）

- Webサービスは、15分アクセスがないとスリープし、再開に約1分かかります。
- 無料のPostgresは容量1GBで、**作成から30日で使えなくなります**。その後14日以内に有料プランへ上げないと、データごと削除されます。バックアップもありません。
- 続けて運用するなら、Postgresを有料プランに変えてください。`render.yaml` の `databases` の `plan: free` を `plan: basic-256mb` などに書き換えるか、ダッシュボードから変更できます。
- 1枚あたり約200〜400KBなので、1GBでおよそ3000〜5000枚です。

## 手元で動かす

```
npm install
DATABASE_URL=postgres://ユーザー:パスワード@localhost:5432/hirari npm start
```

`http://localhost:3000` を開きます。ローカルのPostgres 13以降が必要です。

## ファイル構成

- `server.js` : APIと画像の配信
- `public/` : 画面（`index.html` / `style.css` / `app.js`）
- `render.yaml` : Renderの構成
