/* The word engine shared by the extension background and the Claude connector:
 * dictionary + what-you-know index + frequency ranks + sentence bank. */
var JA = globalThis.JA || (globalThis.JA = {});

const sentenceScore = s => (/[。！？!?」』]$/.test(s) ? 2 : 0) + (s.length >= 8 && s.length <= 70 ? 2 : 0) - Math.abs(Math.min(s.length, 90) - 28) / 40;

JA.Engine = class Engine {
  constructor() {
    this.dict = new JA.dict.Dictionary();
    this.know = new JA.Knowledge(this.dict);
    this.freq = new JA.freq.Frequency();
    this.bank = {};
    this.know.rankOf = i => this.freq.rankOfEntry(this.dict, i);
  }

  static SKIP_POS = new Set(['prt', 'aux', 'aux-v', 'aux-adj', 'cop', 'conj']);

  isGrammar(idx) {
    if (idx === null || idx === undefined) return false;
    const fp = this.dict.rows[idx][5];
    return fp.length > 0 && fp.every(p => JA.Engine.SKIP_POS.has(p));
  }

  rankOfToken(tok) {
    if (tok.primary !== null && tok.primary !== undefined) {
      let best = null;
      for (const i of tok.idxs) { const r = this.freq.rankOfEntry(this.dict, i); if (r !== null && (best === null || r < best)) best = r; }
      return best;
    }
    return this.freq.rankOfTerm(tok.base);
  }

  info(tok) {
    const i = JA.tokenizer.wordInfo(tok, this.know);
    return { ...i, rank: this.rankOfToken(tok) };
  }

  /** For page highlighting: per text, token spans; plus one info record per word. */
  tokenizeTexts(texts) {
    const words = {};
    const results = texts.map(t => {
      const out = [];
      for (const k of JA.tokenizer.tokenize(t, this.know)) {
        if (k.skip) continue;
        if (!words[k.key]) { const i = this.info(k); words[k.key] = { w: i.word, r: i.reading, g: i.meaning, k: i.kanji || '', st: k.status, u: !!k.unparsed, f: i.rank }; }
        out.push([k.s, k.e, k.key]);
      }
      return out;
    });
    return { results, words };
  }

  /** Words in a text with counts, an example sentence each, status and frequency rank. */
  analyzeText(text, source = '') {
    const agg = new Map();
    for (const sen of JA.tokenizer.sentences(text)) {
      for (const k of JA.tokenizer.tokenize(sen.text, this.know)) {
        if (k.skip) continue;
        let a = agg.get(k.key);
        if (!a) {
          const i = this.info(k);
          agg.set(k.key, (a = { key: k.key, word: i.word, reading: i.reading, meaning: i.meaning, kanji: i.kanji || '', rank: i.rank, sentence: sen.text, surface: k.surface, count: 0, status: k.status, unparsed: !!k.unparsed }));
          if (k.status < JA.ST.KNOWN) JA.shared.addSentences(this.bank, k.key, [{ s: sen.text, w: k.surface, src: source }]);
        }
        a.count++;
      }
    }
    const list = [...agg.values()];
    let tot = 0, known = 0;
    for (const a of list) { tot += a.count; if (a.status >= JA.ST.LEARNING) known += a.count; }
    return { words: list.sort((a, b) => b.count - a.count), coverage: tot ? (known / tot) * 100 : 0, tokens: tot };
  }

  /**
   * Whole-book coverage. chapters: [{title, text}].
   * Returns running-word coverage, unique words, per-chapter coverage, how many new words reach
   * 90/95/98 %, and the most frequent words you don't know (with the first sentence they appear in).
   */
  analyzeBook(chapters, { source = '', countLearning = true, bankLimit = 1500, onProgress } = {}) {
    const isKnown = st => st >= JA.ST.KNOWN || (countLearning && st === JA.ST.LEARNING);
    const words = new Map();
    let tot = 0, known = 0;
    const per = [];
    chapters.forEach((ch, ci) => {
      let ct = 0, ck = 0;
      for (const sen of JA.tokenizer.sentences(ch.text)) {
        for (const k of JA.tokenizer.tokenize(sen.text, this.know)) {
          if (k.skip) continue;
          tot++; ct++;
          if (isKnown(k.status)) { known++; ck++; }
          let a = words.get(k.key);
          if (!a) {
            a = { key: k.key, status: k.status, count: 0, tok: k, sentence: sen.text, surface: k.surface, chapter: ci };
            words.set(k.key, a);
          }
          a.count++;
          // keep the most natural example sentence (a full sentence of reasonable length, not a heading)
          if (a.sentence !== sen.text && sentenceScore(sen.text) > sentenceScore(a.sentence)) { a.sentence = sen.text; a.surface = k.surface; }
        }
      }
      per.push({ title: ch.title, tokens: ct, coverage: ct ? (ck / ct) * 100 : null });
      if (onProgress) onProgress(ci + 1, chapters.length);
    });
    const unknown = [...words.values()].filter(w => !isKnown(w.status));
    for (const w of unknown) { const i = this.info(w.tok); Object.assign(w, { word: i.word, reading: i.reading, meaning: i.meaning, kanji: i.kanji || '', rank: i.rank }); delete w.tok; }
    unknown.sort((a, b) => b.count - a.count || (a.rank || 1e9) - (b.rank || 1e9));
    const need = {};
    for (const target of [90, 95, 98]) {
      let cov = known, n = 0;
      for (const w of unknown) { if (tot && (cov / tot) * 100 >= target) break; cov += w.count; n++; }
      need[target] = tot && (cov / tot) * 100 >= target ? n : null;
    }
    for (const w of unknown.slice(0, bankLimit)) JA.shared.addSentences(this.bank, w.key, [{ s: w.sentence, w: w.surface, src: source }]);
    return {
      tokens: tot,
      coverage: tot ? (known / tot) * 100 : 0,
      uniqueWords: words.size,
      uniqueKnown: words.size - unknown.length,
      need,
      chapters: per,
      unknown: unknown.slice(0, 400).map(({ tok, ...w }) => w),
    };
  }

  /** A plain list of words (one per entry). */
  lookupWords(list) {
    const out = [];
    for (const raw of list) {
      const w = JA.kana.cleanField(raw);
      if (!w) continue;
      const toks = JA.tokenizer.tokenize(w, this.know);
      const whole = toks.length === 1 && toks[0].s === 0 && toks[0].e === w.length ? toks[0] : null;
      let rec;
      if (whole) {
        const i = this.info(whole);
        rec = { key: whole.key, word: i.word, reading: i.reading, meaning: i.meaning, rank: i.rank, status: whole.status };
      } else {
        const idxs = this.know.resolve(w, '');
        const e = idxs.length ? this.dict.entry(idxs[0]) : null;
        const key = e ? 'j:' + e.id : 't:' + w;
        rec = { key, word: w, reading: e ? e.kana[0] || '' : '', meaning: e ? e.gloss : '', rank: e ? this.freq.rankOfEntry(this.dict, idxs[0]) : this.freq.rankOfTerm(w), status: this.know.statusOf(idxs, w, w, key) };
      }
      const b = JA.shared.bestSentence(this.bank, rec.key);
      out.push({ ...rec, sentence: b ? b.s : '', surface: b ? b.w : '', count: 1 });
    }
    return out;
  }

  /** Most frequent words (by the imported frequency list) that are not in Anki yet. */
  nextWords({ limit = 50, maxRank = Infinity, offset = 0 } = {}) {
    if (!this.freq.loaded) throw new Error('Import a frequency list first (Settings → Frequency list).');
    const out = [];
    const seen = new Set();
    let skipped = 0;
    for (const [term, reading, rank] of this.freq.rows) {
      if (rank > maxRank || out.length >= limit) break;
      let idxs = this.know.resolve(term, reading);
      if (!idxs.length && this.dict.loaded && this.dict.lookup(term)) idxs = this.dict.lookup(term).slice(0, 1);
      const primary = idxs.length ? idxs[0] : null;
      const key = primary !== null ? 'j:' + this.dict.rows[primary][0] : 't:' + term;
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.isGrammar(primary)) continue;
      if (this.dict.loaded && primary === null) continue; // not a dictionary word (names, fragments)
      const status = this.know.statusOf(idxs, term, term, key);
      if (status >= JA.ST.NEW) continue; // already in Anki or marked known
      if (skipped++ < offset) continue;
      const e = primary !== null ? this.dict.entry(primary) : null;
      const b = JA.shared.bestSentence(this.bank, key);
      // words normally written in kana (ある, それ) are shown in kana, not as rare kanji (在る, 其れ)
      const shown = e && e.uk && e.kana.length ? (reading && e.kana.includes(reading) ? reading : e.kana[0]) : term;
      out.push({
        key, word: shown, reading: shown === (reading || (e && e.kana[0])) ? '' : reading || (e && e.kana[0]) || '', meaning: e ? e.gloss : '', rank, status,
        sentence: b ? b.s : '', surface: b ? b.w : '', sentenceSource: b ? b.src : '',
      });
    }
    return out;
  }

  /** Fill missing reading / meaning / sentence before cards go to Anki. Cards with no sentence get a tag. */
  prepareCards(items) {
    return items.map(it => {
      const o = { ...it };
      const idxs = this.know.resolve(o.word, o.reading || '');
      const e = idxs.length ? this.dict.entry(idxs[0]) : null;
      if (e) {
        if (!o.reading) o.reading = e.kana[0] === o.word ? '' : (e.kana[0] || '');
        if (!o.meaning) o.meaning = e.gloss;
      }
      if (o.kanji && o.meaning && !o.meaning.includes(o.kanji)) o.meaning = `${o.kanji} — ${o.meaning}`;
      const key = o.key || (e ? 'j:' + e.id : 't:' + o.word);
      if (!o.sentence) {
        const b = JA.shared.bestSentence(this.bank, key);
        if (b) { o.sentence = b.s; o.surface = b.w; if (!o.source) o.source = b.src; }
      }
      o.tags = [...(o.tags || []), ...(o.sentence ? [] : ['needs-sentence'])];
      return o;
    });
  }
};

if (typeof module !== 'undefined') module.exports = JA;
