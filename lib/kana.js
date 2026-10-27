/* Kana / script helpers. Shared by background, pages and tests. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.kana = (() => {
  const JP_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿々〆ーｦ-ﾟ]/;
  const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々〆]/;
  const KANA_RE = /[぀-ヿー]/;

  function toHira(s) {
    return s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }
  const hasJapanese = s => JP_RE.test(s);
  const isJpChar = c => JP_RE.test(c);
  const isKanji = c => KANJI_RE.test(c);
  const isKana = c => KANA_RE.test(c);
  const isKanaOnly = s => /^[぀-ヿー]+$/.test(s);

  /** Clean an Anki field into a bare word: strip HTML, furigana brackets, spaces. */
  function cleanField(v) {
    if (!v) return '';
    let s = String(v)
      .replace(/<rt>.*?<\/rt>/gi, '')
      .replace(/<rp>.*?<\/rp>/gi, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\[[^\]]*\]/g, '')      // 漢字[かんじ] -> 漢字
      .replace(/[（(][^）)]*[）)]/g, '') // trailing (notes)
      .trim();
    // Some decks put several spellings: "食べる・喰べる" or "食べる, 喰べる" -> first
    s = s.split(/[・,、;／/]/)[0].trim();
    return s.replace(/\s+/g, '');
  }

  return { toHira, hasJapanese, isJpChar, isKanji, isKana, isKanaOnly, cleanField };
})();

if (typeof module !== 'undefined') module.exports = JA;
