// Snaps by Synal — content.js v1.0.1
// Passive observer, DOM context provider

(() => {
  // Listen for context requests from popup/background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_PAGE_CONTEXT') {
      sendResponse({
        selection:   window.getSelection()?.toString().trim() || '',
        title:       document.title,
        url:         location.href,
        description: document.querySelector('meta[name=description]')?.content || '',
        og_title:    document.querySelector('meta[property="og:title"]')?.content || '',
        word_count:  document.body.innerText.split(/\s+/).length
      });
    }
    return true;
  });
})();
