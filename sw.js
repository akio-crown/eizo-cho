// オフラインでも開けるように画面ファイルを保存しておく。
// アプリを更新したら VERSION を上げる（app.js の APP_VERSION と同じ数字に）。
const VERSION = 'eizo-cho-v11';
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
    // 開いているタブに新しい版を知らせる。
    // 返事をくれる画面（v11 以降）は自分で判断して更新する（入力中なら待つ）。
    // 返事のない古い画面は自分で更新できないので、ここで読み込み直す。
    const list = await self.clients.matchAll({ type: 'window' });
    await Promise.all(list.map(c => new Promise(res => {
      let answered = false;
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { answered = true; res(); };
      try { c.postMessage({ type: 'sw-updated', version: VERSION }, [ch.port2]); } catch {}
      setTimeout(() => {
        if (!answered) c.navigate(c.url).catch(() => {});
        res();
      }, 3000);
    })));
  })());
});

// 確認用：開いているタブの一覧を返す
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'clients' && e.ports[0]) {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => e.ports[0].postMessage({ version: VERSION, clients: list.map(c => c.url) }));
  }
});

// 同じサイトのファイルだけ：ネット優先、つながらなければ保存済みを使う（同期の通信には触らない）
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => { // 毎回サーバーに確認（古い画面が残らないように）
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
