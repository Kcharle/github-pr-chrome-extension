// DOM Elements
const loadingEl = document.getElementById('loading');
const notConfiguredEl = document.getElementById('not-configured');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');
const prListEl = document.getElementById('pr-list');
const lastUpdatedEl = document.getElementById('last-updated');
const errorMessageEl = document.getElementById('error-message');
const nextRefreshEl = document.getElementById('next-refresh');
const refreshBtn = document.getElementById('refresh-btn');
const settingsBtn = document.getElementById('settings-btn');
const openSettingsBtn = document.getElementById('open-settings');
const retryBtn = document.getElementById('retry-btn');
const filterToggle = document.getElementById('filter-toggle');

// Current filter and all PRs cache
let currentFilter = 'all';
let allPRs = [];

// Load saved filter preference
async function loadFilterPreference() {
  const { prFilter } = await chrome.storage.local.get('prFilter');
  if (prFilter && ['all', 'mine', 'others'].includes(prFilter)) {
    currentFilter = prFilter;
    // Update UI to reflect saved filter
    filterToggle.querySelectorAll('.filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === currentFilter);
    });
  }
}

// Save filter preference and update badge
async function saveFilterPreference(filter) {
  await chrome.storage.local.set({ prFilter: filter });
  // Tell background to update badge with filtered count
  chrome.runtime.sendMessage({ type: 'UPDATE_BADGE_FILTER', filter });
}

// Track highlighted PRs
let highlightedPRs = {};

// Map notification types to human-readable labels
const activityLabels = {
  'new_pr': 'New PR',
  'comment': 'New comment',
  'review': 'New review',
  'ci_failure': 'CI failed',
  'ci_success': 'CI passed',
  'ready_to_merge': 'Ready to merge',
  'status': 'Status changed',
  'approved': 'Approved',
  'changes_requested': 'Changes requested'
};

function formatActivityReason(reasons) {
  if (!reasons) return 'New activity';

  // reasons can be an array or a string
  const reasonList = Array.isArray(reasons) ? reasons : [reasons];

  const labels = reasonList.map(r => activityLabels[r] || r.replace(/_/g, ' '));

  if (labels.length === 1) {
    return labels[0];
  } else if (labels.length === 2) {
    return labels.join(' & ');
  } else {
    return `${labels.slice(0, -1).join(', ')} & ${labels.slice(-1)}`;
  }
}

// Filter PRs based on current filter
function filterPRs(prs) {
  if (currentFilter === 'all') return prs;
  if (currentFilter === 'mine') return prs.filter(pr => pr.isAuthor);
  if (currentFilter === 'others') return prs.filter(pr => !pr.isAuthor);
  return prs;
}

// Apply filter and re-render
function applyFilter() {
  const filtered = filterPRs(allPRs);

  if (filtered.length === 0 && allPRs.length > 0) {
    // Show a filtered-empty message
    prListEl.innerHTML = `
      <div class="state empty" style="display: flex; min-height: 150px;">
        <p style="opacity: 0.6; font-size: 13px;">No ${currentFilter === 'mine' ? 'authored' : 'review'} PRs</p>
      </div>
    `;
    showState('list');
  } else if (filtered.length === 0) {
    showState('empty');
  } else {
    renderPRs(filtered);
    showState('list');
  }
}

// Show a specific state, hide others
function showState(state) {
  loadingEl.style.display = 'none';
  notConfiguredEl.style.display = 'none';
  errorEl.style.display = 'none';
  emptyEl.style.display = 'none';
  prListEl.style.display = 'none';

  switch (state) {
    case 'loading':
      loadingEl.style.display = 'flex';
      break;
    case 'not-configured':
      notConfiguredEl.style.display = 'flex';
      break;
    case 'error':
      errorEl.style.display = 'flex';
      break;
    case 'empty':
      emptyEl.style.display = 'flex';
      break;
    case 'list':
      prListEl.style.display = 'block';
      break;
  }
}

// Format relative time
function formatRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Create PR card HTML
function createPRCard(pr) {
  // Determine role badge
  let roleBadge = '';
  if (pr.isAuthor) {
    roleBadge = '<span class="badge badge-author">owner</span>';
  } else {
    const roleText = pr.isReviewer && pr.isAssignee
      ? 'both'
      : pr.isReviewer
        ? 'reviewer'
        : 'assignee';
    roleBadge = `<span class="badge badge-role">${roleText}</span>`;
  }

  // Build activity indicators
  const activityItems = [];

  // CI Status
  if (pr.ciStatus && pr.ciStatus !== 'none') {
    const ciIcon = getCIIcon(pr.ciStatus);
    const ciClass = `ci-${pr.ciStatus}`;
    const ciText = pr.ciChecks ? `${pr.ciPassed || 0}/${pr.ciChecks}` : pr.ciStatus;
    activityItems.push(`
      <span class="activity-item ${ciClass}" title="CI: ${pr.ciStatus}">
        ${ciIcon}
        <span>${ciText}</span>
      </span>
    `);
  }

  // Review status
  if (pr.reviewCount !== undefined && pr.reviewCount > 0) {
    const reviewIcon = getReviewIcon(pr.reviewState);
    const reviewClass = `review-${pr.reviewState === 'changes_requested' ? 'changes' : pr.reviewState}`;
    const reviewText = pr.approvalCount !== undefined
      ? `${pr.approvalCount}/${pr.reviewCount}`
      : pr.reviewCount;
    activityItems.push(`
      <span class="activity-item ${reviewClass}" title="Reviews: ${pr.reviewState}">
        ${reviewIcon}
        <span>${reviewText}</span>
      </span>
    `);
  }

  // Comments
  if (pr.commentCount && pr.commentCount > 0) {
    activityItems.push(`
      <span class="activity-item" title="${pr.commentCount} comments">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"/>
        </svg>
        <span>${pr.commentCount}</span>
      </span>
    `);
  }

  const activityHtml = activityItems.length > 0
    ? `<div class="pr-activity">${activityItems.join('')}</div>`
    : '';

  const isHighlighted = highlightedPRs[pr.id];
  const card = document.createElement('div');
  card.className = `pr-card${isHighlighted ? ' highlighted' : ''}`;
  if (isHighlighted) {
    card.setAttribute('data-activity', formatActivityReason(highlightedPRs[pr.id]));
  }
  card.innerHTML = `
    <div class="pr-header">
      <img class="pr-avatar" src="${pr.authorAvatar}" alt="${pr.author}">
      <div class="pr-info">
        <div class="pr-title">${escapeHtml(pr.title)}</div>
        <div class="pr-meta">
          <span class="pr-author">@${pr.author}</span>
          <span class="pr-number">#${pr.number}</span>
          <div class="pr-badges">
            <span class="badge ${pr.isDraft ? 'badge-draft' : 'badge-ready'}">
              ${pr.isDraft ? 'Draft' : 'Ready'}
            </span>
            ${roleBadge}
          </div>
        </div>
        ${activityHtml}
      </div>
    </div>
  `;

  card.addEventListener('click', () => {
    chrome.tabs.create({ url: pr.url });
  });

  return card;
}

// Get CI status icon
function getCIIcon(status) {
  switch (status) {
    case 'success':
      return `<svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm3.78-9.72a.75.75 0 00-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l4.5-4.5z"/>
      </svg>`;
    case 'failure':
      return `<svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M2.343 13.657A8 8 0 1113.657 2.343 8 8 0 012.343 13.657zM6.03 4.97a.75.75 0 00-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 101.06 1.06L8 9.06l1.97 1.97a.75.75 0 101.06-1.06L9.06 8l1.97-1.97a.75.75 0 10-1.06-1.06L8 6.94 6.03 4.97z"/>
      </svg>`;
    case 'pending':
    default:
      return `<svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 4a4 4 0 100 8 4 4 0 000-8z"/>
      </svg>`;
  }
}

// Get review status icon (eyes for reviewing)
function getReviewIcon(state) {
  switch (state) {
    case 'approved':
      // Eye with checkmark
      return `<svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.824.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"/>
      </svg>`;
    case 'changes_requested':
      // Eye with dot (attention needed)
      return `<svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.824.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"/>
      </svg>`;
    default:
      // Simple eye (pending review)
      return `<svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.824.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>
      </svg>`;
  }
}

// Group PRs by organization, then by repo
function groupPRs(prs) {
  const groups = {};

  prs.forEach(pr => {
    const owner = pr.repoOwner || pr.repo?.split('/')[0] || 'unknown';
    const repoName = pr.repoName || pr.repo?.split('/')[1] || 'unknown';

    if (!groups[owner]) {
      groups[owner] = {
        name: owner,
        repos: {},
        totalPRs: 0
      };
    }

    if (!groups[owner].repos[repoName]) {
      groups[owner].repos[repoName] = {
        name: repoName,
        fullName: pr.repo,
        prs: []
      };
    }

    groups[owner].repos[repoName].prs.push(pr);
    groups[owner].totalPRs++;
  });

  return groups;
}

// Render grouped PRs
function renderPRs(prs) {
  prListEl.innerHTML = '';

  const groups = groupPRs(prs);
  const sortedOwners = Object.keys(groups).sort();

  sortedOwners.forEach(ownerName => {
    const org = groups[ownerName];

    // Create org group
    const orgGroup = document.createElement('div');
    orgGroup.className = 'org-group';

    // Org header
    const orgHeader = document.createElement('div');
    orgHeader.className = 'org-header';
    orgHeader.innerHTML = `
      <img class="org-icon" src="https://github.com/${ownerName}.png?size=40" alt="${ownerName}" onerror="this.style.display='none'">
      <span class="org-name">${ownerName}</span>
      <span class="org-count">${org.totalPRs} PR${org.totalPRs !== 1 ? 's' : ''}</span>
    `;
    orgGroup.appendChild(orgHeader);

    // Repos within org
    const sortedRepos = Object.keys(org.repos).sort();
    sortedRepos.forEach(repoName => {
      const repo = org.repos[repoName];

      const repoGroup = document.createElement('div');
      repoGroup.className = 'repo-group';

      // Repo header (clickable to collapse)
      const repoHeader = document.createElement('div');
      repoHeader.className = 'repo-header';
      repoHeader.innerHTML = `
        <svg class="repo-chevron" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
          <path d="M12.78 6.22a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 7.28a.75.75 0 011.06-1.06L8 9.94l3.72-3.72a.75.75 0 011.06 0z"/>
        </svg>
        <svg class="repo-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z"/>
        </svg>
        <span class="repo-name">${repoName}</span>
        <span class="repo-pr-count">${repo.prs.length}</span>
      `;
      repoGroup.appendChild(repoHeader);

      // PR container (collapsible)
      const prContainer = document.createElement('div');
      prContainer.className = 'repo-prs';

      // PRs within repo
      repo.prs.forEach(pr => {
        prContainer.appendChild(createPRCard(pr));
      });

      repoGroup.appendChild(prContainer);

      // Toggle collapse on header click
      repoHeader.addEventListener('click', () => {
        repoGroup.classList.toggle('collapsed');
      });

      orgGroup.appendChild(repoGroup);
    });

    prListEl.appendChild(orgGroup);
  });
}

// Load and display data
async function loadData() {
  // Check for highlighted PRs from notification
  const stored = await chrome.storage.local.get(['highlightedPRs']);
  if (stored.highlightedPRs) {
    highlightedPRs = stored.highlightedPRs;
    // Clear highlights after a delay so user can see them
    setTimeout(async () => {
      await chrome.storage.local.remove('highlightedPRs');
    }, 10000); // Clear after 10 seconds
  }

  // First check if configured
  const settings = await chrome.storage.sync.get(['token', 'repos', 'repo', 'pollInterval']);

  // Handle both new multi-repo and old single-repo format
  const repos = settings.repos || (settings.repo ? [{ fullName: settings.repo }] : []);

  if (!settings.token || repos.length === 0) {
    showState('not-configured');
    return;
  }

  const pollInterval = settings.pollInterval || 2;

  // Get PR data from background
  chrome.runtime.sendMessage({ type: 'GET_PRS' }, (response) => {
    if (!response) {
      showState('loading');
      return;
    }

    const { prs, lastUpdated, error } = response;

    // Update last updated time and next refresh
    if (lastUpdated) {
      lastUpdatedEl.textContent = `Updated ${formatRelativeTime(lastUpdated)}`;

      // Calculate next refresh time
      const nextRefresh = lastUpdated + (pollInterval * 60 * 1000);
      updateNextRefresh(nextRefresh);
    }

    if (error) {
      errorMessageEl.textContent = error;
      showState('error');
      return;
    }

    if (!prs || prs.length === 0) {
      allPRs = [];
      showState('empty');
      return;
    }

    allPRs = prs;
    applyFilter();
  });
}

// Format time as HH:MM:SS AM/PM
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Update next refresh time display
function updateNextRefresh(nextRefreshTime) {
  nextRefreshEl.textContent = `Next at ${formatTime(nextRefreshTime)}`;
}

// Refresh PRs
async function refreshPRs() {
  refreshBtn.classList.add('spinning');

  chrome.runtime.sendMessage({ type: 'REFRESH_PRS' }, () => {
    setTimeout(() => {
      refreshBtn.classList.remove('spinning');
      loadData();
    }, 500);
  });
}

// Event listeners
refreshBtn.addEventListener('click', refreshPRs);

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

openSettingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

retryBtn.addEventListener('click', () => {
  showState('loading');
  refreshPRs();
});

// Filter toggle
filterToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;

  const filter = btn.dataset.filter;
  if (filter === currentFilter) return;

  // Update active state
  filterToggle.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  currentFilter = filter;
  saveFilterPreference(filter);
  applyFilter();
});

// Initialize
loadFilterPreference().then(() => loadData());
