/* "AI meanings" settings card, shared by the Firefox, iPhone (Safari) and web-app settings pages.
 * The API key is kept in this browser's extension storage only; it is never synced. */
(() => {
  const box = document.getElementById('ai');
  if (!box) return;
  async function render() {
    let st;
    try { st = await bg('getState'); } catch { setTimeout(render, 2000); return; }
    const s = st.settings || {};
    const msg = h('div', { class: 'hint' });
    const key = h('input', { type: 'password', placeholder: 'sk-ant-…', value: s.aiKey || '', autocomplete: 'off', style: { width: '100%' } });
    const model = h('input', { type: 'text', value: s.aiModel || 'claude-haiku-5-5', style: { width: '100%' } });
    const on = h('input', { type: 'checkbox', checked: s.aiHover !== false });
    const save = async () => {
      await bg('saveSettings', { settings: { aiKey: key.value.trim(), aiModel: model.value.trim() || 'claude-haiku-5-5', aiHover: on.checked } });
      msg.textContent = key.value.trim() ? 'Saved. Hover (or tap) a highlighted word to see its meaning in context.' : 'Saved. AI meanings are off until you add a key.';
    };
    const test = async () => {
      await save();
      msg.textContent = 'Testing…';
      try {
        const r = await bg('aiExplain', { word: '和', reading: 'わ', surface: '和', sentence: '佐藤和真さん、ようこそ死後の世界へ。', gloss: 'harmony, peace' });
        msg.textContent = r.valid ? 'The key works, but the test answer looked odd: ' + r.meaning : `The key works ✓ (test: 「和」 in 「佐藤和真」 → not a word here, part of ${r.partOf || 'a name'})`;
      } catch (e) { msg.textContent = e.message; }
    };
    box.replaceChildren(
      h('p', { class: 'hint' }, 'Shows what a word means in its sentence when you hover or tap it, and removes the highlight when the text isn\'t really a word there (for example part of a name). Uses your own Anthropic API key; each new word costs a fraction of a cent. The key stays in this browser and isn\'t synced to your other devices.'),
      h('label', { class: 'f' }, 'Anthropic API key'), key,
      h('label', { class: 'f', style: { marginTop: '8px' } }, 'Model'), model,
      h('label', { style: { display: 'block', marginTop: '8px' } }, on, ' AI meaning in the word popup'),
      h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } },
        h('button', { onclick: save }, 'Save'), h('button', { onclick: test }, 'Test key')),
      msg);
  }
  render();
})();
