/* Japanese deinflection: turns 食べなかった into candidate dictionary forms (食べる, ...).
 * Rule-based, Yomitan-style. Each rule: if the word ends with `from` and its current
 * grammatical class matches `inT`, replace with `to` and set class to `outT`. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.deinflect = (() => {
  const TERM = 1, V1 = 2, V5 = 4, VS = 8, VK = 16, ADJ = 32, TE = 64, NOUN = 128;
  const ALL = 255;
  const rules = []; // {from, to, inT, outT, why}
  const add = (from, to, inT, outT, why) => rules.push({ from, to, inT, outT, why });

  const U = 'うくぐすつぬぶむる'.split('');
  const A = 'わかがさたなばまら'.split('');
  const I = 'いきぎしちにびみり'.split('');
  const E = 'えけげせてねべめれ'.split('');
  const O = 'おこごそとのぼもろ'.split('');
  const TEF = ['って', 'いて', 'いで', 'して', 'って', 'んで', 'んで', 'んで', 'って'];
  const TAF = ['った', 'いた', 'いだ', 'した', 'った', 'んだ', 'んだ', 'んだ', 'った'];

  const godan = (fn) => U.forEach((u, i) => fn(u, i));
  const KURU = [['く', 'き', 'こ'], ['来', '来', '来']]; // [dict-prefix, i-stem, o/a-stem]

  // --- polite ます family
  for (const m of ['ます', 'ました', 'ません', 'ませんでした', 'ましょう', 'まして', 'ませ']) {
    add(m, 'る', TERM, V1, 'polite');
    godan((u, i) => add(I[i] + m, u, TERM, V5, 'polite'));
    add('し' + m, 'する', TERM, VS, 'polite');
    add('き' + m, 'くる', TERM, VK, 'polite');
    add('来' + m, '来る', TERM, VK, 'polite');
  }
  // --- negative ない (behaves like an i-adjective)
  add('ない', 'る', ADJ, V1, 'negative');
  godan((u, i) => add(A[i] + 'ない', u, ADJ, V5, 'negative'));
  add('しない', 'する', ADJ, VS, 'negative');
  add('こない', 'くる', ADJ, VK, 'negative');
  add('来ない', '来る', ADJ, VK, 'negative');
  // --- ず / ずに
  for (const z of ['ず', 'ずに']) {
    add(z, 'る', TERM, V1, 'zu');
    godan((u, i) => add(A[i] + z, u, TERM, V5, 'zu'));
    add('せ' + z, 'する', TERM, VS, 'zu');
  }
  // --- たい (want to)
  add('たい', 'る', ADJ, V1, 'tai');
  godan((u, i) => add(I[i] + 'たい', u, ADJ, V5, 'tai'));
  add('したい', 'する', ADJ, VS, 'tai');
  add('きたい', 'くる', ADJ, VK, 'tai');
  add('来たい', '来る', ADJ, VK, 'tai');
  // --- te form
  add('て', 'る', TERM | TE, V1, 'te');
  godan((u, i) => add(TEF[i], u, TERM | TE, V5, 'te'));
  add('して', 'する', TERM | TE, VS, 'te');
  add('きて', 'くる', TERM | TE, VK, 'te');
  add('来て', '来る', TERM | TE, VK, 'te');
  add('行って', '行く', TERM | TE, V5, 'te');
  add('いって', 'いく', TERM | TE, V5, 'te');
  // --- past / tara / tari
  for (const tail of ['', 'ら', 'り']) {
    add('た' + tail, 'る', TERM, V1, 'past');
    godan((u, i) => add(TAF[i] + tail, u, TERM, V5, 'past'));
    add('した' + tail, 'する', TERM, VS, 'past');
    add('きた' + tail, 'くる', TERM, VK, 'past');
    add('来た' + tail, '来る', TERM, VK, 'past');
    add('行った' + tail, '行く', TERM, V5, 'past');
    add('いった' + tail, 'いく', TERM, V5, 'past');
  }
  // --- conditional ば
  add('れば', 'る', TERM, V1, 'ba');
  godan((u, i) => add(E[i] + 'ば', u, TERM, V5, 'ba'));
  add('すれば', 'する', TERM, VS, 'ba');
  add('くれば', 'くる', TERM, VK, 'ba');
  add('来れば', '来る', TERM, VK, 'ba');
  // --- volitional
  add('よう', 'る', TERM, V1, 'volitional');
  godan((u, i) => add(O[i] + 'う', u, TERM, V5, 'volitional'));
  add('しよう', 'する', TERM, VS, 'volitional');
  add('こよう', 'くる', TERM, VK, 'volitional');
  add('来よう', '来る', TERM, VK, 'volitional');
  // --- imperative
  add('ろ', 'る', TERM, V1, 'imperative');
  add('よ', 'る', TERM, V1, 'imperative');
  godan((u, i) => add(E[i], u, TERM, V5, 'imperative'));
  add('しろ', 'する', TERM, VS, 'imperative');
  add('せよ', 'する', TERM, VS, 'imperative');
  add('こい', 'くる', TERM, VK, 'imperative');
  add('来い', '来る', TERM, VK, 'imperative');
  // --- なさい
  add('なさい', 'る', TERM, V1, 'nasai');
  godan((u, i) => add(I[i] + 'なさい', u, TERM, V5, 'nasai'));
  add('しなさい', 'する', TERM, VS, 'nasai');
  // --- potential / passive / causative (results are ichidan verbs)
  godan((u, i) => add(E[i] + 'る', u, V1, V5, 'potential'));
  godan((u, i) => add(A[i] + 'れる', u, V1, V5, 'passive'));
  godan((u, i) => add(A[i] + 'せる', u, V1, V5, 'causative'));
  add('られる', 'る', V1, V1, 'potential/passive');
  add('れる', 'る', V1, V1, 'potential');
  add('させる', 'る', V1, V1, 'causative');
  add('される', 'する', V1, VS, 'passive');
  add('させる', 'する', V1, VS, 'causative');
  add('できる', 'する', V1, VS, 'potential');
  for (const [k, stem] of [['くる', 'こ'], ['来る', '来']]) {
    add(stem + 'られる', k, V1, VK, 'potential/passive');
    add(stem + 'れる', k, V1, VK, 'potential');
    add(stem + 'させる', k, V1, VK, 'causative');
  }
  // --- すぎる
  add('すぎる', 'る', V1, V1, 'too much');
  godan((u, i) => add(I[i] + 'すぎる', u, V1, V5, 'too much'));
  add('すぎる', 'い', V1, ADJ, 'too much');
  // --- te-form compounds -> back to te form
  const teAux = [
    ['いる', V1], ['る', V1], ['おく', V5], ['しまう', V5], ['ある', V5], ['いく', V5],
    ['くる', VK], ['くれる', V1], ['もらう', V5], ['あげる', V1], ['みる', V1],
    ['ほしい', ADJ], ['ください', TERM], ['くれ', TERM],
  ];
  for (const [aux, t] of teAux) {
    add('て' + aux, 'て', t, TE, 'te+' + aux);
    add('で' + aux, 'で', t, TE, 'te+' + aux);
  }
  add('とく', 'て', V5, TE, 'te+oku');
  add('どく', 'で', V5, TE, 'te+oku');
  add('ちゃう', 'て', V5, TE, 'te+shimau');
  add('じゃう', 'で', V5, TE, 'te+shimau');
  add('ちまう', 'て', V5, TE, 'te+shimau');
  // --- i-adjectives
  add('くない', 'い', ADJ, ADJ, 'negative');
  add('かった', 'い', TERM, ADJ, 'past');
  add('かったら', 'い', TERM, ADJ, 'tara');
  add('くて', 'い', TERM | TE, ADJ, 'te');
  add('ければ', 'い', TERM, ADJ, 'ba');
  add('く', 'い', TERM, ADJ, 'adverb');
  add('さ', 'い', TERM, ADJ, 'noun');
  add('そう', 'い', TERM, ADJ, 'looks');
  add('くなる', 'い', V5, ADJ, 'become');
  add('なきゃ', 'ない', TERM, ADJ, 'must');
  add('なくちゃ', 'ない', TERM, ADJ, 'must');
  // --- ても / ては / ちゃ (= ては) / でも / では / じゃ
  for (const [t, d] of [['ても', 'て'], ['ては', 'て'], ['ちゃ', 'て'], ['でも', 'で'], ['では', 'で'], ['じゃ', 'で']]) add(t, d, TERM, TE, 'te+' + t.slice(1));
  add('くても', 'い', TERM, ADJ, 'te+mo');
  // --- ながら (while), そう (looks like), たがる (wants to)
  add('ながら', 'る', TERM, V1, 'while');
  godan((u, i) => add(I[i] + 'ながら', u, TERM, V5, 'while'));
  add('しながら', 'する', TERM, VS, 'while');
  add('そう', 'る', TERM, V1, 'looks');
  godan((u, i) => add(I[i] + 'そう', u, TERM, V5, 'looks'));
  add('たがる', 'る', V5, V1, 'wants');
  godan((u, i) => add(I[i] + 'たがる', u, V5, V5, 'wants'));
  // --- colloquial negative ん (わからん, 知らん)
  godan((u, i) => add(A[i] + 'ん', u, TERM, V5, 'negative'));
  add('せん', 'する', TERM, VS, 'negative');
  // --- masu stem used on its own (読み、 / 食べ、)
  godan((u, i) => add(I[i], u, TERM, V5, 'stem'));
  for (const k of I.concat(E)) add(k, k + 'る', TERM, V1, 'stem');
  // --- i-adjective + がる (怖がる)
  add('がる', 'い', V5, ADJ, 'garu');

  // --- noun + する
  add('する', '', VS, NOUN, 'suru');

  // index rules by last char of `from` for speed
  const byLast = new Map();
  for (const r of rules) {
    const k = r.from.slice(-1);
    if (!byLast.has(k)) byLast.set(k, []);
    byLast.get(k).push(r);
  }

  /** Returns [{term, type, reasons}] including the input itself (type ALL). */
  function deinflect(word) {
    const out = [{ term: word, type: ALL, reasons: [] }];
    const seen = new Set([word + ':' + ALL]);
    for (let i = 0; i < out.length && out.length < 200; i++) {
      const cur = out[i];
      const cands = byLast.get(cur.term.slice(-1));
      if (!cands) continue;
      for (const r of cands) {
        if (!(cur.type & r.inT)) continue;
        if (!cur.term.endsWith(r.from)) continue;
        const stem = cur.term.slice(0, cur.term.length - r.from.length);
        if (!stem && !r.to) continue;
        if (!stem && r.from.length === cur.term.length && r.to.length <= 1 && r.outT !== VS && r.outT !== VK) continue;
        const term = stem + r.to;
        if (!term) continue;
        const key = term + ':' + r.outT;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ term, type: r.outT, reasons: cur.reasons.concat(r.why) });
      }
    }
    return out;
  }

  /** Does a dictionary entry's part-of-speech list fit a deinflected class? */
  function posFits(type, posList) {
    if (type === ALL) return true;
    if (!posList || !posList.length) return !(type & (TE | TERM)); // unknown POS (e.g. Anki-only word)
    const has = (pred) => posList.some(pred);
    if (type & V1 && has(p => p === 'v1' || p === 'v1-s')) return true;
    if (type & V5 && has(p => p.startsWith('v5'))) return true;
    if (type & VS && has(p => p.startsWith('vs'))) return true;
    if (type & VK && has(p => p === 'vk')) return true;
    if (type & ADJ && has(p => p === 'adj-i' || p === 'adj-ix')) return true;
    if (type & NOUN && has(p => p.startsWith('vs'))) return true;
    return false;
  }

  return { deinflect, posFits, T: { TERM, V1, V5, VS, VK, ADJ, TE, NOUN, ALL }, ruleCount: rules.length };
})();

if (typeof module !== 'undefined') module.exports = JA;
