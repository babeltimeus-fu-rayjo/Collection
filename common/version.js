const REPO = 'babeltimeus-fu-rayjo/Collection';
const KEY = 'collection-version';
const TTL = 120_000;

// "What does the repo have" and "what is this page running" are two questions,
// and this stamp used to answer only the first: it asked the GitHub API for the
// newest commit and printed that. So a browser holding a ten-minute-old
// stylesheet showed a brand new hash over an old layout — which is exactly the
// moment you are reading the stamp, to check whether a change landed.
//
// GitHub Pages serves CSS with max-age=600 and phones hold it longer, so this
// is the normal case, not an edge one. The check is cheap: if the stylesheet
// came off the network on this load it is current by definition, and only if it
// came out of the cache is it worth asking the server whether the copy still
// matches.
async function stylesheetIsStale(link) {
  if (!link || !link.href) return false;
  try {
    const entry = performance.getEntriesByType('resource').find((e) => e.name === link.href);
    if (entry && entry.transferSize > 0) return false;
    const [live, mine] = await Promise.all([
      fetch(link.href, { cache: 'no-store' }),
      fetch(link.href, { cache: 'force-cache' }),
    ]);
    const tag = (r) => r.headers.get('etag') || r.headers.get('last-modified') || '';
    const a = tag(live);
    const b = tag(mine);
    if (a && b) return a !== b;
    const [x, y] = await Promise.all([live.text(), mine.text()]);
    return x.length !== y.length;
  } catch {
    return false;
  }
}

// Re-fetching each asset with cache: 'reload' goes to the network AND replaces
// the cache entry, so the reload that follows picks up the new copies. A plain
// reload does not: on a phone it will happily serve the same stale stylesheet
// back to you, which is the loop this is here to break.
async function refreshAssets() {
  const urls = [
    ...document.querySelectorAll('link[rel="stylesheet"]'),
    ...document.querySelectorAll('script[src]'),
  ].map((n) => n.href || n.src).filter(Boolean);
  await Promise.all(urls.map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
  location.reload();
}

async function init() {
  let info;
  try {
    const raw = localStorage.getItem(KEY);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.ts < TTL) {
      info = cached;
    } else {
      const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      info = {
        hash: data.sha.slice(0, 7),
        date: data.commit.committer.date,
        ts: Date.now(),
      };
      try { localStorage.setItem(KEY, JSON.stringify(info)); } catch {}
    }
  } catch { return; }

  const d = new Date(info.date);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${info.hash} · ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const link = document.querySelector('link[rel="stylesheet"]');
  const stale = await stylesheetIsStale(link);

  const el = document.createElement('div');
  el.id = 'ver';
  el.textContent = stale ? `${info.hash} \u00b7 new build \u2014 tap to load it` : stamp;
  // sit clear of the chat button (bottom-right: 40px wide, inset 24px to clear the
  // scrollbar) so neither covers the other
  el.style.cssText =
    'position:fixed;right:76px;bottom:16px;font:10px/1 "SF Mono",Menlo,Consolas,monospace;' +
    'color:rgba(255,255,255,.3);z-index:1;pointer-events:none;user-select:none;';
  if (stale) {
    el.style.color = 'rgba(232,213,163,.9)';
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      el.textContent = 'loading\u2026';
      refreshAssets();
    });
  }
  document.body.append(el);

  // The build stamp belongs on the pages you read, not on the table you play at.
  // Every game in the collection shows its home and lobby as #screen-home /
  // #screen-lobby and the table as #screen-game, so one rule covers all of them:
  // hide while the table is up. The collection index has no #screen-game, so the
  // stamp simply stays.
  const table = document.querySelector('#screen-game');
  if (!table) return;
  const sync = () => { el.hidden = !table.classList.contains('hidden'); };
  new MutationObserver(sync).observe(table, { attributes: true, attributeFilter: ['class'] });
  sync();
}

init();
