// Decorates github.com's PR list for monitored repos with the opt-in tweaks in PR_LIST_SETTINGS.
// GitHub's class names are hashed per build, so every anchor here is a data-testid or aria-label.
const ROW_LINK_SELECTOR = '[data-testid="listitem-title-link"]';
const META_SELECTOR = '[data-testid="timestamp-container"]';
const CACHE_TTL_MS = 60_000;

let settings = {};
let monitoredRepos = new Set();
let observer = null;
let runTimer = null;
const cache = new Map(); // "owner/repo#123" -> { fetchedAt, pr }; pr is null for a PR GitHub didn't return
const inFlight = new Set();
const failedAt = new Map(); // repo -> time of last failed fetch; backs off so DOM churn can't hammer the API

// Each decorator must be idempotent: apply() is re-run on every DOM mutation pass, and a write
// that changes nothing keeps the MutationObserver from looping on our own edits.
const decorators = {
  prListDiffStats: {
    apply(row, pr) {
      const meta = row.querySelector(META_SELECTOR);
      if (!meta) return;
      const signature = `${pr.additions}/${pr.deletions}`;
      let el = row.querySelector('.prm-diff');
      if (el?.dataset.signature === signature) return;

      el ??= createEl('span', 'prm-diff');
      el.dataset.signature = signature;
      el.replaceChildren(
        createEl('span', 'prm-sep', '·'),
        createEl('span', 'prm-add', `+${pr.additions.toLocaleString()}`),
        createEl('span', 'prm-del', `−${pr.deletions.toLocaleString()}`)
      );
      if (!el.isConnected) meta.after(el);
    },
    remove(row) {
      row.querySelector('.prm-diff')?.remove();
    }
  },

  // Sits after the diff stats when both are on; diff stats always insert straight after the meta
  // anchor, so the order holds whichever is applied first.
  prListLastComment: {
    apply(row, pr) {
      const meta = row.querySelector(META_SELECTOR);
      let el = row.querySelector('.prm-last-comment');
      if (!meta || !pr.lastCommentAt) {
        el?.remove();
        return;
      }
      if (el?.dataset.signature === pr.lastCommentAt) return;

      el ??= createEl('span', 'prm-last-comment');
      el.dataset.signature = pr.lastCommentAt;
      el.replaceChildren(createEl('span', 'prm-sep', '·'), 'last comment', relativeTime(pr.lastCommentAt));
      if (!el.isConnected) (row.querySelector('.prm-diff') || meta).after(el);
    },
    remove(row) {
      row.querySelector('.prm-last-comment')?.remove();
    }
  },

  // Assignees are hidden, not removed, so React's tree stays intact and toggling off restores them
  prListReviewers: {
    apply(row, pr) {
      // Re-render when the data changed or React redrew part of the row out from under us
      const signature = JSON.stringify([pr.needsMyReview, pr.reviewers.map(r => [r.login, r.state, r.avatarUrl])]);
      const assignees = assigneeElements(row);
      const intact = assignees.every(el => el.classList.contains('prm-hidden')) &&
        (pr.reviewers.length === 0 || row.querySelector('.prm-reviewers'));
      if (row.dataset.prmReviewers === signature && intact) return;

      this.remove(row);
      row.dataset.prmReviewers = signature;
      row.classList.toggle('prm-needs-my-review', Boolean(pr.needsMyReview));
      assignees.forEach(el => el.classList.add('prm-hidden'));
      if (pr.reviewers.length === 0) return;

      const stack = createEl('span', 'prm-reviewers');
      for (const reviewer of pr.reviewers) stack.append(reviewerAvatar(reviewer));
      if (assignees.length) assignees.at(-1).after(stack);
      else row.lastElementChild?.append(stack);
    },
    remove(row) {
      row.querySelector('.prm-reviewers')?.remove();
      row.querySelectorAll('.prm-hidden').forEach(el => el.classList.remove('prm-hidden'));
      row.classList.remove('prm-needs-my-review');
      delete row.dataset.prmReviewers;
    }
  }
};

const REVIEW_STATE_LABELS = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  COMMENTED: 'Commented',
  DISMISSED: 'Dismissed',
  PENDING: 'Review pending'
};

// Elements to hide for the assignee avatars: their shared wrapper (GitHub's avatar stack), or the
// buttons one by one if that wrapper also holds text such as the comment count.
function assigneeElements(row) {
  const buttons = [...row.querySelectorAll('button[aria-label^="Filter by assignee"]')];
  if (buttons.length === 0) return [];
  let container = buttons[0];
  while (container !== row && !buttons.every(b => container.contains(b))) container = container.parentElement;
  return container !== row && container.textContent.trim() === '' ? [container] : buttons;
}

// GitHub's <relative-time> element, with our own "3 hours ago" as its text: the element is defined
// in the page's world, not this content script's, so the fallback shows if it never upgrades.
const RELATIVE_UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function relativeTime(iso) {
  const date = new Date(iso);
  const seconds = (date.getTime() - Date.now()) / 1000;
  const [unit, size] = RELATIVE_UNITS.find(([, s]) => Math.abs(seconds) >= s) || ['second', 1];

  const el = createEl('relative-time', 'prm-relative-time', relativeFormat.format(Math.round(seconds / size), unit));
  el.setAttribute('datetime', iso);
  el.title = date.toLocaleString();
  return el;
}

function reviewerAvatar(reviewer) {
  const label = `${reviewer.login} — ${REVIEW_STATE_LABELS[reviewer.state] || reviewer.state}`;
  const link = createEl('a', `prm-reviewer prm-state-${reviewer.state.toLowerCase()}`);
  link.href = reviewer.url;
  link.title = label;
  link.setAttribute('aria-label', label);

  const img = createEl('img', 'prm-avatar');
  img.src = `${reviewer.avatarUrl}${reviewer.avatarUrl.includes('?') ? '&' : '?'}s=40`;
  img.alt = '';
  img.width = 20;
  img.height = 20;
  if (reviewer.isTeam) img.classList.add('prm-avatar-team');

  link.append(img, createEl('span', 'prm-state-dot'));
  return link;
}

// data-prm marks every element we add; with .prm-hidden and .prm-needs-my-review it lets
// removeAll() skip pages we never touched
function createEl(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  el.dataset.prm = '';
  if (text !== undefined) el.textContent = text;
  return el;
}

// Repo comes from the first two path segments; sidebar views live under /pulls/<view>/...
function currentRepo() {
  const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pulls(?:\/|$)/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function findRows() {
  return [...document.querySelectorAll(ROW_LINK_SELECTOR)].flatMap(link => {
    const number = link.getAttribute('href')?.match(/\/pull\/(\d+)/)?.[1];
    const row = link.closest('li');
    return number && row ? [{ row, number: Number(number) }] : [];
  });
}

function freshEntry(repo, number) {
  const entry = cache.get(`${repo}#${number}`);
  return entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS ? entry : null;
}

async function fetchMissing(repo, numbers) {
  if (Date.now() - (failedAt.get(repo) ?? 0) < CACHE_TTL_MS) return;
  const missing = numbers.filter(n => !freshEntry(repo, n) && !inFlight.has(`${repo}#${n}`));
  if (missing.length === 0) return;

  missing.forEach(n => inFlight.add(`${repo}#${n}`));
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PR_LIST_DATA', repo, numbers: missing });
    if (!response?.ok) {
      failedAt.set(repo, Date.now());
      console.debug('[PR Monitor] PR list data unavailable:', response?.error);
      return;
    }
    const fetchedAt = Date.now();
    for (const n of missing) {
      cache.set(`${repo}#${n}`, { fetchedAt, pr: response.prs[n] ?? null });
    }
  } finally {
    missing.forEach(n => inFlight.delete(`${repo}#${n}`));
  }
}

function removeAll() {
  if (!document.querySelector('[data-prm], .prm-hidden, .prm-needs-my-review')) return;
  for (const { row } of findRows()) {
    Object.values(decorators).forEach(d => d.remove(row));
  }
}

async function run() {
  const repo = currentRepo();
  const enabled = Object.keys(decorators).filter(key => settings[key]);
  if (!repo || !monitoredRepos.has(repo) || enabled.length === 0) {
    removeAll();
    return;
  }

  await fetchMissing(repo, findRows().map(r => r.number));

  // Re-query after the await: React may have swapped the rows while the fetch was in flight
  for (const { row, number } of findRows()) {
    const pr = freshEntry(repo, number)?.pr;
    for (const [key, decorator] of Object.entries(decorators)) {
      if (settings[key] && pr) decorator.apply(row, pr);
      else if (!settings[key] || pr === null) decorator.remove(row);
    }
  }
}

// Debounced so a burst of React re-renders becomes one pass
function scheduleRun() {
  clearTimeout(runTimer);
  runTimer = setTimeout(() => {
    run().catch(error => {
      // The extension was reloaded or updated under this tab; this script can't talk to it anymore
      if (String(error).includes('Extension context invalidated')) observer?.disconnect();
      else console.debug('[PR Monitor]', error);
    });
  }, 150);
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get([...PR_LIST_SETTING_KEYS, 'repos']);
  settings = stored;
  monitoredRepos = new Set((stored.repos || []).flatMap(r => (r.fullName ? [r.fullName.toLowerCase()] : [])));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if ([...PR_LIST_SETTING_KEYS, 'repos'].some(key => key in changes)) {
    loadSettings().then(scheduleRun);
  }
});

// GitHub paginates, filters, and moves between repo tabs client-side, so the manifest injects this
// on all of github.com and each pass re-checks the URL.
// Observes <html>, not <body>: Turbo navigations replace <body> wholesale
observer = new MutationObserver(scheduleRun);
observer.observe(document.documentElement, { childList: true, subtree: true });

loadSettings().then(scheduleRun);
