// Opt-in tweaks to github.com's PR list page, stored in chrome.storage.sync and shared by the
// options page, popup, and content script so the keys and labels live in one place.
const PR_LIST_SETTINGS = [
  { key: 'prListDiffStats', label: 'Line diffs', description: 'Show +additions −deletions on each PR' },
  { key: 'prListReviewers', label: 'Reviewers', description: 'Show reviewers instead of assignees and highlight PRs awaiting your review, including new commits since you commented or requested changes' },
  { key: 'prListLastComment', label: 'Last comment', description: 'Show when the latest comment or review was left' }
];

const PR_LIST_SETTING_KEYS = PR_LIST_SETTINGS.map(s => s.key);
