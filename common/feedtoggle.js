// common/feedtoggle.js — a universal show/hide toggle for the game log (#feed),
// shared by every game in the collection. Import it for its side effect:
//
//   import '../common/feedtoggle.js';
//
// It adds a small 📜 button next to the ⚙ settings gear (bottom-left). Clicking
// it hides/shows the log; the choice persists per game, per browser. The log
// itself is re-rendered by each game into #feed, so the toggle only flips a
// body class (never touches #feed's contents).

(function () {
  function init() {
    const feed = document.getElementById('feed');
    if (!feed || document.getElementById('feed-toggle')) return;

    const key = 'feedhide:' + location.pathname.replace(/[^/]*$/, '');
    // a game can opt its log into being hidden by default with
    // <div id="feed" data-default="hidden">; a stored choice always wins.
    let hidden = feed.dataset.default === 'hidden';
    try { const v = localStorage.getItem(key); if (v === '0' || v === '1') hidden = v === '1'; } catch {}

    const style = document.createElement('style');
    style.id = 'feed-toggle-style';
    style.textContent = `
      #feed-toggle { position: fixed; left: 54px; bottom: 12px; z-index: 95; width: 36px; height: 36px;
        border-radius: 50%; border: 1px solid rgba(255,255,255,.22); background: rgba(16,19,28,.82);
        color: #dfe6f2; font-size: 16px; line-height: 1; cursor: pointer; opacity: .5; padding: 0;
        transition: opacity .15s; }
      #feed-toggle:hover { opacity: 1; }
      #feed-toggle.off { opacity: .95; border-color: #e0b34e; color: #e0b34e; }
      body.feed-hidden #feed { display: none !important; }
    `;
    document.head.append(style);

    const btn = document.createElement('button');
    btn.id = 'feed-toggle';
    btn.type = 'button';
    btn.textContent = '📜';

    function apply() {
      document.body.classList.toggle('feed-hidden', hidden);
      btn.classList.toggle('off', hidden);
      btn.title = hidden ? 'Show the game log' : 'Hide the game log';
      btn.setAttribute('aria-pressed', String(!hidden));
    }
    btn.addEventListener('click', () => {
      hidden = !hidden;
      // persist the explicit choice ('1'/'0') so it overrides the page default
      try { localStorage.setItem(key, hidden ? '1' : '0'); } catch {}
      apply();
    });
    document.body.append(btn);
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
