'use strict';
/* 映像記憶帳 — 覚える → 使える → 応用 を練習する暗記帳 (PWA) */

// ---------- 基本 ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => Date.now();
const MIN = 60000, DAY = 86400000;
// エビングハウスの忘却曲線に沿った復習間隔（段階0〜8）
const INTERVALS = [10 * MIN, 1 * DAY, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 60 * DAY, 120 * DAY];
const SESSION_MAX = 50;
const TEST_SIZE = 15;
const ymd = (t = now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function fmtSpan(ms) {
  if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))}分`;
  if (ms < DAY - 30 * MIN) return `${Math.round(ms / (60 * MIN))}時間`;
  return `${Math.round(ms / DAY)}日`;
}
function fmtDue(t) {
  const d = t - now();
  if (d <= 0) return '今日';
  return fmtSpan(d) + '後';
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- 保存 (IndexedDB) ----------
const idb = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('eizo-cho', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  store(mode) { return this.db.transaction('items', mode).objectStore('items'); },
  all() { return new Promise((res, rej) => { const r = this.store('readonly').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  put(rec) { return new Promise((res, rej) => { const r = this.store('readwrite').put(rec); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
};

const items = new Map();
function save(rec, { fromRemote = false } = {}) {
  if (!fromRemote) { rec.updated = now(); rec.dirty = true; }
  items.set(rec.id, rec);
  idb.put(rec).catch(e => toast('保存に失敗: ' + e.message));
  if (!fromRemote) sync.schedule();
}
const live = kind => [...items.values()].filter(r => r.kind === kind && !r.deleted);
const cats = () => live('category');
const cards = () => live('card');
const byName = (a, b) => a.name.localeCompare(b.name, 'ja');

// ---------- 分類（ジャンル → 試験 → 種類…の木構造） ----------
function childCats(pid) { return cats().filter(c => (c.parentId || null) === (pid || null)).sort(byName); }
function catPath(id) {
  const out = []; let c = id ? items.get(id) : null;
  while (c && !c.deleted) { out.unshift(c); c = c.parentId ? items.get(c.parentId) : null; }
  return out;
}
function descIds(id) {
  const ids = new Set([id]); let added = true;
  while (added) { added = false; for (const c of cats()) if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); added = true; } }
  return ids;
}
function cardsIn(catId) { if (!catId) return cards(); const ids = descIds(catId); return cards().filter(c => ids.has(c.categoryId)); }
function ensurePath(names) {
  let pid = null;
  for (const n of names) {
    const name = String(n).trim(); if (!name) continue;
    let c = childCats(pid).find(x => x.name === name);
    if (!c) { c = { id: uid(), kind: 'category', name, parentId: pid, created: now() }; save(c); }
    pid = c.id;
  }
  return pid;
}

// ---------- カード ----------
function newCard(catId) {
  return {
    id: uid(), kind: 'card', categoryId: catId || null,
    front: '', meaning: '', concept: '', image: '', example: '', mission: '',
    hint: '',   // 同じ表で意味が複数あるとき、どの意味かを見分けるヒント（例：名詞・お金の場面）
    group: null, // 同じ表の別の意味どうしを結ぶ ID
    problems: [], // [{q, a, exp}]
    srs: { stage: 0, due: now(), lapses: 0, reviews: 0, last: 0 },
    useOk: 0, missionDone: 0, missionLast: 0, needsAI: false, created: now(),
  };
}
// 同じ表の別の意味（意味ごとに別カード・別スケジュール）
function siblings(c) {
  if (!c.group) return [c];
  const list = cards().filter(x => x.group === c.group);
  if (!list.some(x => x.id === c.id)) list.push(c);
  return list.sort((a, b) => a.created - b.created);
}
// 学習の3段階：覚える → 使える → 応用
function level(c) {
  if (c.srs.stage >= 3 && c.useOk >= 3 && c.missionDone >= 1) return { n: 3, label: '応用' };
  if (c.srs.stage >= 3 && c.useOk >= 2) return { n: 2, label: '使える' };
  return { n: 1, label: '覚える' };
}
const isDue = c => c.srs.due <= now();

// ---------- 復習の出題 ----------
// 段階が浅いうちは「表→裏」「裏(写真・概念)→表」で覚える。段階2以上で「使える問題」を出す。
function makeQuestion(c, forTest = false) {
  if (c.problems.length && (c.srs.stage >= 2 || forTest)) {
    const p = c.problems[(c.srs.reviews + (forTest ? 1 : 0)) % c.problems.length];
    return { type: 'use', id: c.id, q: p.q, a: p.a, exp: p.exp };
  }
  if ((c.image || c.concept) && c.srs.reviews % 2 === 1) return { type: 'reverse', id: c.id };
  return { type: 'recall', id: c.id };
}
function nextDueAfter(c, g) {
  const st = c.srs.stage;
  if (g === 'again') return INTERVALS[0];
  if (g === 'hard') return Math.max(INTERVALS[0], INTERVALS[st] / 2);
  return INTERVALS[Math.min(INTERVALS.length - 1, st + (g === 'easy' ? 2 : 1))];
}
function grade(c, g, q) {
  const s = c.srs, wait = nextDueAfter(c, g);
  s.reviews++; s.last = now();
  if (g === 'again') { s.lapses++; s.stage = Math.max(0, s.stage - 2); }
  else if (g !== 'hard') s.stage = Math.min(INTERVALS.length - 1, s.stage + (g === 'easy' ? 2 : 1));
  s.due = now() + wait;
  if (q.type === 'use' && (g === 'good' || g === 'easy')) c.useOk++;
  save(c);
  logDay(g !== 'again');
}
function logDay(ok) {
  const id = 'day-' + ymd();
  const d = items.get(id) || { id, kind: 'day', date: ymd(), count: 0, ok: 0 };
  d.count++; if (ok) d.ok++;
  save(d);
}
function streak() {
  let n = 0, t = now();
  if (!items.get('day-' + ymd(t))) t -= DAY; // 今日まだでも昨日まで続いていれば数える
  while (items.get('day-' + ymd(t))) { n++; t -= DAY; }
  return n;
}

// ---------- 週1小テスト ----------
function lastTest() { return live('test').sort((a, b) => b.date - a.date)[0]; }
function testCandidates() { return cards().filter(c => c.srs.reviews > 0); }
function testDue() {
  const lt = lastTest();
  return testCandidates().length >= 3 && (!lt || now() - lt.date >= 7 * DAY);
}
function buildTest() {
  const recent = testCandidates().filter(c => now() - c.srs.last < 14 * DAY || c.srs.lapses > 0);
  const pool = (recent.length >= 3 ? recent : testCandidates());
  const picked = shuffle(pool.slice()).sort((a, b) => (b.problems.length > 0) - (a.problems.length > 0) || b.srs.lapses - a.srs.lapses).slice(0, TEST_SIZE);
  return shuffle(picked).map(c => makeQuestion(c, true));
}

// ---------- 実生活ミッション ----------
function todaysMissions() {
  const seed = ymd();
  const list = cards().filter(c => c.mission && c.srs.stage >= 1);
  const h = s => { let x = 0; for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) | 0; return x; };
  return list.sort((a, b) => h(seed + a.id) - h(seed + b.id)).slice(0, 3);
}

// ---------- 画面の状態 ----------
const S = {
  tab: 'home',
  view: 'home',      // home | review | test | cards | edit | settings
  catId: null,       // カード画面で開いている分類
  query: '',
  draft: null,       // 編集中のカード
  sec: {},           // 編集画面の折りたたみ開閉（key→true/false）
  session: null,     // {queue:[id], idx, q, revealed, scopeName}
  test: null,        // {qs, idx, revealed, results:[]}
};

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const m = $('#main');
  const fn = { home: vHome, review: vReview, test: vTest, cards: vCards, edit: vEdit, settings: vSettings }[S.view];
  m.innerHTML = fn();
  m.classList.toggle('flexcol', S.view === 'review' || S.view === 'test'); // 復習中はボタンを画面の下に寄せる
  if (S.view === 'edit') autosize();
  $('#syncBadge').textContent = sync.badge();
}
function go(view, tab) { S.view = view; if (tab) S.tab = tab; render(); window.scrollTo(0, 0); }

// ---------- ホーム ----------
function dayStat(t = now()) { return items.get('day-' + ymd(t)) || { count: 0, ok: 0 }; }
function nextDueIn() {
  const f = cards().filter(c => c.srs.due > now()).map(c => c.srs.due);
  return f.length ? Math.min(...f) - now() : null;
}
function weekStrip() {
  const names = '日月火水木金土';
  let h = '<div class="week">';
  for (let i = 6; i >= 0; i--) {
    const t = now() - i * DAY, n = dayStat(t).count;
    h += `<div class="wd ${n ? 'on' : ''} ${i === 0 ? 'today' : ''}"><span class="dot">${n || ''}</span><span class="sub">${names[new Date(t).getDay()]}</span></div>`;
  }
  return h + '</div>';
}
function vHome() {
  const all = cards(), due = all.filter(isDue);
  if (!all.length) {
    return `<div class="box empty">まだカードがありません。<br>まず1枚作るか、サンプルで流れを試せます。<br><br>
      <button class="primary" data-act="tab" data-tab="cards">カードを作る</button>
      <button data-act="loadSample">サンプルを入れる</button></div>`;
  }
  const lv = [0, 0, 0]; all.forEach(c => lv[level(c).n - 1]++);
  const ai = all.filter(c => c.needsAI).length, ms = todaysMissions(), lt = lastTest();
  const td = dayStat(), st = streak(), nd = nextDueIn();
  const mins = Math.max(1, Math.round(due.length * 0.4));

  let h = `<div class="box hero">
    ${due.length
      ? `<div class="sub">今日の復習</div>
         <div class="big">${due.length}<span class="sub"> 件</span></div>
         <div class="sub">目安 約${mins}分${due.length > SESSION_MAX ? `（1回 ${SESSION_MAX} 件まで）` : ''}</div>
         <button class="primary wide hero-btn" data-act="startReview">復習を始める</button>`
      : `<div class="big" style="font-size:24px">今日の復習は完了 🎉</div>
         <div class="sub" style="margin-top:4px">${nd ? `次の復習は ${fmtSpan(nd)}後` : 'カードを足すと復習が増えます'}</div>`}
    <div class="sub" style="margin-top:12px">今日 ${td.count} 回答${td.count ? `（正答 ${Math.round(td.ok / td.count * 100)}%）` : ''} ・ 連続 ${st} 日</div>
  </div>`;

  if (testDue()) {
    h += `<div class="box banner"><h2>今週の小テストの日です</h2>
      <div class="sub">最近覚えたものと間違えたものから最大${TEST_SIZE}問。使える問題を優先します。</div>
      <button class="primary wide" style="margin-top:10px" data-act="startTest">小テストを始める</button></div>`;
  }

  if (ms.length) {
    h += `<div class="box"><h2>今日の実生活ミッション</h2>` + ms.map(c => {
      const done = c.missionLast && ymd(c.missionLast) === ymd();
      return `<div class="mission ${done ? 'done' : ''}">
        <button class="check ${done ? 'on' : ''}" ${done ? 'disabled' : `data-act="missionDone" data-id="${c.id}"`} aria-label="やった">${done ? '✓' : ''}</button>
        <div class="grow"><b>${esc(c.front)}</b><div class="sub" style="font-size:14px;color:var(--text)">${esc(c.mission)}</div>
        <div class="sub">達成 ${c.missionDone} 回</div></div></div>`;
    }).join('') + `</div>`;
  }

  h += `<div class="box"><h2>この7日間</h2>${weekStrip()}
    <h2 style="margin-top:14px">学習の段階 <span class="sub" style="font-weight:400">全 ${all.length} 枚</span></h2>
    <div class="stagebar">${[0, 1, 2].map(i => lv[i] ? `<div class="seg s${i + 1}" style="flex:${lv[i]}"></div>` : '').join('')}</div>
    <div class="legend"><span><i class="s1"></i>覚える ${lv[0]}</span><span><i class="s2"></i>使える ${lv[1]}</span><span><i class="s3"></i>応用 ${lv[2]}</span></div>
    <div class="hint">使える＝使える問題に2回以上正解。応用＝さらに実生活ミッションを1回以上達成。</div></div>`;

  if (lt && !testDue()) {
    h += `<div class="box"><div class="row between"><div><b>小テスト</b><div class="sub">前回 ${new Date(lt.date).toLocaleDateString('ja-JP')}：${lt.score}/${lt.total} 点 ・ 次回は${fmtSpan(Math.max(0, lt.date + 7 * DAY - now()))}後</div></div>
      <button class="small" data-act="startTest">今すぐ</button></div></div>`;
  }
  if (ai) h += `<div class="box"><div class="row between"><span>Claude に問題作成を頼むカード：<b>${ai}</b> 枚</span><button class="small" data-act="tab" data-tab="settings">依頼する</button></div></div>`;
  return h;
}

// ---------- 復習 ----------
function startReview(catId) {
  const pool = (catId ? cardsIn(catId) : cards()).filter(isDue).sort((a, b) => a.srs.due - b.srs.due).slice(0, SESSION_MAX);
  if (!pool.length) { toast('今は復習するカードがありません'); return; }
  const name = catId ? catPath(catId).map(c => c.name).join(' › ') : 'すべて';
  // 同じ言葉の別の意味が続けて出ないようにばらす（続くと前の答えにつられるため）
  const spread = [], rest = pool.slice();
  while (rest.length) {
    const prev = spread[spread.length - 1];
    let i = rest.findIndex(c => !prev || !c.group || c.group !== prev.group);
    if (i < 0) i = 0;
    spread.push(rest.splice(i, 1)[0]);
  }
  S.session = { queue: spread.map(c => c.id), idx: 0, revealed: false, scopeName: name, done: 0, ok: 0 };
  S.session.q = makeQuestion(items.get(S.session.queue[0]));
  go('review', 'review');
}
function vReview() {
  const s = S.session;
  if (!s || s.idx >= s.queue.length) {
    const due = cards().filter(isDue).length, nd = nextDueIn();
    if (s && s.done) {
      const rate = Math.round((s.ok || 0) / s.done * 100);
      return `<div class="box hero">
        <div class="big" style="font-size:26px">おつかれさま 🎉</div>
        <div class="stats" style="margin-top:14px">
          <div><b>${s.done}</b><span class="sub">回答</span></div>
          <div><b>${rate}%</b><span class="sub">正答</span></div>
          <div><b>${s.done - (s.ok || 0)}</b><span class="sub">もう一度</span></div></div>
        <div class="sub" style="margin-top:12px">${due ? `まだ復習が ${due} 件あります` : (nd ? `次の復習は ${fmtSpan(nd)}後` : '')}</div>
        <div class="row" style="margin-top:12px">
          ${due ? `<button class="primary grow" data-act="startReview">続けて復習（${due}件）</button>` : ''}
          <button class="${due ? '' : 'primary '}grow" data-act="tab" data-tab="home">ホームへ</button></div></div>`;
    }
    return `<div class="box empty">${due ? `復習が ${due} 件あります。` : '今は復習するカードがありません。'}<br><br>
      <button class="primary" data-act="startReview" ${due ? '' : 'disabled'}>復習を始める</button>
      <div class="hint" style="margin-top:12px">分類ごとの復習は「カード」から。</div></div>`;
  }
  const c = items.get(s.queue[s.idx]);
  return `<div class="rtop"><button class="small" data-act="exitReview">✕ やめる</button>
      <span class="sub grow" style="text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.scopeName)}</span>
      <span class="sub">${s.idx + 1} / ${s.queue.length}</span></div>
    <div class="progress"><div style="width:${Math.round(s.idx / s.queue.length * 100)}%"></div></div>
    <div class="box qcard ${s.revealed ? '' : 'unrev'}">${qHtml(c, s.q, s.revealed, false)}</div>
    <div class="actbar">${s.revealed ? gradeButtons(c) : `<button class="primary grow" data-act="reveal" title="Space">答えを見る</button>`}</div>`;
}
function qHtml(c, q, revealed, isTest) {
  const path = catPath(c.categoryId).map(x => x.name).join(' › ');
  let h = `<div class="row between"><span class="q-kind">${{ recall: '思い出す（表→裏）', reverse: 'これは何？（裏→表）', use: '使ってみる' }[q.type]}</span><span class="sub">${esc(path)}</span></div>`;
  if (q.type === 'recall') {
    const sib = siblings(c), multi = sib.length > 1;
    h += `<div class="q-front" style="margin-bottom:${multi ? 6 : 18}px">${esc(c.front)}</div>`;
    if (multi) h += `<div style="text-align:center"><span class="chip lv2">意味 ${sib.findIndex(x => x.id === c.id) + 1}/${sib.length}</span>${c.hint ? ` <b>${esc(c.hint)}</b>` : ''}</div>`;
    if (!revealed) h += `<div class="sub" style="text-align:center;margin-top:12px">${multi ? 'この意味を' : ''}意味・概念・イメージを頭に浮かべてから答えを見る</div>`;
  } else if (q.type === 'reverse') {
    if (c.image) h += `<img class="q-img" src="${c.image}" alt="">`;
    if (c.concept) h += `<div class="q-text" style="text-align:center">${esc(c.concept)}</div>`;
  } else {
    h += `<div class="q-text">${esc(q.q)}</div>
      <textarea id="myAnswer" placeholder="自分の答えを書く（書くと定着しやすい）">${esc(S._myAnswer || '')}</textarea>`;
  }
  if (revealed || (isTest && revealed)) {
    h += `<div class="answer">`;
    if (q.type === 'use') {
      if (S._myAnswer) h += `<div class="k">あなたの答え</div><div>${esc(S._myAnswer)}</div>`;
      h += `<div class="k">模範解答</div><div>${esc(q.a)}</div>`;
      if (q.exp) h += `<div class="k">解説</div><div>${esc(q.exp)}</div>`;
      h += `<div class="k">カード</div><div><b>${esc(c.front)}</b>：${esc(c.meaning)}</div>`;
    } else {
      if (q.type === 'reverse') h += `<div class="q-front" style="margin:6px 0">${esc(c.front)}</div>`;
      if (q.type === 'recall' && c.image) h += `<img class="q-img" src="${c.image}" alt="">`;
      if (q.type === 'recall' && c.concept) h += `<div class="k">概念</div><div>${esc(c.concept)}</div>`;
      if (c.meaning) h += `<div class="k">意味・解説</div><div>${esc(c.meaning)}</div>`;
      if (c.example) h += `<div class="k">模範解答・例文</div><div>${esc(c.example)}</div>`;
    }
    h += `</div>`;
  }
  return h;
}
function gradeButtons(c) {
  const b = (g, label, cls) => `<button class="${cls}" data-act="grade" data-g="${g}">${label}<small>${fmtSpan(nextDueAfter(c, g))}</small></button>`;
  return `<div class="grades">${b('again', 'もう一度', 'g-again')}${b('hard', '難しい', '')}${b('good', '正解', 'g-good')}${b('easy', '簡単', '')}</div>`;
}

// ---------- 小テスト ----------
function startTest() {
  const qs = buildTest();
  if (!qs.length) { toast('テストできるカードがまだありません（復習した枚数が足りない）'); return; }
  S.test = { qs, idx: 0, revealed: false, results: [] };
  S._myAnswer = '';
  go('test', 'home');
}
function vTest() {
  const t = S.test;
  if (!t) return vHome();
  if (t.idx >= t.qs.length) {
    const score = t.results.filter(r => r.ok).length;
    const miss = t.results.filter(r => !r.ok).map(r => items.get(r.id)).filter(Boolean);
    return `<div class="box hero"><div class="sub">週1小テスト 結果</div>
      <div class="big">${score}<span class="sub"> / ${t.qs.length}</span></div>
      ${miss.length ? `<div class="sub" style="margin-top:10px">間違えたカード（今日の復習に戻しました）</div><ul class="list" style="text-align:left">${miss.map(c => `<li data-act="openCard" data-id="${c.id}"><span class="grow">${esc(c.front)}${c.hint ? ` <span class="sub">${esc(c.hint)}</span>` : ''}</span></li>`).join('')}</ul>` : '<p>全問正解！</p>'}
      <button class="primary wide" style="margin-top:10px" data-act="tab" data-tab="home">ホームへ</button></div>`;
  }
  const q = t.qs[t.idx], c = items.get(q.id);
  if (!c) { t.idx++; return vTest(); }
  return `<div class="rtop"><button class="small" data-act="tab" data-tab="home">✕ やめる</button>
      <span class="sub grow" style="text-align:center">週1小テスト</span><span class="sub">${t.idx + 1} / ${t.qs.length}</span></div>
    <div class="progress"><div style="width:${Math.round(t.idx / t.qs.length * 100)}%"></div></div>
    <div class="box qcard">${qHtml(c, q, t.revealed, true)}</div>
    <div class="actbar">${t.revealed
      ? `<div class="grades" style="grid-template-columns:1fr 1fr"><button class="g-again" data-act="testMark" data-ok="0">✕ 間違い</button><button class="g-good" data-act="testMark" data-ok="1">○ 正解</button></div>`
      : `<button class="primary grow" data-act="reveal">答え合わせ</button>`}</div>`;
}
function finishTest() {
  const t = S.test;
  const score = t.results.filter(r => r.ok).length;
  for (const r of t.results) {
    const c = items.get(r.id); if (!c) continue;
    if (r.ok) { if (r.type === 'use') c.useOk++; }
    else { c.srs.stage = Math.max(0, c.srs.stage - 1); c.srs.due = now(); c.srs.lapses++; }
    save(c);
  }
  save({ id: uid(), kind: 'test', date: now(), score, total: t.qs.length, misses: t.results.filter(r => !r.ok).map(r => r.id) });
}

// ---------- カード一覧（分類の木） ----------
function vCards() {
  const path = catPath(S.catId);
  const subs = childCats(S.catId);
  const q = S.query.trim().toLowerCase();
  let list = q ? cardsIn(S.catId).filter(c => (c.front + ' ' + c.meaning + ' ' + c.concept).toLowerCase().includes(q))
    : cards().filter(c => (c.categoryId || null) === (S.catId || null));
  list.sort((a, b) => a.srs.due - b.srs.due);
  const dueHere = cardsIn(S.catId).filter(isDue).length;
  let h = `<div class="crumbs"><a href="#" data-act="openCat" data-id="">すべて</a>${path.map(c => ` › <a href="#" data-act="openCat" data-id="${c.id}">${esc(c.name)}</a>`).join('')}</div>
    <input type="search" id="search" placeholder="この分類の中を検索" value="${esc(S.query)}">
    <div class="row" style="margin:10px 0">
      <button class="primary small" data-act="newCard">＋ カード</button>
      <button class="small" data-act="newCat">${S.catId ? `＋「${esc(path[path.length - 1].name)}」の中に分類` : '＋ 大分類'}</button>
      <button class="small" data-act="reviewCat" ${dueHere ? '' : 'disabled'}>ここを復習 (${dueHere})</button>
      ${S.catId ? `<button class="small" data-act="renameCat">名前変更</button><button class="small danger" data-act="deleteCat">削除</button>` : ''}
    </div>`;
  if (!q && subs.length) {
    h += `<div class="box" style="padding:4px 12px"><ul class="list">` + subs.map(c => {
      const n = cardsIn(c.id).length, d = cardsIn(c.id).filter(isDue).length;
      return `<li data-act="openCat" data-id="${c.id}"><span class="folder">📁</span><span class="grow">${esc(c.name)}</span><span class="sub">${n}枚${d ? ` ・ 復習${d}` : ''}</span></li>`;
    }).join('') + `</ul></div>`;
  }
  if (list.length) {
    // 同じ表の別の意味は1行にまとめる
    const seen = new Set(), rows = [];
    for (const c of list) {
      if (!c.group) { rows.push([c]); continue; }
      if (seen.has(c.group)) continue;
      seen.add(c.group);
      rows.push(list.filter(x => x.group === c.group).sort((a, b) => a.created - b.created));
    }
    h += `<div class="box" style="padding:4px 12px"><ul class="list">` + rows.map(g => {
      const c = g[0], multi = g.length > 1;
      const lvMin = Math.min(...g.map(x => level(x).n)), lvLabel = ['覚える', '使える', '応用'][lvMin - 1];
      const img = g.find(x => x.image), due = Math.min(...g.map(x => x.srs.due));
      const sub = multi ? g.map(x => x.hint || x.meaning || x.concept || '').filter(Boolean).join(' ／ ') : (c.meaning || c.concept || '');
      return `<li data-act="openCard" data-id="${c.id}">
        ${img ? `<img class="thumb" src="${img.image}" alt="">` : '<span class="folder">🃏</span>'}
        <span class="grow"><b>${esc(c.front)}</b>${multi ? ` <span class="chip lv2">意味${g.length}つ</span>` : ''}<br><span class="sub">${esc(sub.slice(0, 40))}</span></span>
        ${g.some(x => x.needsAI) ? '<span class="chip ai">作成待ち</span>' : ''}
        <span class="chip lv${lvMin}">${lvLabel}</span><span class="sub">${fmtDue(due)}</span></li>`;
    }).join('') + `</ul></div>`;
  } else if (!subs.length || q) {
    h += `<div class="empty">${q ? '見つかりません' : (S.catId
      ? `ここにはまだ何もありません。<br>上の「＋「${esc(path[path.length - 1].name)}」の中に分類」で中分類を作れます<br>（例：英単語、英熟語、英文法）`
      : 'まず「＋ 大分類」で英語・数学・趣味などを作り、<br>その分類を開いて中に英単語・英熟語などを作ります')}</div>`;
  }
  return h;
}

// ---------- カード編集 ----------
function openEdit(card) { S.draft = JSON.parse(JSON.stringify(card)); go('edit', 'cards'); }
function catOptions(sel) {
  const out = [`<option value="">（分類なし）</option>`];
  const walk = (pid, depth) => childCats(pid).forEach(c => { out.push(`<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${'　'.repeat(depth)}${esc(c.name)}</option>`); walk(c.id, depth + 1); });
  walk(null, 0);
  return out.join('');
}
// 折りたたみ欄：開閉は S.sec に覚えておく（画面を描き直しても保つ）
function sec(key, title, count, defaultOpen, body) {
  const open = S.sec[key] ?? defaultOpen;
  return `<details class="box" data-sec="${key}" ${open ? 'open' : ''}>
    <summary><span>${title}${count ? ` <span class="chip lv2">${count}</span>` : ''}</span></summary>${body}</details>`;
}
function vEdit() {
  const d = S.draft, exists = items.has(d.id) && !items.get(d.id).deleted;
  const lv = level(d), sib = siblings(d), multi = sib.length > 1, others = sib.filter(x => x.id !== d.id);

  const imageBox = `<div class="box">
      <h2>裏：映像（写真・図）</h2>
      ${d.image ? `<img class="q-img prev" src="${d.image}" alt=""><div class="row" style="justify-content:center;margin-bottom:8px"><button class="small danger" data-act="removeImage">写真を外す</button></div>` : ''}
      <div id="dropzone" class="dropzone ${d.image ? 'compact' : ''}">
        <div class="dz-text"><span class="dz-pc">${d.image ? '差し替え：新しい画像をここへドロップ' : 'ここに画像をドラッグ＆ドロップ<br><small>Mac のスクショ右下のサムネをつかんで、そのままここへ</small>'}</span><span class="dz-sp">${d.image ? '差し替える' : '写真・スクショを追加'}</span></div>
        <div class="row" style="justify-content:center;margin-top:8px">
          <label class="btn ${d.image ? '' : 'primary'}">📷 写真から選ぶ<input type="file" accept="image/*" id="imgInput" hidden></label>
          <button data-act="pasteImage">📋 貼り付け</button>
        </div>
      </div>
      <label class="f">ひとことで言うと（概念・イメージ）</label>
      <textarea data-f="concept" placeholder="例：やるべきことを「あとで」の箱に押し込むイメージ">${esc(d.concept)}</textarea>
      <label class="f">日本語の意味・解説</label>
      <textarea data-f="meaning" placeholder="例：（やるべきことを）先延ばしにする">${esc(d.meaning)}</textarea>
      <label class="f">模範解答・例文</label>
      <textarea data-f="example" placeholder="例：Stop procrastinating and start your report.">${esc(d.example)}</textarea>
    </div>`;

  const problems = sec('problems', '使える問題', d.problems.length || '', d.problems.length > 0 || !exists,
    `<div class="hint" style="margin:0 0 6px">覚えたことを「使わないと解けない」問題。誤文訂正／公式を使う文章題／実際の場面での判断など。</div>
      ${d.problems.map((p, i) => `<div class="prob">
        <div class="row between"><b>問題 ${i + 1}</b><button class="small danger" data-act="delProblem" data-i="${i}">消す</button></div>
        <textarea data-p="${i}" data-k="q" placeholder="問題　例：誤りを直せ：I procrastinated to do my homework.">${esc(p.q)}</textarea>
        <textarea data-p="${i}" data-k="a" placeholder="模範解答">${esc(p.a)}</textarea>
        <textarea data-p="${i}" data-k="exp" placeholder="解説（任意）">${esc(p.exp)}</textarea></div>`).join('')}
      <div class="row" style="margin-top:10px">
        <button class="small" data-act="addProblem">＋ 問題を足す</button>
        <label class="row" style="margin-left:auto;font-size:13px"><input type="checkbox" data-f="needsAI" ${d.needsAI ? 'checked' : ''}> Claude に作成を頼む</label>
      </div>`);

  const mission = sec('mission', '実生活ミッション（応用）', d.mission ? '✓' : '', !!d.mission,
    `<textarea data-f="mission" placeholder="例：今日の日記かSlackで1回 procrastinate を使う／次の練習でグリップを3本ずつ確認">${esc(d.mission)}</textarea>
      <div class="hint">実生活で使う場面。ホームに日替わりで出ます。</div>`);

  const senses = sec('senses', '同じ表の別の意味', multi ? sib.length : '', multi,
    `<div class="sub" style="margin-bottom:6px">${multi ? `この言葉には意味が ${sib.length} つ。意味ごとに写真・復習の間隔・問題を別々に持ちます。` : '意味が複数ある言葉（bank＝銀行／土手 など）は、意味ごとに別カードにすると、写真も復習も意味ごとに覚えられます。'}</div>
      ${others.length ? `<ul class="list">${others.map(x => `<li data-act="openSibling" data-id="${x.id}">${x.image ? `<img class="thumb" src="${x.image}" alt="">` : '<span class="folder">🃏</span>'}<span class="grow">${esc(x.hint || x.meaning || x.concept || '（未入力）')}</span><span class="sub">${fmtDue(x.srs.due)}</span></li>`).join('')}</ul>` : ''}
      <button class="small" style="margin-top:8px" data-act="addSense">＋ 別の意味を追加</button>`);

  const more = exists ? sec('more', 'その他（記録・削除）', '', false,
    `<div class="sub">段階 ${d.srs.stage}/8 ・ 次の復習 ${fmtDue(d.srs.due)} ・ 間違い ${d.srs.lapses} 回<br>使える問題 正解 ${d.useOk} 回 ・ ミッション ${d.missionDone} 回</div>
      <div class="row" style="margin-top:10px"><button data-act="resetCard">覚え直す</button><button class="danger" data-act="deleteCard">このカードを削除</button></div>`) : '';

  return `<div class="row between" style="margin-bottom:10px"><button class="small" data-act="cancelEdit">← 戻る</button>
      <span class="sub">${exists ? `<span class="chip lv${lv.n}">${lv.label}</span>` : '新しいカード'}</span></div>
    <div class="box">
      <label class="f" style="margin-top:0">表（覚えたいこと）</label>
      <input type="text" data-f="front" value="${esc(d.front)}" placeholder="例：procrastinate / 二次方程式の解の公式 / ダーツのグリップ">
      ${multi || d.hint ? `<label class="f">意味の見分けヒント</label>
      <input type="text" data-f="hint" value="${esc(d.hint)}" placeholder="例：名詞・お金の場面 ／ 動詞・会社が目的語">
      <div class="hint">復習の問題文に出ます（答えそのものは書かない）。</div>` : ''}
      <label class="f">分類</label><select data-f="categoryId">${catOptions(d.categoryId)}</select>
    </div>
    ${imageBox}${problems}${mission}${senses}${more}
    <div class="savebar"><button class="primary grow" data-act="saveCard">保存</button></div>`;
}
function commitDraft() {
  const d = S.draft;
  if (!d.front.trim()) { toast('表を入れてください'); return false; }
  d.front = d.front.trim();
  d.problems = d.problems.filter(p => p.q.trim());
  save(d); S.catId = d.categoryId || null;
  // 同じ表の別の意味は、表の文字をそろえておく（表を直したら全部に反映）
  if (d.group) for (const x of siblings(d)) if (x.id !== d.id && x.front !== d.front) { x.front = d.front; save(x); }
  return true;
}
function resizeImage(file, max = 720) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      res(cv.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像を読めませんでした')); };
    img.src = url;
  });
}

// ---------- 設定・同期・Claude連携 ----------
function vSettings() {
  const cfg = sync.cfg() || {};
  const ai = cards().filter(c => c.needsAI);
  return `<div class="box">
      <h2>スマホ ⇄ PC 同期（Supabase）</h2>
      <div class="hint">両方の端末で同じ URL とキーを入れると即時同期します。空なら端末内だけに保存。設定方法は README。</div>
      <label class="f">Project URL</label><input type="url" id="sUrl" value="${esc(cfg.url || '')}" placeholder="https://xxxx.supabase.co">
      <label class="f">API キー（anon / publishable）</label><input type="password" id="sKey" value="${esc(cfg.key || '')}">
      <div class="row" style="margin-top:10px"><button class="primary" data-act="saveSync">保存して同期</button><button data-act="syncNow">今すぐ同期</button><button class="small" data-act="resync">全件取り直し</button></div>
      <div class="sub" style="margin-top:8px">${esc(sync.status || '未設定')}</div>
    </div>
    <div class="box">
      <h2>Claude に問題を作ってもらう</h2>
      <div class="hint">① 依頼文をコピー → Claude Code に貼る ② 返ってきた JSON を下に貼って取り込む。新しいカードの一括作成（例：「TOEIC 頻出単語を20枚」）も同じ形式で取り込めます。</div>
      <div class="row" style="margin-top:8px"><button data-act="copyRequest" ${ai.length ? '' : 'disabled'}>作成待ち ${ai.length} 枚の依頼文をコピー</button></div>
      <label class="f">Claude の返答（JSON）</label><textarea id="importBox" placeholder='[{"path":["英語","TOEIC","英単語"],"front":"...","meaning":"...","problems":[{"q":"...","a":"..."}]}]'></textarea>
      <button class="primary" style="margin-top:8px" data-act="importJson">取り込む</button>
    </div>
    <div class="box">
      <h2>バックアップ</h2>
      <div class="row"><button data-act="exportAll">全部を書き出す</button><label class="btn">読み込む<input type="file" id="restoreInput" accept="application/json,.json" hidden></label><button data-act="loadSample">サンプルを入れる</button></div>
    </div>
    <div class="box">
      <h2>復習の間隔</h2>
      <div class="sub">正解するたびに：${INTERVALS.map(fmtSpan).join(' → ')}。<br>「もう一度」で2段階戻り10分後に再出題。段階2から「使える問題」に切り替わります。</div>
    </div>`;
}
function requestText() {
  const ai = cards().filter(c => c.needsAI).map(c => ({
    id: c.id, path: catPath(c.categoryId).map(x => x.name), front: c.front, hint: c.hint || undefined,
    otherSenses: siblings(c).length > 1 ? siblings(c).filter(x => x.id !== c.id).map(x => x.hint || x.meaning || '') : undefined,
    meaning: c.meaning || undefined, concept: c.concept || undefined, example: c.example || undefined,
    problems: c.problems.length ? c.problems : undefined, mission: c.mission || undefined,
  }));
  return `映像記憶帳のカードに「使える」問題を作ってください。
目標は「覚える」ではなく「使える」こと。各カードについて：
- meaning（日本語の意味・解説）, concept（イメージが湧くひとこと概念）, example（模範解答・例文）が空なら埋める
- problems を2〜3問。カードの内容を使わないと解けない問題にする
  - 英単語/熟語/文法：誤った単語・誤った文法の例文を出して直させる、場面に合う文を作らせる
  - 数学・理科：公式を当てはめないと解けない具体的な問題（数値つき）
  - プログラミング：バグのあるコードを直す、出力を予想する
  - 趣味（歌・ダーツ・筋トレ等）：実際の場面での判断・手順を問う
  - 実生活でよく使う場面を優先
- mission：実生活で実際に使う小さな行動を1つ
- hint がある札は、同じ表の別の意味（otherSenses）と取り違えないよう、その意味に限った問題にする
- 新しい札を作るとき、意味が複数ある言葉は senses にまとめる（意味ごとに別カードになる）：
  {"path":[…],"front":"bank","senses":[{"hint":"名詞・お金の場面","meaning":"銀行","concept":"…","example":"…","problems":[…]},{"hint":"名詞・川の場面","meaning":"土手","…":"…"}]}
返答は JSON 配列だけ（id はそのまま返す）：
[{"id":"…","meaning":"…","concept":"…","example":"…","mission":"…","problems":[{"q":"…","a":"…","exp":"…"}]}]

カード：
${JSON.stringify(ai, null, 1)}`;
}
function importCards(text) {
  let s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = s.search(/[\[{]/); if (i > 0) s = s.slice(i);
  let data = JSON.parse(s);
  if (!Array.isArray(data)) data = data.cards || [data];
  let added = 0, updated = 0;
  for (const x of data) {
    if (!x || typeof x !== 'object') continue;
    let c = x.id && items.get(x.id);
    if (c && c.deleted) c = null;
    // 意味が複数ある言葉：senses の1つ1つを別カードにして、同じ group で結ぶ
    if (!c && x.front && Array.isArray(x.senses) && x.senses.length) {
      const cat = Array.isArray(x.path) ? ensurePath(x.path) : (typeof x.path === 'string' ? ensurePath(x.path.split(/\s*[>›\/]\s*/)) : S.catId);
      const gid = x.senses.length > 1 ? uid() : null;
      for (const sx of x.senses) {
        const n = newCard(cat);
        n.front = String(x.front).trim(); n.group = gid;
        for (const k of ['hint', 'meaning', 'concept', 'example', 'mission', 'image']) if (typeof sx[k] === 'string' && sx[k].trim()) n[k] = sx[k].trim();
        if (Array.isArray(sx.problems)) n.problems = sx.problems.filter(p => p && p.q).map(p => ({ q: String(p.q), a: String(p.a ?? ''), exp: String(p.exp ?? '') }));
        save(n); added++;
      }
      continue;
    }
    if (!c) {
      if (!x.front) continue;
      c = newCard(Array.isArray(x.path) ? ensurePath(x.path) : (typeof x.path === 'string' ? ensurePath(x.path.split(/\s*[>›\/]\s*/)) : S.catId));
      added++;
    } else updated++;
    for (const k of ['front', 'hint', 'meaning', 'concept', 'example', 'mission', 'image']) if (typeof x[k] === 'string' && x[k].trim()) c[k] = x[k].trim();
    if (Array.isArray(x.problems) && x.problems.length) {
      c.problems = x.problems.filter(p => p && p.q).map(p => ({ q: String(p.q), a: String(p.a ?? ''), exp: String(p.exp ?? '') }));
    }
    c.needsAI = false;
    save(c);
  }
  return { added, updated };
}
function exportAll() {
  const data = [...items.values()].filter(r => !r.deleted).map(({ dirty, ...r }) => r);
  const blob = new Blob([JSON.stringify({ app: 'eizo-cho', version: 1, exported: new Date().toISOString(), items: data })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `eizo-cho-backup-${ymd()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function restoreAll(json) {
  const data = JSON.parse(json);
  if (!data || !Array.isArray(data.items)) throw new Error('バックアップ形式ではありません');
  let n = 0;
  for (const r of data.items) {
    if (!r.id || !r.kind) continue;
    const loc = items.get(r.id);
    if (!loc || (r.updated || 0) > (loc.updated || 0)) { save({ ...r }); n++; }
  }
  return n;
}

// ---------- サンプル ----------
const SAMPLE = [
  { path: ['英語', 'TOEIC', '英単語'], front: 'procrastinate', meaning: '（やるべきことを）先延ばしにする', concept: 'やることを「あとで」の箱に押し込むイメージ', example: 'Stop procrastinating and finish the report today.',
    problems: [{ q: '誤りを直せ：I procrastinated to do my homework until midnight.', a: 'I procrastinated on my homework until midnight. / I put off doing my homework until midnight.', exp: 'procrastinate は自動詞。「〜を先延ばしにする」は procrastinate on ~ か put off ~ing。to不定詞はとらない。' },
      { q: '上司に「報告書を後回しにしてすみません」と英語で一言。', a: "Sorry, I've been procrastinating on the report.", exp: '現在完了進行形で「ずっと先延ばしにしてきた」。' }],
    mission: '今日の予定を書くとき、後回しにしたいことを1つ英語で書く（I tend to procrastinate on ~）' },
  { path: ['英語', 'TOEIC', '英単語'], front: 'run', senses: [
    { hint: '動詞・人が主語', meaning: '走る', concept: '足が地面を蹴って前へ進むイメージ', example: 'I run in the park every morning.',
      problems: [{ q: '誤りを直せ：I runned 5 km yesterday.', a: 'I ran 5 km yesterday.', exp: 'run は不規則変化：run – ran – run。' }], mission: '今日歩く道を1回だけ I run to ~ と英語で言ってみる' },
    { hint: '動詞・会社や店が目的語', meaning: '（会社・店などを）経営する', concept: '機械を動かし続ける＝事業を回し続けるイメージ', example: 'She runs a small cafe near the station.',
      problems: [{ q: '「彼は父の会社を経営している」を run を使って英語に。', a: 'He runs his father\'s company.', exp: '目的語に会社・店・イベントをとると「運営する」。' }] },
  ] },
  { path: ['英語', '英文法'], front: '提案の suggest', meaning: 'suggest + 人 + to do はとれない。suggest (that) S (should) 原形 / suggest ~ing', concept: 'suggest は「アイデアを机に置く」。人を直接動かす動詞ではない',
    problems: [{ q: '誤りを直せ：He suggested me to take a break.', a: 'He suggested (that) I (should) take a break. / He suggested taking a break.', exp: 'suggest は目的語に人 + to不定詞をとれない。that節（原形）か動名詞。' }],
    mission: '友達か同僚に何かを提案するメッセージを、頭の中で I suggest (that) we ~ に置き換えてみる' },
  { path: ['数学', '高校数学'], front: '二次方程式の解の公式', meaning: 'ax²+bx+c=0 の解は x = (−b ± √(b²−4ac)) / 2a', concept: '平方完成を一度やっておいた「完成品」。因数分解できないときの最終手段',
    problems: [{ q: '縦が横より3m長い長方形の花壇を作る。面積を40m²にするには横を何mにする？', a: 'x(x+3)=40 → x²+3x−40=0 → x=(−3±√(9+160))/2=(−3±13)/2 → x=5（m）', exp: '因数分解 (x+8)(x−5) でも解けるが、解の公式ならどんな形でも確実。負の解は長さなので捨てる。' },
      { q: '2x²−4x−1=0 を解け。', a: 'x = (4 ± √(16+8)) / 4 = (2 ± √6) / 2', exp: 'a=2, b=−4, c=−1。b²−4ac=24, √24=2√6。' }],
    mission: '買い物や部屋の配置で「面積から長さを逆算する」場面を1つ見つけて式にする' },
  { path: ['プログラミング', 'JavaScript'], front: 'Array.prototype.map', meaning: '配列の各要素に関数を適用し、新しい配列を返す（元の配列は変えない）', concept: 'ベルトコンベアの各箱に同じ加工をして、別のコンベアに流す',
    problems: [{ q: 'バグを直せ：const doubled = [1,2,3].map(n => { n * 2 });  // [undefined×3] になる', a: 'const doubled = [1,2,3].map(n => n * 2);  または  map(n => { return n * 2; })', exp: '波かっこを使うと関数本体になり、return がないと undefined を返す。' }],
    mission: '今書いているコードで for 文で配列を作り直している所を1つ map に書き換える' },
  { path: ['趣味', 'ダーツ'], front: 'グリップは「卵を持つ力」', meaning: '強く握るとリリースがぶれる。親指と人差し指で軽く支え、他の指は添えるだけ', concept: '生卵を割らずに持つくらいの力',
    problems: [{ q: '最近ダーツが左右に散る。投げる直前にまず何を確認する？', a: 'グリップの力み。握りすぎていないか（卵を持つ力か）を確認し、肘の位置を固定する。', exp: '左右のブレは握りすぎ・肘のブレが原因になりやすい。' }],
    mission: '次の練習で、最初の3投は「卵の力」だけを意識して投げ、散らばりを比べる' },
  { path: ['趣味', '筋トレ'], front: 'プログレッシブオーバーロード', meaning: '重さ・回数・セット数を少しずつ増やして体に新しい負荷をかけ続ける原則', concept: '階段を一段ずつ上る。同じ段にいると体は慣れる',
    problems: [{ q: 'ベンチプレス 50kg×10回×3セットを3週間続けて伸びない。次の週の具体的メニューを1つ。', a: '例：52.5kg×8回×3セット、または 50kg×12回×3セット（どれか1つの変数を少し上げる）', exp: '変える変数は1つずつ。重さを上げたら回数は一時的に下がってよい。' }],
    mission: '次のトレーニングで、どれか1種目の重さか回数を「1段だけ」上げて記録する' },
];
function loadSample() {
  importCards(JSON.stringify(SAMPLE));
  toast('サンプルを入れました');
  render();
}

// ---------- 同期（Supabase REST） ----------
const sync = {
  timer: null, busy: false, status: '', again: false,
  cfg() { try { return JSON.parse(localStorage.getItem('vk_sync') || 'null'); } catch { return null; } },
  on() { const c = this.cfg(); return !!(c && c.url && c.key); },
  badge() { if (!this.on()) return '端末内保存'; if (this.busy) return '同期中…'; return this.status.startsWith('同期エラー') ? '⚠ 同期エラー' : (this.status ? '同期済み' : ''); },
  schedule() { if (!this.on()) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 2000); },
  async req(path, opts = {}) {
    const c = this.cfg();
    const r = await fetch(c.url.replace(/\/+$/, '') + '/rest/v1/' + path, {
      ...opts,
      // 旧 anon キー(JWT)は Authorization にも入れる。新しい sb_publishable_ キーは apikey だけ
      headers: { apikey: c.key, ...(c.key.startsWith('eyJ') ? { Authorization: 'Bearer ' + c.key } : {}), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 160));
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  },
  async run() {
    if (!this.on()) return;
    if (this.busy) { this.again = true; return; }
    if (!navigator.onLine) { this.status = 'オフライン（つながったら同期します）'; refreshPassive(); return; }
    this.busy = true; refreshPassive();
    let pulled = 0, pushed = 0;
    try {
      // 1) 取ってくる：サーバー時刻 server_ts で続きから
      let since = localStorage.getItem('vk_pull') || '1970-01-01T00:00:00Z';
      for (;;) {
        const rows = await this.req(`vk_items?select=id,data,updated,server_ts&server_ts=gt.${encodeURIComponent(since)}&order=server_ts.asc&limit=500`);
        for (const row of rows) {
          const loc = items.get(row.id);
          if (!loc || row.updated > (loc.updated || 0)) { save({ ...row.data, updated: row.updated, dirty: false }, { fromRemote: true }); pulled++; }
          since = row.server_ts;
        }
        localStorage.setItem('vk_pull', since);
        if (rows.length < 500) break;
      }
      // 2) 送る：この端末で変えたものだけ
      const dirty = [...items.values()].filter(r => r.dirty);
      for (let i = 0; i < dirty.length; i += 100) {
        const batch = dirty.slice(i, i + 100).map(r => { const { dirty: _, ...data } = r; return { id: r.id, data, updated: r.updated }; });
        await this.req('vk_items', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(batch) });
        for (const b of batch) { const r = items.get(b.id); if (r && r.updated === b.updated) { r.dirty = false; idb.put(r); } }
        pushed += batch.length;
      }
      this.status = `同期済み ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}（受信${pulled}・送信${pushed}）`;
    } catch (e) {
      this.status = '同期エラー：' + e.message;
    } finally {
      this.busy = false;
      if (pulled) refreshPassive(true); else refreshPassive();
      if (this.again) { this.again = false; this.schedule(); }
    }
  },
};
// 編集中・回答中の画面は書き換えない
function refreshPassive(dataChanged) {
  $('#syncBadge').textContent = sync.badge();
  if (['home', 'cards', 'settings'].includes(S.view) && (dataChanged || S.view === 'settings')) {
    const y = window.scrollY; render(); window.scrollTo(0, y);
  }
}

// ---------- 操作 ----------
const actions = {
  tab(d) {
    S.tab = d.tab;
    if (d.tab === 'review' && S.session && S.session.idx < S.session.queue.length) return go('review');
    go(d.tab === 'review' ? 'review' : d.tab);
  },
  startReview() { startReview(null); },
  reviewCat() { startReview(S.catId); },
  reveal() {
    const a = $('#myAnswer'); S._myAnswer = a ? a.value.trim() : '';
    if (S.view === 'test') S.test.revealed = true; else S.session.revealed = true;
    render();
    const ans = $('.answer'); if (ans) ans.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
  exitReview() { go('home', 'home'); },
  grade(d) {
    const s = S.session, c = items.get(s.queue[s.idx]);
    grade(c, d.g, s.q); s.done++; if (d.g !== 'again') s.ok = (s.ok || 0) + 1;
    if (d.g === 'again') s.queue.push(c.id); // セッションの最後にもう一度
    s.idx++; s.revealed = false; S._myAnswer = '';
    if (s.idx < s.queue.length) s.q = makeQuestion(items.get(s.queue[s.idx]));
    render(); window.scrollTo(0, 0);
  },
  startTest() { startTest(); },
  testMark(d) {
    const t = S.test, q = t.qs[t.idx];
    t.results.push({ id: q.id, type: q.type, ok: d.ok === '1' });
    t.idx++; t.revealed = false; S._myAnswer = '';
    if (t.idx >= t.qs.length) finishTest();
    render(); window.scrollTo(0, 0);
  },
  missionDone(d) {
    const c = items.get(d.id); c.missionDone++; c.missionLast = now(); save(c);
    toast(level(c).n === 3 ? '「応用」に到達！' : 'ミッション達成'); render();
  },
  openCat(d, el, e) { e.preventDefault(); S.catId = d.id || null; S.query = ''; go('cards', 'cards'); },
  openCard(d) { openEdit(items.get(d.id)); },
  newCard() { openEdit(newCard(S.catId)); },
  newCat() {
    const here = catPath(S.catId).map(c => c.name).join(' › ');
    const msg = here
      ? `「${here}」の中に作る分類の名前\n・複数は「,」か「、」で区切る（例：英単語、英熟語、英文法）\n・「/」でさらに下まで（例：TOEIC/英単語）`
      : `大分類の名前（例：英語、数学、趣味）\n・複数は「,」か「、」で区切る\n・「/」で中分類まで一度に（例：英語/英熟語）`;
    const text = prompt(msg);
    if (!text || !text.trim()) return;
    const made = [];
    for (const part of text.split(/[,、，]/)) {
      const names = part.split(/\s*[\/／›>]\s*/).map(s => s.trim()).filter(Boolean);
      if (!names.length) continue;
      let pid = S.catId;
      for (const n of names) {
        let c = childCats(pid).find(x => x.name === n);
        if (!c) { c = { id: uid(), kind: 'category', name: n, parentId: pid, created: now() }; save(c); }
        pid = c.id;
      }
      made.push(names.join(' › '));
    }
    toast(made.length ? `作りました：${made.join('、')}` : '名前が空でした');
    render();
  },
  renameCat() {
    const c = items.get(S.catId); const name = prompt('新しい名前', c.name);
    if (!name || !name.trim()) return; c.name = name.trim(); save(c); render();
  },
  deleteCat() {
    const ids = descIds(S.catId), n = cardsIn(S.catId).length;
    if (!confirm(`この分類と、中の分類・カード ${n} 枚をすべて削除します。よろしいですか？`)) return;
    for (const r of items.values()) if (!r.deleted && ((r.kind === 'category' && ids.has(r.id)) || (r.kind === 'card' && ids.has(r.categoryId)))) { r.deleted = true; save(r); }
    const parent = items.get(S.catId).parentId; S.catId = parent || null; render();
  },
  cancelEdit() { S.draft = null; go('cards', 'cards'); },
  addProblem() { S.draft.problems.push({ q: '', a: '', exp: '' }); render(); },
  delProblem(d) { S.draft.problems.splice(+d.i, 1); render(); },
  removeImage() { S.draft.image = ''; render(); },
  async pasteImage() {
    try {
      const list = await navigator.clipboard.read();
      for (const it of list) {
        const type = it.types.find(t => t.startsWith('image/'));
        if (type) { await setImage(await it.getType(type)); return; }
      }
      toast('クリップボードに画像がありません。スクショをコピーしてからもう一度');
    } catch (e) { toast('貼れませんでした：' + (e.message || e.name)); }
  },
  saveCard() {
    const isNew = !items.has(S.draft.id);
    if (!commitDraft()) return;
    S.draft = null;
    toast(isNew ? 'カードを作りました' : '保存しました');
    go('cards', 'cards');
  },
  // いま編集中のカードを保存して、同じ表の新しい意味を作る
  addSense() {
    const d = S.draft;
    if (!d.front.trim()) { toast('先に表を入れてください'); return; }
    if (!d.group) d.group = uid();
    if (!commitDraft()) return;
    const n = newCard(d.categoryId);
    n.front = d.front; n.group = d.group;
    openEdit(n);
    toast('新しい意味を作ります。ヒント・写真・意味を入れて保存');
  },
  openSibling(d) {
    if (S.draft.front.trim() && !commitDraft()) return;
    openEdit(items.get(d.id));
  },
  deleteCard() {
    if (!confirm('このカードを削除しますか？')) return;
    const c = items.get(S.draft.id); c.deleted = true; save(c); S.draft = null; go('cards', 'cards');
  },
  resetCard() {
    if (!confirm('復習の段階を最初に戻しますか？')) return;
    S.draft.srs = { ...S.draft.srs, stage: 0, due: now() }; toast('保存すると最初から復習します'); render();
  },
  saveSync() {
    const url = $('#sUrl').value.trim(), key = $('#sKey').value.trim();
    if (url && !/^https:\/\/.+/.test(url)) { toast('URL は https:// で始めてください'); return; }
    localStorage.setItem('vk_sync', JSON.stringify({ url, key }));
    sync.status = url ? '同期を始めます…' : '未設定';
    render(); sync.run();
  },
  syncNow() { sync.run(); },
  resync() { localStorage.removeItem('vk_pull'); for (const r of items.values()) { r.dirty = true; idb.put(r); } sync.run(); toast('全件を取り直します'); },
  async copyRequest() {
    const t = requestText();
    try { await navigator.clipboard.writeText(t); toast('依頼文をコピーしました。Claude Code に貼ってください'); }
    catch { $('#importBox').value = t; toast('コピーできなかったので下の欄に出しました'); }
  },
  importJson() {
    const t = $('#importBox').value; if (!t.trim()) { toast('JSON を貼ってください'); return; }
    try { const r = importCards(t); toast(`追加 ${r.added} 枚・更新 ${r.updated} 枚`); render(); }
    catch (e) { toast('読み取れません：' + e.message); }
  },
  exportAll() { exportAll(); },
  loadSample() { loadSample(); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset, el, e);
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'search') { if (e.isComposing) return; S.query = el.value; const pos = el.selectionStart; render(); const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos); return; }
  if (!S.draft) return;
  if (el.tagName === 'TEXTAREA') { el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px'; }
  if (el.dataset.f && el.type !== 'checkbox' && el.tagName !== 'SELECT') S.draft[el.dataset.f] = el.value;
  if (el.dataset.p !== undefined) S.draft.problems[+el.dataset.p][el.dataset.k] = el.value;
});
async function setImage(blob) {
  try { S.draft.image = await resizeImage(blob); render(); toast('画像を貼りました'); } catch (err) { toast(err.message); }
}
// ドラッグ＆ドロップ：カード編集画面のどこに落としても入る（Mac のスクショサムネ・Finder の画像）
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
const editing = () => S.view === 'edit' && !!S.draft;
let dragDepth = 0;
function dzOn(on) { const z = $('#dropzone'); if (z) z.classList.toggle('over', on); }
document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); if (editing()) { dragDepth++; dzOn(true); } });
document.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); if (editing()) e.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('dragleave', e => { if (!hasFiles(e) || !editing()) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dzOn(false); });
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); // 画面の外れに落としてもブラウザが画像を開いて画面が消えないように
  dragDepth = 0; dzOn(false);
  if (!editing()) { toast('カードの編集画面に落としてください'); return; }
  const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/'));
  if (!f) { toast('画像ファイルではありません'); return; }
  setImage(f);
});
// Ctrl/⌘+V・長押し「ペースト」で画像を貼る（カード編集中のみ）
document.addEventListener('paste', e => {
  if (S.view !== 'edit' || !S.draft) return;
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
  if (!f) return; // 文字の貼り付けはそのまま
  e.preventDefault(); setImage(f);
});
// 入力欄を、書いた量に合わせて広げる（閉じている折りたたみの中は 0 なので触らない）
function autosize(root = document) {
  root.querySelectorAll('#main textarea').forEach(t => {
    t.style.height = 'auto';
    if (t.scrollHeight > 0) t.style.height = (t.scrollHeight + 2) + 'px';
  });
}
// 折りたたみの開閉を覚える（toggle は伝わらないので capture で受ける）
document.addEventListener('toggle', e => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement) || !el.dataset.sec) return;
  S.sec[el.dataset.sec] = el.open;
  if (el.open) autosize(el);
}, true);
// キーボード（PC）：Space/Enter＝答えを見る、1〜4＝もう一度/難しい/正解/簡単、書いている最中は ⌘/Ctrl+Enter
document.addEventListener('keydown', e => {
  if (e.isComposing) return;
  const rev = S.view === 'review' && S.session && S.session.idx < S.session.queue.length;
  if (!rev && !(S.view === 'test' && S.test && S.test.idx < S.test.qs.length)) return;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const revealed = rev ? S.session.revealed : S.test.revealed;
  if (!revealed && ((!inField && (e.key === ' ' || e.key === 'Enter')) || ((e.metaKey || e.ctrlKey) && e.key === 'Enter'))) { e.preventDefault(); actions.reveal(); return; }
  if (revealed && rev && !inField) { const g = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[e.key]; if (g) actions.grade({ g }); }
});
document.addEventListener('compositionend', e => {
  if (e.target.id === 'search') e.target.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (S.draft && el.dataset.f === 'needsAI') S.draft.needsAI = el.checked;
  if (S.draft && el.dataset.f === 'categoryId') S.draft.categoryId = el.value || null;
  if (el.id === 'imgInput' && el.files[0]) {
    try { S.draft.image = await resizeImage(el.files[0]); render(); } catch (err) { toast(err.message); }
  }
  if (el.id === 'restoreInput' && el.files[0]) {
    try { const n = restoreAll(await el.files[0].text()); toast(`${n} 件を読み込みました`); render(); } catch (err) { toast('読み込めません：' + err.message); }
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync.run(); if (['home', 'cards'].includes(S.view)) render(); } });
window.addEventListener('online', () => sync.run());

// ---------- 起動 ----------
(async function start() {
  try {
    await idb.open();
    for (const r of await idb.all()) items.set(r.id, r);
  } catch (e) {
    $('#main').innerHTML = `<div class="box">データを開けませんでした：${esc(e.message)}<br>プライベートブラウズでは保存できません。</div>`;
    return;
  }
  render();
  sync.run();
  setInterval(() => { if (!document.hidden) sync.run(); }, 60000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
