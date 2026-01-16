const GITHUB_API = 'https://api.github.com';

// DOM Elements
const tokenInput = document.getElementById('token');
const validateTokenBtn = document.getElementById('validate-token');
const tokenStatus = document.getElementById('token-status');
const ownerSelect = document.getElementById('owner-select');
const repoSelect = document.getElementById('repo-select');
const repoStatus = document.getElementById('repo-status');
const selectedReposEl = document.getElementById('selected-repos');
const addRepoBtn = document.getElementById('add-repo-btn');
const addRepoForm = document.getElementById('add-repo-form');
const confirmAddRepoBtn = document.getElementById('confirm-add-repo');
const cancelAddRepoBtn = document.getElementById('cancel-add-repo');
const notificationsEnabled = document.getElementById('notifications-enabled');
const pollInterval = document.getElementById('poll-interval');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');
const disconnectBtn = document.getElementById('disconnect-btn');
const authenticatedSections = document.getElementById('authenticated-sections');

// Add repo form notification checkboxes
const addNotifyPRs = document.getElementById('add-notify-prs');
const addNotifyComments = document.getElementById('add-notify-comments');
const addNotifyReviews = document.getElementById('add-notify-reviews');
const addNotifyCIFailure = document.getElementById('add-notify-ci-failure');
const addNotifyCISuccess = document.getElementById('add-notify-ci-success');
const addNotifyReady = document.getElementById('add-notify-ready');
const addNotifyStatus = document.getElementById('add-notify-status');

let currentUser = null;
let owners = [];
let repos = {};
// selectedRepos includes notification settings per repo
let selectedRepos = [];

// Get notification settings from add-repo form
function getAddRepoNotifications() {
  return {
    newPRs: addNotifyPRs.checked,
    comments: addNotifyComments.checked,
    reviews: addNotifyReviews.checked,
    ciFailure: addNotifyCIFailure.checked,
    ciSuccess: addNotifyCISuccess.checked,
    readyToMerge: addNotifyReady.checked,
    status: addNotifyStatus.checked
  };
}

// Reset add-repo form notifications to defaults (all checked)
function resetAddRepoNotifications() {
  addNotifyPRs.checked = true;
  addNotifyComments.checked = true;
  addNotifyReviews.checked = true;
  addNotifyCIFailure.checked = true;
  addNotifyCISuccess.checked = true;
  addNotifyReady.checked = true;
  addNotifyStatus.checked = true;
}

// Validate token
validateTokenBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    showStatus(tokenStatus, 'Please enter a token', 'error');
    return;
  }

  // Clear any stale status messages
  hideStatus(saveStatus);
  showStatus(tokenStatus, '<span class="loading-spinner"></span>Validating token...', 'loading');

  try {
    const userResponse = await fetch(`${GITHUB_API}/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json'
      }
    });

    if (!userResponse.ok) {
      throw new Error('Invalid token');
    }

    currentUser = await userResponse.json();
    showStatus(tokenStatus, `✓ Authenticated as @${currentUser.login}`, 'success');
    disconnectBtn.classList.remove('hidden');
    authenticatedSections.classList.remove('hidden');

    // Auto-save the token and username
    await chrome.storage.sync.set({
      token,
      username: currentUser.login
    });

    // Close instructions accordion on successful auth
    const instructionsToggle = document.getElementById('instructions-toggle');
    if (instructionsToggle) {
      instructionsToggle.checked = false;
    }

    await loadAllRepos(token);

  } catch (error) {
    showStatus(tokenStatus, `✗ ${error.message}`, 'error');
    ownerSelect.disabled = true;
    repoSelect.disabled = true;
  }
});

// Load all accessible repos
async function loadAllRepos(token) {
  showStatus(repoStatus, '<span class="loading-spinner"></span>Loading repositories...', 'loading');

  try {
    let allRepos = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const response = await fetch(
        `${GITHUB_API}/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json'
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch repositories');
      }

      const pageRepos = await response.json();
      if (pageRepos.length === 0) break;

      allRepos = allRepos.concat(pageRepos);
      if (pageRepos.length < perPage) break;
      page++;
    }

    const ownerMap = new Map();
    allRepos.forEach(repo => {
      const ownerLogin = repo.owner.login;
      if (!ownerMap.has(ownerLogin)) {
        ownerMap.set(ownerLogin, {
          login: ownerLogin,
          type: repo.owner.type.toLowerCase(),
          repos: []
        });
      }
      ownerMap.get(ownerLogin).repos.push(repo);
    });

    owners = Array.from(ownerMap.values());

    owners.sort((a, b) => {
      if (a.login === currentUser.login) return -1;
      if (b.login === currentUser.login) return 1;
      return a.login.localeCompare(b.login);
    });

    owners.forEach(owner => {
      repos[owner.login] = owner.repos;
    });

    ownerSelect.innerHTML = '<option value="">-- Select owner --</option>';
    owners.forEach(owner => {
      const option = document.createElement('option');
      option.value = owner.login;
      const label = owner.login === currentUser.login
        ? `${owner.login} (you)`
        : owner.type === 'organization'
          ? `${owner.login} (org)`
          : owner.login;
      option.textContent = `${label} (${owner.repos.length} repos)`;
      ownerSelect.appendChild(option);
    });

    ownerSelect.disabled = false;
    hideStatus(repoStatus);

  } catch (error) {
    showStatus(repoStatus, `✗ Failed to load repositories: ${error.message}`, 'error');
  }
}

// Load repos when owner changes
ownerSelect.addEventListener('change', async () => {
  const owner = ownerSelect.value;

  if (!owner) {
    repoSelect.innerHTML = '<option value="">-- Select owner first --</option>';
    repoSelect.disabled = true;
    confirmAddRepoBtn.disabled = true;
    return;
  }

  const ownerRepos = repos[owner] || [];
  const availableRepos = ownerRepos.filter(
    repo => !selectedRepos.some(sr => sr.fullName === repo.full_name)
  );

  repoSelect.innerHTML = '<option value="">-- Select repository --</option>';
  availableRepos
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .forEach(repo => {
      const option = document.createElement('option');
      option.value = repo.full_name;
      option.dataset.private = repo.private;
      option.textContent = repo.name + (repo.private ? ' 🔒' : '');
      repoSelect.appendChild(option);
    });

  repoSelect.disabled = false;
  confirmAddRepoBtn.disabled = true;
});

repoSelect.addEventListener('change', () => {
  confirmAddRepoBtn.disabled = !repoSelect.value;
});

addRepoBtn.addEventListener('click', () => {
  if (owners.length === 0) {
    showStatus(repoStatus, 'Please validate your token first', 'error');
    return;
  }
  addRepoForm.style.display = 'block';
  addRepoBtn.style.display = 'none';
  ownerSelect.value = '';
  repoSelect.innerHTML = '<option value="">-- Select owner first --</option>';
  repoSelect.disabled = true;
  confirmAddRepoBtn.disabled = true;
});

cancelAddRepoBtn.addEventListener('click', () => {
  addRepoForm.style.display = 'none';
  addRepoBtn.style.display = 'flex';
  resetAddRepoNotifications();
});

confirmAddRepoBtn.addEventListener('click', () => {
  const fullName = repoSelect.value;
  if (!fullName) return;

  const [owner, name] = fullName.split('/');
  const selectedOption = repoSelect.options[repoSelect.selectedIndex];
  const isPrivate = selectedOption.dataset.private === 'true';

  // Add repo with notification settings from form
  selectedRepos.push({
    fullName,
    owner,
    name,
    isPrivate,
    notifications: getAddRepoNotifications()
  });

  renderSelectedRepos();
  addRepoForm.style.display = 'none';
  addRepoBtn.style.display = 'flex';
  resetAddRepoNotifications();
});

function removeRepo(fullName) {
  const repoName = fullName.split('/')[1] || fullName;
  if (!confirm(`Remove "${repoName}" from monitoring?\n\nYou'll stop receiving notifications for this repository.`)) {
    return;
  }
  selectedRepos = selectedRepos.filter(r => r.fullName !== fullName);
  renderSelectedRepos();
}

function updateRepoNotification(fullName, type, checked) {
  const repo = selectedRepos.find(r => r.fullName === fullName);
  if (repo && repo.notifications) {
    repo.notifications[type] = checked;
  }
}

// Set up event delegation for repo settings buttons
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.repo-settings-btn');
  if (btn) {
    const safeId = btn.dataset.repoid;
    const el = document.getElementById(`repo-settings-${safeId}`);
    if (el) {
      el.classList.toggle('hidden');
      btn.classList.toggle('btn-active');
    }
  }
});

// Set up event delegation for notification toggles
document.addEventListener('change', (e) => {
  if (e.target.classList.contains('repo-notify-toggle')) {
    const fullName = e.target.dataset.repo;
    const type = e.target.dataset.type;
    updateRepoNotification(fullName, type, e.target.checked);
  }
});

function renderSelectedRepos() {
  if (selectedRepos.length === 0) {
    selectedReposEl.innerHTML = `
      <div class="text-center py-6 px-4 text-secondary text-sm border-2 border-dashed border-color rounded-lg">
        No repositories selected. Click "Add Repository" to get started.
      </div>
    `;
    return;
  }

  let html = '';
  selectedRepos.forEach(repo => {
    // Ensure notifications object exists with defaults
    if (!repo.notifications) {
      repo.notifications = {
        newPRs: true, comments: true, reviews: true,
        ciFailure: true, ciSuccess: true, readyToMerge: true, status: true
      };
    }

    const safeId = repo.fullName.replace('/', '-');
    const n = repo.notifications;

    html += `
      <div class="bg-tertiary rounded-lg p-3 mb-2 last:mb-0">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <svg class="text-secondary shrink-0" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z"/>
            </svg>
            <span class="font-mono text-sm truncate">
              <span class="text-secondary">${repo.owner}/</span><span class="font-medium">${repo.name}</span>
            </span>
            ${repo.isPrivate ? '<span class="badge badge-warning ml-1 text-[10px]">PRIVATE</span>' : ''}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button type="button" class="btn text-xs py-1.5 px-3 flex items-center gap-1.5 repo-settings-btn" data-repoid="${safeId}" title="Configure notification alerts for this repo">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
              <span>Alerts</span>
            </button>
            <button type="button" class="btn btn-delete text-xs py-1.5 px-2" data-remove="${repo.fullName}" title="Remove this repository">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="repo-notifications hidden mt-3 pt-3 border-t border-color" id="repo-settings-${safeId}">
          <div class="text-[10px] uppercase tracking-wider mb-2 text-muted font-medium">Notifications for this repo</div>
          <div class="flex flex-wrap gap-1.5">
            <label class="notification-pill" title="Notify when a new PR is opened">
              <input type="checkbox" class="repo-notify-toggle" data-repo="${repo.fullName}" data-type="newPRs" ${n.newPRs ? 'checked' : ''}>
              <span>PRs</span>
            </label>
            <label class="notification-pill" title="Notify when new comments are added">
              <input type="checkbox" class="repo-notify-toggle" data-repo="${repo.fullName}" data-type="comments" ${n.comments ? 'checked' : ''}>
              <span>Comments</span>
            </label>
            <label class="notification-pill" title="Notify when a review is submitted">
              <input type="checkbox" class="repo-notify-toggle" data-repo="${repo.fullName}" data-type="reviews" ${n.reviews ? 'checked' : ''}>
              <span>Reviews</span>
            </label>
            <label class="notification-pill" title="Notify when CI/Actions checks fail">
              <input type="checkbox" class="repo-notify-toggle" data-repo="${repo.fullName}" data-type="ciFailure" ${n.ciFailure ? 'checked' : ''}>
              <span>CI Fail</span>
            </label>
            <label class="notification-pill" title="Notify when all CI/Actions checks pass">
              <input type="checkbox" class="repo-notify-toggle" data-repo="${repo.fullName}" data-type="ciSuccess" ${n.ciSuccess !== false ? 'checked' : ''}>
              <span>CI Pass</span>
            </label>
            <label class="notification-pill" title="Notify when PR is approved and CI passes">
              <input type="checkbox" class="repo-notify-toggle" data-repo="${repo.fullName}" data-type="readyToMerge" ${n.readyToMerge !== false ? 'checked' : ''}>
              <span>Mergeable</span>
            </label>
            <label class="notification-pill" title="Notify when PR status changes (draft/ready/closed)">
              <input type="checkbox" class="repo-notify-toggle" data-repo="${repo.fullName}" data-type="status" ${n.status !== false ? 'checked' : ''}>
              <span>Status</span>
            </label>
          </div>
        </div>
      </div>
    `;
  });

  selectedReposEl.innerHTML = html;
}

// Save settings
saveBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const interval = parseInt(pollInterval.value, 10);

  if (!token) {
    showStatus(saveStatus, '✗ Please enter a GitHub token', 'error');
    return;
  }

  if (selectedRepos.length === 0) {
    showStatus(saveStatus, '✗ Please add at least one repository', 'error');
    return;
  }

  const settings = {
    token,
    repos: selectedRepos,
    username: currentUser?.login || '',
    includeAuthored: true, // Always include authored PRs (filter in popup)
    notificationsEnabled: notificationsEnabled.checked,
    pollInterval: interval
  };

  try {
    await chrome.storage.sync.set(settings);
    showStatus(saveStatus, '✓ Settings saved! Loading PRs...', 'success');

    // Notify background to update and immediately fetch PRs
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });

    // Trigger immediate PR refresh
    const result = await chrome.runtime.sendMessage({ type: 'REFRESH_PRS' });
    if (result?.success) {
      showStatus(saveStatus, '✓ Settings saved and PRs loaded!', 'success');
    }
  } catch (error) {
    showStatus(saveStatus, `✗ Failed to save: ${error.message}`, 'error');
  }
});

// Load saved settings
async function loadSettings() {
  try {
    const settings = await chrome.storage.sync.get([
      'token', 'repos', 'repo', 'username',
      'notificationsEnabled', 'pollInterval'
    ]);

    // Expand instructions if no token is configured
    const instructionsToggle = document.getElementById('instructions-toggle');
    if (!settings.token && instructionsToggle) {
      instructionsToggle.checked = true;
    }

    if (settings.token) {
      tokenInput.value = settings.token;
      disconnectBtn.classList.remove('hidden');
      authenticatedSections.classList.remove('hidden');
    } else {
      disconnectBtn.classList.add('hidden');
      authenticatedSections.classList.add('hidden');
    }

    if (settings.notificationsEnabled !== undefined) {
      notificationsEnabled.checked = settings.notificationsEnabled;
    }

    if (settings.pollInterval) {
      pollInterval.value = settings.pollInterval.toString();
    }

    // Load repos with their notification settings
    if (settings.repos && Array.isArray(settings.repos)) {
      selectedRepos = settings.repos.map(repo => ({
        ...repo,
        notifications: repo.notifications || {
          newPRs: true,
          comments: true,
          reviews: true,
          ciFailure: true,
          ciSuccess: true,
          readyToMerge: true,
          status: true
        }
      }));
    } else if (settings.repo) {
      const [owner, name] = settings.repo.split('/');
      selectedRepos = [{
        fullName: settings.repo,
        owner,
        name,
        isPrivate: false,
        notifications: { newPRs: true, comments: true, reviews: true, ciFailure: true, ciSuccess: true, readyToMerge: true, status: true }
      }];
    }

    renderSelectedRepos();

    if (settings.token) {
      validateTokenBtn.click();
    }

  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

function showStatus(element, message, type) {
  const styles = {
    success: 'status status-success',
    error: 'status status-error',
    loading: 'status status-warning'
  };
  element.innerHTML = message;
  element.className = styles[type] || 'status';
  element.style.display = 'flex';
}

function hideStatus(element) {
  element.className = '';
  element.innerHTML = '';
  element.style.display = 'none';
}

// Set up event delegation for remove buttons
document.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) {
    const fullName = removeBtn.dataset.remove;
    removeRepo(fullName);
  }
});

// Disconnect - clear all data
disconnectBtn.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to disconnect? This will remove your token and all settings.')) {
    return;
  }

  try {
    // Clear all sync storage
    await chrome.storage.sync.clear();

    // Clear all local storage (PR cache, highlights, etc.)
    await chrome.storage.local.clear();

    // Reset UI
    tokenInput.value = '';
    selectedRepos = [];
    currentUser = null;
    owners = [];
    repos = {};

    ownerSelect.innerHTML = '<option value="">-- Select owner --</option>';
    ownerSelect.disabled = true;
    repoSelect.innerHTML = '<option value="">-- Select owner first --</option>';
    repoSelect.disabled = true;

    renderSelectedRepos();

    // Hide disconnect button and authenticated sections
    disconnectBtn.classList.add('hidden');
    authenticatedSections.classList.add('hidden');

    // Expand instructions for new setup
    const instructionsToggle = document.getElementById('instructions-toggle');
    if (instructionsToggle) {
      instructionsToggle.checked = true;
    }

    // Reset to defaults
    notificationsEnabled.checked = true;
    pollInterval.value = '2';
    resetAddRepoNotifications();

    hideStatus(tokenStatus);
    hideStatus(repoStatus);

    showStatus(saveStatus, '✓ Disconnected successfully. All data cleared.', 'success');

    // Notify background script
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });

  } catch (error) {
    showStatus(saveStatus, `✗ Failed to disconnect: ${error.message}`, 'error');
  }
});

// Initialize
loadSettings();
