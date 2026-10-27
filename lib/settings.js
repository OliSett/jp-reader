var JA = globalThis.JA || (globalThis.JA = {});

JA.DEFAULTS = {
  ankiUrl: 'http://127.0.0.1:8765',
  ankiKey: '',
  decks: [],
  wordFields: ['Expression', 'Word', 'Vocab', 'VocabKanji', 'Kanji', 'Japanese', 'Front', 'Key'],
  readingFields: ['Reading', 'ExpressionReading', 'VocabFurigana', 'Furigana', 'Kana', 'Hiragana', 'WordReading'],
  matureDays: 21,
  suspended: 'known',          // known | learning | ignore
  countLearning: true,         // learning cards count toward coverage
  targetDeck: 'Japanese',
  noteType: 'JP Reader Vocab', // created automatically
  fieldMap: { Word: '', Reading: '', Meaning: '', Sentence: '', Source: '' },
  tags: ['jp-reader'],
  allowDuplicates: false,
  colors: { unknown: '#e5484d', new: '#3e8ef7', learning: '#f5a524', known: '#2fb26b' },
  showKnown: false,
  freqStar: 10000,             // unknown words this common get a ★ and a thicker underline
  autoParse: [],               // URL fragments that parse automatically
  watchPage: true,             // parse new text as it appears (subtitles, infinite scroll)
  jitenKey: '',
  syncKey: '',                 // links this extension with the phone app
  recTypes: [1, 9, 4],         // anime, manga, novels
  recPerType: 50,
  recPages: 1,
  recLow: 88,
  recHigh: 95,
};

JA.APP_URL = 'https://OliSett.github.io/jp-reader/'; // the phone app (filled in at deploy)

JA.loadSettings = async function () {
  const { settings } = await browser.storage.local.get('settings');
  return { ...JA.DEFAULTS, ...(settings || {}), colors: { ...JA.DEFAULTS.colors, ...((settings && settings.colors) || {}) } };
};

if (typeof module !== 'undefined') module.exports = JA;
