/* Loaded first in every page of the phone app: borrow the app shell's extension stand-ins. */
window.JA = { platform: 'web' };
window.browser = window.parent && window.parent !== window && window.parent.JA_WEB
  ? window.parent.JA_WEB.browserFor(window)
  : (() => { location.replace('../index.html'); return {}; })();
