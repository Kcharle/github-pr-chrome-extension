const GITHUB_API = 'https://api.github.com';
const ALARM_NAME = 'pr-check';

// Track seen PR IDs and activity state
let seenPRIds = new Set();
let prState = {}; // { [prId]: { commentCount, reviewState, ciStatus } }
let isInitialized = false;

// Initialize on service worker start
chrome.runtime.onInstalled.addListener(() => {
  console.log('GitHub PR Monitor installed');
  initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('GitHub PR Monitor starting up');
  initializeExtension();
});

// Handle messages from popup/options
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SETTINGS_UPDATED') {
    console.log('Settings updated, reinitializing...');
    initializeExtension();
  } else if (message.type === 'REFRESH_PRS') {
    fetchAndStorePRs().then(() => sendResponse({ success: true }));
    return true;
  } else if (message.type === 'GET_PRS') {
    chrome.storage.local.get(['prs', 'lastUpdated', 'error']).then(sendResponse);
    return true;
  } else if (message.type === 'UPDATE_BADGE_FILTER') {
    // Update badge based on filter
    updateBadgeWithFilter(message.filter);
  }
});

// Handle alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    fetchAndStorePRs();
  }
});

// Initialize extension
async function initializeExtension() {
  const settings = await chrome.storage.sync.get(['token', 'repos', 'repo', 'username', 'pollInterval']);

  const repos = settings.repos || (settings.repo ? [{ fullName: settings.repo }] : []);

  if (!settings.token || repos.length === 0) {
    console.log('Extension not configured yet');
    chrome.action.setBadgeText({ text: '?' });
    chrome.action.setBadgeBackgroundColor({ color: '#6e7681' });
    return;
  }

  // Load stored state
  const stored = await chrome.storage.local.get(['seenPRIds', 'prState']);
  if (stored.seenPRIds) {
    seenPRIds = new Set(stored.seenPRIds);
  }
  if (stored.prState) {
    prState = stored.prState;
  }

  // Set up polling alarm
  const interval = settings.pollInterval || 2;
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: interval
  });

  isInitialized = true;
  console.log(`Polling every ${interval} minutes for ${repos.length} repo(s)`);

  await fetchAndStorePRs();
}

// Fetch PRs from GitHub
async function fetchAndStorePRs() {
  const settings = await chrome.storage.sync.get([
    'token', 'repos', 'repo', 'username',
    'includeAuthored', 'notificationsEnabled',
    'notifyNewPRs', 'notifyComments', 'notifyReviews', 'notifyCIFailure'
  ]);

  const repos = settings.repos || (settings.repo ? [{ fullName: settings.repo }] : []);

  if (!settings.token || repos.length === 0 || !settings.username) {
    return;
  }

  try {
    // Fetch PRs from all repos
    const allPRs = [];
    for (const repo of repos) {
      const repoPRs = await fetchPRsForRepo(
        settings.token,
        repo.fullName,
        settings.username,
        settings.includeAuthored !== false
      );
      allPRs.push(...repoPRs);
    }

    // Deduplicate by PR ID
    const prMap = new Map();
    allPRs.forEach(pr => {
      if (!prMap.has(pr.id)) {
        prMap.set(pr.id, pr);
      } else {
        // Merge roles if PR appears multiple times
        const existing = prMap.get(pr.id);
        existing.isReviewer = existing.isReviewer || pr.isReviewer;
        existing.isAssignee = existing.isAssignee || pr.isAssignee;
        existing.isAuthor = existing.isAuthor || pr.isAuthor;
      }
    });
    const prs = Array.from(prMap.values());

    // Fetch activity data (reviews, CI status) for each PR
    await fetchActivityData(settings.token, prs);

    // Sort by updated time
    prs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    // Detect changes and collect notifications
    const notifications = detectChanges(prs, settings);

    // Check for closed/merged PRs (PRs that were in our list but are now gone)
    const currentPRIds = new Set(prs.map(pr => pr.id));
    for (const [prIdStr, state] of Object.entries(prState)) {
      const prId = parseInt(prIdStr);
      if (!currentPRIds.has(prId) && state.repo) {
        const repoNotify = getRepoNotificationSettings(state.repo, settings);
        if (repoNotify.status !== false) {
          console.log(`PR #${state.number} in ${state.repo}: No longer open (closed/merged)`);
          notifications.push({
            type: 'status',
            pr: {
              id: prId,
              number: state.number,
              title: state.title,
              repo: state.repo,
              repoOwner: state.repo.split('/')[0],
              repoName: state.repo.split('/')[1],
              url: state.url
            },
            status: 'closed',
            message: 'PR closed or merged'
          });
        }
      }
    }

    // Send batched notification if there are updates
    console.log(`Notification check: isInitialized=${isInitialized}, notificationsEnabled=${settings.notificationsEnabled}, notifications=${notifications.length}, seenPRIds=${seenPRIds.size}`);
    if (isInitialized && settings.notificationsEnabled !== false && notifications.length > 0 && seenPRIds.size > 0) {
      await sendBatchedNotification(notifications);
    } else if (notifications.length > 0) {
      console.log('Notifications detected but not sent:',
        !isInitialized ? 'not initialized' :
        settings.notificationsEnabled === false ? 'disabled' :
        seenPRIds.size === 0 ? 'first run' : 'unknown reason');
    }

    // Update state
    prs.forEach(pr => {
      seenPRIds.add(pr.id);
      prState[pr.id] = {
        commentCount: pr.commentCount,
        reviewState: pr.reviewState,
        ciStatus: pr.ciStatus,
        isDraft: pr.isDraft,
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url
      };
    });

    // Clean up old PR state (PRs no longer in list)
    Object.keys(prState).forEach(id => {
      if (!currentPRIds.has(parseInt(id))) {
        delete prState[id];
      }
    });

    await chrome.storage.local.set({
      seenPRIds: Array.from(seenPRIds),
      prState
    });

    // Store PRs
    await chrome.storage.local.set({
      prs,
      lastUpdated: Date.now(),
      error: null
    });

    // Update badge (respecting current filter)
    updateBadgeWithCurrentFilter(prs);

    console.log(`Found ${prs.length} PRs, ${notifications.length} notifications`);

  } catch (error) {
    console.error('Failed to fetch PRs:', error);
    await chrome.storage.local.set({
      error: error.message,
      lastUpdated: Date.now()
    });
    updateBadge(-1);
  }
}

// Fetch PRs for a single repo
async function fetchPRsForRepo(token, repoFullName, username, includeAuthored) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json'
  };

  const [owner, repoName] = repoFullName.split('/');

  // Build queries
  const queries = [
    `type:pr state:open repo:${repoFullName} review-requested:${username}`,
    `type:pr state:open repo:${repoFullName} assignee:${username}`
  ];

  if (includeAuthored) {
    queries.push(`type:pr state:open repo:${repoFullName} author:${username}`);
  }

  // Fetch all queries in parallel
  const responses = await Promise.all(
    queries.map(query =>
      fetch(`${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=100`, { headers })
    )
  );

  // Check for errors
  for (const response of responses) {
    if (!response.ok) {
      throw new Error(`Failed to fetch PRs from ${repoFullName}`);
    }
  }

  const [reviewerData, assigneeData, authorData] = await Promise.all(
    responses.map(r => r.json())
  );

  // Combine and process PRs
  const allItems = [
    ...reviewerData.items,
    ...assigneeData.items,
    ...(authorData?.items || [])
  ];

  const prMap = new Map();

  for (const pr of allItems) {
    if (!prMap.has(pr.id)) {
      // Fetch PR details for draft status
      const prDetails = await fetchPRDetails(token, pr.pull_request.url);

      // Get comment count from PR details (more accurate than search result)
      const totalComments = (prDetails.comments || 0) + (prDetails.review_comments || 0);

      prMap.set(pr.id, {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        author: pr.user.login,
        authorAvatar: pr.user.avatar_url,
        isDraft: prDetails.draft || false,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        commentCount: totalComments,
        isReviewer: reviewerData.items.some(item => item.id === pr.id),
        isAssignee: assigneeData.items.some(item => item.id === pr.id),
        isAuthor: authorData?.items?.some(item => item.id === pr.id) || false,
        repo: repoFullName,
        repoOwner: owner,
        repoName: repoName,
        // These will be populated by fetchActivityData
        reviewState: 'pending',
        ciStatus: 'pending',
        reviews: [],
        headSha: prDetails.head?.sha || null,
        // Fallback: mergeable_state from PR details (clean/unstable/blocked/dirty)
        mergeableState: prDetails.mergeable_state || null
      });
    }
  }

  return Array.from(prMap.values());
}

// Fetch PR details
async function fetchPRDetails(token, prUrl) {
  try {
    const response = await fetch(prUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json'
      }
    });

    if (!response.ok) {
      console.log(`Failed to fetch PR details from ${prUrl}: ${response.status}`);
      return { draft: false };
    }

    const data = await response.json();
    console.log(`PR #${data.number} details: comments=${data.comments}, review_comments=${data.review_comments}, mergeable_state=${data.mergeable_state}, mergeable=${data.mergeable}`);
    return data;
  } catch (error) {
    console.error('Error fetching PR details:', error);
    return { draft: false };
  }
}

// Fetch activity data (reviews, CI status) for all PRs
async function fetchActivityData(token, prs) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json'
  };

  for (const pr of prs) {
    try {
      // Fetch reviews
      const reviewsResponse = await fetch(
        `${GITHUB_API}/repos/${pr.repo}/pulls/${pr.number}/reviews`,
        { headers }
      );

      if (reviewsResponse.ok) {
        const reviews = await reviewsResponse.json();
        pr.reviews = reviews;

        // Determine overall review state
        const latestReviews = {};
        reviews.forEach(review => {
          if (review.state !== 'COMMENTED' && review.state !== 'PENDING') {
            latestReviews[review.user.login] = review.state;
          }
        });

        const states = Object.values(latestReviews);
        if (states.includes('CHANGES_REQUESTED')) {
          pr.reviewState = 'changes_requested';
        } else if (states.includes('APPROVED')) {
          pr.reviewState = 'approved';
        } else {
          pr.reviewState = 'pending';
        }

        pr.reviewCount = states.length;
        pr.approvalCount = states.filter(s => s === 'APPROVED').length;
      }

      // Fetch CI status if we have a head SHA
      // GitHub has two CI systems: Check Runs (newer) and Commit Statuses (older)
      // We need to check both for complete coverage
      if (pr.headSha) {
        let checkRunsStatus = null;
        let commitStatus = null;
        let totalChecks = 0;
        let passedChecks = 0;

        // Fetch Workflow Runs (GitHub Actions) - uses Workflows permission
        try {
          const workflowResponse = await fetch(
            `${GITHUB_API}/repos/${pr.repo}/actions/runs?head_sha=${pr.headSha}`,
            { headers }
          );

          if (workflowResponse.ok) {
            const workflowData = await workflowResponse.json();
            const workflowRuns = workflowData.workflow_runs || [];
            console.log(`PR #${pr.number} workflow-runs:`, workflowRuns.length, workflowRuns.map(r => ({ name: r.name, status: r.status, conclusion: r.conclusion })));

            totalChecks += workflowRuns.length;
            passedChecks += workflowRuns.filter(r => r.conclusion === 'success').length;

            if (workflowRuns.length > 0) {
              const hasPending = workflowRuns.some(r =>
                r.status === 'in_progress' ||
                r.status === 'queued' ||
                r.status === 'pending' ||
                r.status === 'waiting'
              );

              const completedRuns = workflowRuns.filter(r => r.status === 'completed');
              const hasFailure = completedRuns.some(r =>
                r.conclusion === 'failure' ||
                r.conclusion === 'timed_out' ||
                r.conclusion === 'action_required'
              );
              const allSuccess = completedRuns.length > 0 && completedRuns.every(r =>
                r.conclusion === 'success' ||
                r.conclusion === 'skipped' ||
                r.conclusion === 'neutral'
              );

              if (hasFailure) {
                checkRunsStatus = 'failure';
              } else if (hasPending) {
                checkRunsStatus = 'pending';
              } else if (allSuccess) {
                checkRunsStatus = 'success';
              } else if (completedRuns.length === workflowRuns.length) {
                // All completed but with other conclusions (cancelled, etc)
                checkRunsStatus = 'success';
              } else {
                checkRunsStatus = 'pending';
              }
            }
          } else {
            console.log(`PR #${pr.number} workflow-runs failed:`, workflowResponse.status);
          }
        } catch (e) {
          console.error(`PR #${pr.number} workflow-runs error:`, e);
        }

        // Fetch Commit Status (older API - Jenkins, external CI, etc.)
        try {
          const statusResponse = await fetch(
            `${GITHUB_API}/repos/${pr.repo}/commits/${pr.headSha}/status`,
            { headers }
          );

          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            const statuses = statusData.statuses || [];
            console.log(`PR #${pr.number} commit-status:`, statusData.state, statuses.length);

            totalChecks += statuses.length;
            passedChecks += statuses.filter(s => s.state === 'success').length;

            if (statuses.length > 0) {
              // Use GitHub's combined state which handles deduplication
              commitStatus = statusData.state; // 'success', 'failure', 'pending', 'error'
              if (commitStatus === 'error') {
                commitStatus = 'failure';
              }
            }
          } else {
            console.log(`PR #${pr.number} commit-status failed:`, statusResponse.status);
          }
        } catch (e) {
          console.error(`PR #${pr.number} commit-status error:`, e);
        }

        // Combine both statuses
        console.log(`PR #${pr.number} combined: workflowRuns=${checkRunsStatus}, commitStatus=${commitStatus}, mergeableState=${pr.mergeableState}`);

        if (checkRunsStatus === 'failure' || commitStatus === 'failure') {
          pr.ciStatus = 'failure';
        } else if (checkRunsStatus === 'success' || commitStatus === 'success') {
          pr.ciStatus = 'success';
        } else if (checkRunsStatus === 'pending' || commitStatus === 'pending') {
          pr.ciStatus = 'pending';
        } else if (checkRunsStatus === null && commitStatus === null) {
          // Fallback to mergeable_state from PR details
          // clean = all checks passed, unstable = checks failed, blocked = waiting
          if (pr.mergeableState === 'clean') {
            pr.ciStatus = 'success';
          } else if (pr.mergeableState === 'unstable') {
            pr.ciStatus = 'failure';
          } else if (pr.mergeableState === 'blocked') {
            pr.ciStatus = 'pending';
          } else if (pr.mergeableState) {
            // dirty, unknown, draft, etc. - show as none
            pr.ciStatus = 'none';
          } else {
            pr.ciStatus = 'none';
          }
        } else {
          pr.ciStatus = 'none';
        }

        pr.ciChecks = totalChecks;
        pr.ciPassed = passedChecks;
        console.log(`PR #${pr.number} final ciStatus:`, pr.ciStatus);
      }
    } catch (error) {
      console.error(`Failed to fetch activity for PR #${pr.number}:`, error);
    }
  }
}

// Get notification settings for a specific repo
function getRepoNotificationSettings(repoFullName, settings) {
  const repos = settings.repos || [];
  const repo = repos.find(r => r.fullName === repoFullName);

  if (repo && repo.notifications) {
    return repo.notifications;
  }

  // Fall back to default settings
  return {
    newPRs: true,
    comments: true,
    reviews: true,
    ciFailure: true,
    ciSuccess: true,
    readyToMerge: true,
    status: true
  };
}

// Detect changes and generate notifications
function detectChanges(prs, settings) {
  const notifications = [];

  for (const pr of prs) {
    const oldState = prState[pr.id];
    const isNew = !seenPRIds.has(pr.id);

    // Get per-repo notification settings
    const repoNotify = getRepoNotificationSettings(pr.repo, settings);

    // New PR
    if (isNew && repoNotify.newPRs) {
      notifications.push({
        type: 'new_pr',
        pr,
        message: `New PR: ${pr.title}`
      });
      continue; // Don't check for other changes on new PRs
    }

    // If we don't have old state, we can't detect changes - skip but don't treat as new
    if (!oldState) {
      console.log(`No old state for PR #${pr.number}, skipping change detection`);
      continue;
    }

    // New comments - ensure we compare numbers
    const oldComments = oldState.commentCount || 0;
    const newComments = pr.commentCount || 0;
    console.log(`PR #${pr.number} comment check: old=${oldComments}, new=${newComments}, repoNotify.comments=${repoNotify.comments}`);
    if (repoNotify.comments && newComments > oldComments) {
      const commentDiff = newComments - oldComments;
      console.log(`PR #${pr.number}: ${commentDiff} new comment(s) detected (${oldComments} → ${newComments})`);
      notifications.push({
        type: 'comment',
        pr,
        count: commentDiff,
        message: `${commentDiff} new comment${commentDiff > 1 ? 's' : ''}`
      });
    }

    // Review state changed
    if (repoNotify.reviews &&
        oldState.reviewState &&
        pr.reviewState !== oldState.reviewState) {
      if (pr.reviewState === 'approved') {
        console.log(`PR #${pr.number}: Review approved`);
        notifications.push({
          type: 'review',
          pr,
          state: 'approved',
          message: 'PR approved'
        });
      } else if (pr.reviewState === 'changes_requested') {
        console.log(`PR #${pr.number}: Changes requested`);
        notifications.push({
          type: 'review',
          pr,
          state: 'changes_requested',
          message: 'Changes requested'
        });
      }
    }

    // CI failure
    if (repoNotify.ciFailure &&
        pr.ciStatus === 'failure' &&
        oldState.ciStatus !== 'failure') {
      console.log(`PR #${pr.number}: CI failed`);
      notifications.push({
        type: 'ci_failure',
        pr,
        message: 'CI failed'
      });
    }

    // CI success
    if (repoNotify.ciSuccess !== false &&
        pr.ciStatus === 'success' &&
        oldState.ciStatus !== 'success' &&
        oldState.ciStatus !== undefined) {
      console.log(`PR #${pr.number}: CI passed`);
      notifications.push({
        type: 'ci_success',
        pr,
        message: 'CI passed'
      });
    }

    // Ready to merge (CI passed AND approved)
    if (repoNotify.readyToMerge !== false &&
        pr.ciStatus === 'success' &&
        pr.reviewState === 'approved' &&
        !pr.isDraft) {
      // Check if this is newly ready (either CI just passed or review just approved)
      const wasReady = oldState.ciStatus === 'success' &&
                       oldState.reviewState === 'approved' &&
                       oldState.isDraft === false;
      if (!wasReady && oldState.ciStatus !== undefined) {
        console.log(`PR #${pr.number}: Ready to merge`);
        notifications.push({
          type: 'ready_to_merge',
          pr,
          message: 'Ready to merge'
        });
      }
    }

    // Status changes (draft <-> ready)
    if (repoNotify.status !== false && oldState.isDraft !== undefined) {
      if (oldState.isDraft && !pr.isDraft) {
        // Draft -> Ready for review
        console.log(`PR #${pr.number}: Now ready for review`);
        notifications.push({
          type: 'status',
          pr,
          status: 'ready',
          message: 'PR ready for review'
        });
      } else if (!oldState.isDraft && pr.isDraft) {
        // Ready -> Draft (converted back to draft)
        console.log(`PR #${pr.number}: Converted to draft`);
        notifications.push({
          type: 'status',
          pr,
          status: 'draft',
          message: 'PR converted to draft'
        });
      }
    }
  }

  console.log(`Detected ${notifications.length} notification(s)`);
  return notifications;
}

// Store last notification data for click handling
let lastNotificationData = null;

// Send a single batched notification
async function sendBatchedNotification(notifications) {
  if (notifications.length === 0) return;

  // Count by type
  const counts = {
    new_pr: 0,
    comment: 0,
    review: 0,
    ci_failure: 0,
    status: 0
  };

  let totalComments = 0;

  notifications.forEach(n => {
    counts[n.type]++;
    if (n.type === 'comment') {
      totalComments += n.count;
    }
  });

  // Build notification message
  const parts = [];
  if (counts.new_pr > 0) parts.push(`${counts.new_pr} new PR${counts.new_pr > 1 ? 's' : ''}`);
  if (totalComments > 0) parts.push(`${totalComments} comment${totalComments > 1 ? 's' : ''}`);
  if (counts.review > 0) parts.push(`${counts.review} review${counts.review > 1 ? 's' : ''}`);
  if (counts.ci_failure > 0) parts.push(`${counts.ci_failure} CI failure${counts.ci_failure > 1 ? 's' : ''}`);
  if (counts.ci_success > 0) parts.push(`${counts.ci_success} CI passed`);
  if (counts.ready_to_merge > 0) parts.push(`${counts.ready_to_merge} ready to merge`);
  if (counts.status > 0) parts.push(`${counts.status} status change${counts.status > 1 ? 's' : ''}`);

  // Get unique PRs affected
  const affectedPRs = [...new Map(notifications.map(n => [n.pr.id, n.pr])).values()];

  // Store for click handling
  lastNotificationData = {
    notifications,
    affectedPRs,
    singlePR: affectedPRs.length === 1 ? affectedPRs[0] : null
  };

  // Store highlighted PRs for popup display
  const highlightedPRs = {};
  notifications.forEach(n => {
    if (!highlightedPRs[n.pr.id]) {
      highlightedPRs[n.pr.id] = [];
    }
    highlightedPRs[n.pr.id].push(n.type);
  });
  await chrome.storage.local.set({ highlightedPRs });

  const totalUpdates = notifications.length;

  let title, message;

  if (affectedPRs.length === 1) {
    // Single PR - show detailed event info
    const pr = affectedPRs[0];
    const n = notifications[0];

    title = `${pr.repoOwner}/${pr.repoName}#${pr.number}`;

    // Build detailed message based on event type
    switch (n.type) {
      case 'new_pr':
        message = `New PR by @${pr.author}: ${pr.title}`;
        break;
      case 'comment':
        message = `${n.count} new comment${n.count > 1 ? 's' : ''} on "${pr.title}"`;
        break;
      case 'review':
        if (n.state === 'approved') {
          message = `✓ PR approved: ${pr.title}`;
        } else {
          message = `⚠ Changes requested: ${pr.title}`;
        }
        break;
      case 'ci_failure':
        message = `✗ CI failed: ${pr.title}`;
        break;
      case 'ci_success':
        message = `✓ CI passed: ${pr.title}`;
        break;
      case 'ready_to_merge':
        message = `🚀 Ready to merge: ${pr.title}`;
        break;
      case 'status':
        if (n.status === 'ready') {
          message = `▶ Ready for review: ${pr.title}`;
        } else if (n.status === 'draft') {
          message = `◼ Converted to draft: ${pr.title}`;
        } else if (n.status === 'closed') {
          message = `✓ Closed/Merged: ${pr.title}`;
        } else {
          message = `Status changed: ${pr.title}`;
        }
        break;
      default:
        message = pr.title;
    }
  } else {
    // Multiple PRs
    title = `${totalUpdates} PR update${totalUpdates > 1 ? 's' : ''}`;
    message = parts.join(' • ');
  }

  console.log(`Sending notification: "${title}" - "${message}"`);

  try {
    const notificationId = await chrome.notifications.create('pr-updates', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 2
    });
    console.log(`Notification created with ID: ${notificationId}`);
  } catch (error) {
    console.error('Failed to create notification:', error);
  }
}

// Update extension badge
async function updateBadge(count) {
  if (count < 0) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f85149' });
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  } else if (count === 0) {
    await chrome.action.setBadgeText({ text: '' });
  } else {
    await chrome.action.setBadgeText({ text: count.toString() });
    await chrome.action.setBadgeBackgroundColor({ color: '#cf222e' });
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
}

// Update badge with filter applied
async function updateBadgeWithFilter(filter) {
  const { prs } = await chrome.storage.local.get('prs');
  if (!prs || !Array.isArray(prs)) {
    updateBadge(0);
    return;
  }

  let filteredPRs = prs;
  if (filter === 'mine') {
    filteredPRs = prs.filter(pr => pr.isAuthor);
  } else if (filter === 'others') {
    filteredPRs = prs.filter(pr => !pr.isAuthor);
  }

  updateBadge(filteredPRs.length);
}

// Update badge respecting current filter
async function updateBadgeWithCurrentFilter(prs) {
  const { prFilter } = await chrome.storage.local.get('prFilter');
  const filter = prFilter || 'all';

  let filteredPRs = prs;
  if (filter === 'mine') {
    filteredPRs = prs.filter(pr => pr.isAuthor);
  } else if (filter === 'others') {
    filteredPRs = prs.filter(pr => !pr.isAuthor);
  }

  updateBadge(filteredPRs.length);
}

// Handle notification click
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId === 'pr-updates' && lastNotificationData) {
    if (lastNotificationData.singlePR) {
      // Single PR - open it directly
      await chrome.tabs.create({ url: lastNotificationData.singlePR.url });
      // Clear highlights since user is going directly to PR
      await chrome.storage.local.remove('highlightedPRs');
    } else {
      // Multiple PRs - open popup in a new tab
      const popupUrl = chrome.runtime.getURL('popup/popup.html?from=notification');
      await chrome.tabs.create({ url: popupUrl });
    }
  }
  chrome.notifications.clear(notificationId);
});

// Initialize when service worker loads
initializeExtension();
