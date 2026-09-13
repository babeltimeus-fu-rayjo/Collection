const REPO = 'babeltimeus-fu-rayjo/Collection';
const KEY = 'collection-version';
const TTL = 120_000;

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

  const el = document.createElement('div');
  el.id = 'ver';
  el.textContent = stamp;
  // sit clear of the chat button (bottom-right: 40px wide, inset 24px to clear the
  // scrollbar) so neither covers the other
  el.style.cssText =
    'position:fixed;right:76px;bottom:16px;font:10px/1 "SF Mono",Menlo,Consolas,monospace;' +
    'color:rgba(255,255,255,.3);z-index:1;pointer-events:none;user-select:none;';
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
