/* Shared helpers for extension pages. */
window.bg = (type, data = {}) => browser.runtime.sendMessage({ type, ...data }).then(res => {
  if (!res) throw new Error('No response from the extension background.');
  if (!res.ok) throw new Error(res.error);
  return res.r;
});
window.ST_LABEL = ['Not in Anki', 'New in Anki', 'Learning', 'Known', 'Marked known'];

/** Build DOM safely (text is always inserted as text, never parsed as HTML).
 *  h('div', {class: 'x', onclick: fn}, 'text', childNode, [more, children]) */
window.h = function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected', 'type', 'href', 'src', 'title', 'min', 'max'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
};

/** Replace an element's content with a status message, optionally coloured (ok | bad | warn). */
window.say = (el, text, cls) => el.replaceChildren(cls ? h('span', { class: cls }, text) : text);
