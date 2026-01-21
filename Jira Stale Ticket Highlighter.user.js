// ==UserScript==
// @name         Jira Stale Ticket Highlighter
// @namespace    https://github.com/wuhup/jira-userscripts
// @version      1.1.5
// @description  Highlights stale and stuck tickets on Jira boards with visual indicators
// @author       Christopher Jones
// @match        https://*.atlassian.net/*
// @homepageURL  https://github.com/wuhup/jira-userscripts
// @supportURL   https://github.com/wuhup/jira-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/wuhup/jira-userscripts/main/Jira%20Stale%20Ticket%20Highlighter.user.js
// @updateURL    https://raw.githubusercontent.com/wuhup/jira-userscripts/main/Jira%20Stale%20Ticket%20Highlighter.user.js
// @grant        none
// ==/UserScript==

/**
 * Highlights stale and stuck tickets on Jira boards with visual badges.
 * Shows "Stale" for tickets with no updates, "Stuck" for old tickets that
 * never started, and "Stuck in Status" for tickets lingering in active states.
 * Edit the CONFIG object below to match your Jira workflow status names.
 */
(function () {
    'use strict';

    console.log('[Jira Stale Highlighter] Script loaded');

    const CONFIG = {
        STALE_THRESHOLD_DAYS: 30,
        PING_PONG_MIN_AGE_DAYS: 14,
        STUCK_IN_STATUS_DAYS: 14,
        PROGRESS_STATUSES: [
            'In Progress',
            'Tech Review',
            'Merged',
            'Testing',
            'Ready for Release'
        ],
        DONE_STATUSES: [
            'Done',
            'Done (deployed to prod)',
            'Closed'
        ]
    };

    const log = (...args) => console.log('[Jira Stale Highlighter]', ...args);

    log('Script initialized with config:', CONFIG);

    // Utility: Debounce
    function debounced(fn, delay) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    // Utility: Parse Jira Key from URL or text
    function getIssueKeyFromElement(element) {
        // Business Board: The element itself might be the link
        if (element.tagName === 'A' && element.href.includes('/browse/')) {
            const match = element.href.match(/\/browse\/([A-Z]+-[0-9]+)/);
            if (match) return match[1];
        }

        // Software Board: Try to find a link inside
        const link = element.querySelector('a[href*="/browse/"]');
        if (link) {
            const match = link.href.match(/\/browse\/([A-Z]+-[0-9]+)/);
            if (match) return match[1];
        }
        // Fallback: check text content
        const textMatch = element.innerText.match(/([A-Z]+-[0-9]+)/);
        return textMatch ? textMatch[1] : null;
    }

    // Main Logic
    const processedKeys = new Set();
    const CACHE = new Map();

    // Helper: Parse Key from URL
    function getIssueKeyFromUrl(url) {
        const match = url.match(/\/browse\/([A-Z]+-[0-9]+)/);
        if (match) return match[1];

        const params = new URLSearchParams(url.split('?')[1]);
        const selected = params.get('selectedIssue');
        if (selected) return selected;

        return null;
    }

    async function processCard(cardElement) {
        const key = getIssueKeyFromElement(cardElement);
        if (!key) return;

        // If indicator already exists, skip processing to avoid flickering/loops
        if (cardElement.querySelector('.jira-stale-indicator')) {
            return;
        }

        if (CACHE.has(key)) {
            // Ensure clean slate before applying (in case of partial state)
            cardElement.style.opacity = '';
            cardElement.style.border = '';
            applyHighlights(cardElement, CACHE.get(key), 'card');
            return;
        }

        // Fetch if not cached
        fetchAndApply(key, cardElement, 'card');
    }



    async function fetchAndApply(key, element, context) {
        if (processedKeys.has(key) && !CACHE.has(key)) return; // Already fetching?
        processedKeys.add(key);
        log('Fetching data for', key, 'context:', context);

        try {
            const data = await fetchIssueData(key);
            CACHE.set(key, data);
            applyHighlights(element, data, context);
            processedKeys.delete(key); // Done processing for now
        } catch (err) {
            console.error('Error fetching data for', key, err);
            processedKeys.delete(key);
        }
    }

    async function fetchIssueData(key) {
        const url = `/rest/api/3/issue/${key}?fields=updated,created,status&expand=changelog`;
        const initialResp = await fetch(url);

        if (!initialResp.ok) {
            throw new Error(`API Error: ${initialResp.status}`);
        }

        const data = await initialResp.json();

        const now = new Date();
        const updated = new Date(data.fields.updated);
        const created = new Date(data.fields.created);
        const currentStatus = data.fields.status?.name || '';
        const currentStatusLower = currentStatus.toLowerCase();

        const daysSinceUpdate = (now - updated) / (1000 * 60 * 60 * 24);
        const daysSinceCreation = (now - created) / (1000 * 60 * 60 * 24);

        // Skip completed tickets
        const doneStatusesLower = CONFIG.DONE_STATUSES.map(s => s.toLowerCase());
        const isDone = doneStatusesLower.includes(currentStatusLower);
        if (isDone) {
            return { isStale: false, isPingPong: false, isStuckInStatus: false, isDone: true };
        }

        // STALE: No updates for X days
        const isStale = daysSinceUpdate > CONFIG.STALE_THRESHOLD_DAYS;


        // 3. PING PONG Check: Old ticket that never reached "In Progress"
        let isPingPong = false;
        let touchedProgress = false;
        const progressStatusesLower = CONFIG.PROGRESS_STATUSES.map(s => s.toLowerCase());

        if (progressStatusesLower.includes(currentStatusLower)) {
            touchedProgress = true;
        } else {
            // Check history for any progress status
            const histories = data.changelog?.histories || [];
            for (const history of histories) {
                for (const item of (history.items || [])) {
                    if (item.field === 'status') {
                        const toStr = (item.toString || '').toLowerCase();
                        if (progressStatusesLower.includes(toStr)) {
                            touchedProgress = true;
                            break;
                        }
                    }
                }
                if (touchedProgress) break;
            }
        }

        if (!touchedProgress && daysSinceCreation > CONFIG.PING_PONG_MIN_AGE_DAYS) {
            isPingPong = true;
        }


        // 4. STUCK IN STATUS Check: Ticket stuck in an active status too long
        // Find when ticket last transitioned to its current status
        let statusChangedDate = created;
        let foundStatusTransition = false;

        const histories = data.changelog?.histories || [];
        histories.sort((a, b) => new Date(b.created) - new Date(a.created));

        for (const history of histories) {
            for (const item of (history.items || [])) {
                if (item.field === 'status' && (item.toString || '').toLowerCase() === currentStatusLower) {
                    statusChangedDate = new Date(history.created);
                    foundStatusTransition = true;
                    break;
                }
            }
            if (foundStatusTransition) break;
        }

        const daysInStatus = (now - statusChangedDate) / (1000 * 60 * 60 * 24);
        let isStuckInStatus = false;

        if (progressStatusesLower.includes(currentStatusLower)) {
            if (daysInStatus > CONFIG.STUCK_IN_STATUS_DAYS) {
                isStuckInStatus = true;
            }
        }

        return { isStale, isPingPong, isStuckInStatus, daysSinceUpdate, daysSinceCreation, daysInStatus, currentStatus };
    }

    function applyHighlights(element, data, context) {
        if (context === 'detail') {
            log('applyHighlights called for detail', data);
        }

        if (data.isDone) {
            if (context === 'detail') log('Skipping detail highlight because issue is DONE');
            return;
        }

        if (context === 'card') {
            // Target Anchor for positioning
            let anchor = element;
            if (element.tagName !== 'A') {
                // Software Board: Use first child to avoid messing with root card layout (drag & drop)
                if (element.firstElementChild) {
                    anchor = element.firstElementChild;
                }
            }

            // Ensure anchor is relative so absolute indicators position correctly
            if (getComputedStyle(anchor).position === 'static') {
                anchor.style.position = 'relative';
            }

            const isTimeline = window.location.href.toLowerCase().includes('/timeline');

            // 1. STALE (Updates)
            if (data.isStale) {
                // Software default
                const indicator = document.createElement('div');
                indicator.className = 'jira-stale-indicator';
                indicator.innerText = `🕒 Stale (${Math.floor(data.daysSinceUpdate)}d)`;

                // Default styling (Software Boards - div cards)
                let css = 'position: absolute; top: -6px; left: 10px; background: #fff0f0; border: 1px solid #ccc; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #666; z-index: 20; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';

                // Business Boards (Anchor cards) - Place inside to avoid clipping/grid issues
                if (element.tagName === 'A') {
                    // Use positive top to place inside card, avoid breaking grid layout
                    css = 'position: absolute; top: 2px; left: 2px; background: #fff0f0; border: 1px solid #ccc; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #666; z-index: 1000; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                if (isTimeline) {
                    // Flow naturally after text
                    css = 'display: inline-flex; margin-left: 8px; vertical-align: middle; background: #fff0f0; border: 1px solid #ccc; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #666; z-index: 1000; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                indicator.style.cssText = css;
                anchor.appendChild(indicator);
            }

            // PING PONG: Old & not started
            if (data.isPingPong) {
                if (!isTimeline) {
                    anchor.style.border = '2px solid #ff9900';
                    anchor.style.boxSizing = 'border-box';
                }

                const ppIndicator = document.createElement('div');
                ppIndicator.className = 'jira-stale-indicator';
                ppIndicator.innerText = `🛑 Stuck (${Math.floor(data.daysSinceCreation)}d)`;

                let css = 'position: absolute; top: -6px; right: 10px; background: #fff8e1; border: 1px solid #ff9900; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #cc7a00; z-index: 20; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';

                // Business Boards
                if (element.tagName === 'A') {
                    css = 'position: absolute; top: 2px; right: 2px; background: #fff8e1; border: 1px solid #ff9900; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #cc7a00; z-index: 1000; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                if (isTimeline) {
                    // Flow naturally after text
                    css = 'display: inline-flex; margin-left: 8px; vertical-align: middle; background: #fff8e1; border: 1px solid #ff9900; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #cc7a00; z-index: 1000; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                ppIndicator.style.cssText = css;
                anchor.appendChild(ppIndicator);
            }

            // STUCK IN STATUS: Active but stuck
            if (data.isStuckInStatus) {
                const stuckIndicator = document.createElement('div');
                stuckIndicator.className = 'jira-stale-indicator';
                stuckIndicator.innerText = `⚓ Stuck: ${data.currentStatus} (${Math.floor(data.daysInStatus)}d)`;

                let css = 'position: absolute; top: -6px; right: 10px; background: #f3e5f5; border: 1px solid #7b1fa2; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #7b1fa2; z-index: 20; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';

                if (element.tagName === 'A') {
                    css = 'position: absolute; top: 2px; right: 2px; background: #f3e5f5; border: 1px solid #7b1fa2; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #7b1fa2; z-index: 1000; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                if (isTimeline) {
                    // Flow naturally after text
                    css = 'display: inline-flex; margin-left: 8px; vertical-align: middle; background: #f3e5f5; border: 1px solid #7b1fa2; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #7b1fa2; z-index: 1000; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                } else {
                    // Only apply border if NOT timeline
                    anchor.style.border = '2px solid #7b1fa2';
                    anchor.style.boxSizing = 'border-box';
                }

                stuckIndicator.style.cssText = css;
                anchor.appendChild(stuckIndicator);
            }

        } else if (context === 'detail') {
            let targetParams = null;

            if (data.isStale) {
                targetParams = { text: `🕒 Stale (${Math.floor(data.daysSinceUpdate)}d)`, bg: '#fff0f0', border: '#ccc', color: '#666' };
            } else if (data.isPingPong) {
                targetParams = { text: `🛑 Stuck (${Math.floor(data.daysSinceCreation)}d)`, bg: '#fff8e1', border: '#ff9900', color: '#cc7a00' };
            } else if (data.isStuckInStatus) {
                targetParams = { text: `⚓ Stuck in ${data.currentStatus} (${Math.floor(data.daysInStatus)}d)`, bg: '#f3e5f5', border: '#7b1fa2', color: '#7b1fa2' };
            }

            if (targetParams) {
                // Secondary check: if an indicator with this key already exists in the container
                const existing = element.querySelector(`.jira-stale-indicator-detail[data-issue-key="${data.key}"]`);
                if (existing) {
                    return;
                }

                const badge = document.createElement('div');
                badge.className = 'jira-stale-indicator-detail';
                badge.setAttribute('data-issue-key', data.key || '');
                badge.innerText = targetParams.text;
                badge.style.cssText = `display: inline-block; margin-left: 10px; background: ${targetParams.bg}; border: 1px solid ${targetParams.border}; color: ${targetParams.color}; padding: 2px 6px; border-radius: 4px; font-size: 12px; font-weight: bold; vertical-align: middle; z-index: 1000; position: relative;`;

                // Try copy button first
                const copyButton = element.querySelector('.jira-universal-copy-button-wrapper');
                if (copyButton && copyButton.offsetParent) {
                    if (copyButton.nextSibling && copyButton.nextSibling.classList && copyButton.nextSibling.classList.contains('jira-stale-indicator-detail')) return;

                    log('Placing detail indicator next to Copy Button');
                    copyButton.parentNode.insertBefore(badge, copyButton.nextSibling);
                    return;
                }

                // Try action bar
                const actionBar = element.querySelector('[data-testid="issue.views.issue-base.foundation.quick-add.quick-add-container"]');
                if (actionBar) {
                    if (actionBar.previousSibling && actionBar.previousSibling.classList && actionBar.previousSibling.classList.contains('jira-stale-indicator-detail')) return;

                    log('Placing detail indicator before Action Bar');
                    actionBar.insertAdjacentElement('beforebegin', badge);
                    return;
                }

                // Try breadcrumbs
                let breadcrumbs = element.querySelector('[data-testid*="breadcrumbs"]');

                if (!breadcrumbs && data.key) {
                    const keyLink = document.querySelector(`a[href*="/browse/${data.key}"]`);
                    if (keyLink) {
                        breadcrumbs = keyLink;
                        log('Found issue key link directly:', data.key);
                    }
                }

                if (breadcrumbs) {
                    if (breadcrumbs.nextSibling && breadcrumbs.nextSibling.classList && breadcrumbs.nextSibling.classList.contains('jira-stale-indicator-detail')) return;

                    log('Placing detail indicator after Breadcrumbs/KeyLink');
                    breadcrumbs.insertAdjacentElement('afterend', badge);
                    return;
                }

                // Fallback to summary
                const summarySelectors = [
                    'h1[data-testid*="summary"][data-testid*="heading"]',
                    'h1',
                    '[data-testid="issue.views.issue-base.foundation.summary.heading"]',
                    '[data-testid="issue-field-summary.ui.issue-field-summary-inline-edit--container"]',
                    'div[data-testid*="summary"]',
                    'div[role="presentation"]'
                ];

                for (const sel of summarySelectors) {
                    const found = element.querySelectorAll(sel);
                    for (const summary of found) {
                        if (summary.innerText && summary.innerText.trim().length > 0) {
                            if (summary.querySelector('.jira-stale-indicator-detail')) return;

                            log('Found summary via fallback selector:', sel);
                            summary.appendChild(badge);
                            return;
                        }
                    }
                }

                log('Failed to find insertion point for detail indicator');
            }
        }
    }

    let lastUrl = window.location.href;
    const POLLING_INTERVAL = 500;
    const RETRY_LIMIT = 10;
    const RETRY_DELAY = 300;

    async function processIssueView(containerElement, attempt = 1) {
        let key = getIssueKeyFromUrl(window.location.href);

        // Fallback: check breadcrumbs
        if (!key) {
            const breadcrumbLink = containerElement.querySelector('a[href*="/browse/"]');
            if (breadcrumbLink) {
                const match = breadcrumbLink.href.match(/\/browse\/([A-Z]+-[0-9]+)/);
                if (match) key = match[1];
            }
        }

        if (!key) {
            if (attempt <= RETRY_LIMIT) {
                setTimeout(() => processIssueView(containerElement, attempt + 1), RETRY_DELAY);
            } else {
                log('Failed to identify issue key after multiple attempts');
            }
            return;
        }

        // Skip board headers
        const isBoardHeader = containerElement.matches('div[data-testid*="board-header"], div[data-testid*="project-header"], h1, h2, header');
        const insideBoardHeader = containerElement.closest('div[data-testid*="board-header"], div[data-testid*="project-header"], header');
        if (isBoardHeader || insideBoardHeader) return;

        const existingIndicator = containerElement.querySelector('.jira-stale-indicator-detail');
        if (existingIndicator) return;

        if (CACHE.has(key)) {
            applyHighlights(containerElement, CACHE.get(key), 'detail');
            return;
        }

        fetchAndApply(key, containerElement, 'detail');
    }

    function scanPage() {
        const selector = 'div[data-testid*="card-content"], div.ghx-issue, a[href*="/browse/"]';
        const elements = document.querySelectorAll(selector);
        const processedCards = new Set();

        try {
            elements.forEach(el => {
                let card = null;

                if (el.tagName === 'A') {
                    if (/\/browse\/[A-Z]+-[0-9]+/.test(el.href)) {
                        const isInsideSoftwareCard = el.closest('div[data-testid="platform-board-kit.ui.card.card"], div.ghx-issue, div.js-issue, div[data-testid*="card-content"]');
                        const isInsideView = el.closest('div[role="dialog"], div[data-testid*="modal-dialog"], #jira-issue-header, [data-testid*="issue.views.issue-base.foundation.summary.heading"]');

                        const isInsideEditor = el.closest('.ProseMirror, [contenteditable="true"], input, textarea');

                        if (!isInsideSoftwareCard && !isInsideView && !isInsideEditor) {
                            card = el;
                        }
                    }
                } else {
                    card = el.closest('div[data-testid="platform-board-kit.ui.card.card"], div.ghx-issue, div.js-issue');
                    if (!card) card = el;
                }

                if (card && !processedCards.has(card)) {
                    processedCards.add(card);
                    processCard(card);
                }
            });
        } catch (err) {
            log('Error scanning cards:', err);
        }

        // Scan modals
        const modals = document.querySelectorAll('div[role="dialog"], div[data-testid*="modal-dialog"]');
        modals.forEach(modal => {
            if (modal.offsetParent !== null) {
                processIssueView(modal);
            }
        });

        // Scan full page view
        if (window.location.pathname.includes('/browse/') || window.location.search.includes('selectedIssue')) {
            const issueHeader = document.querySelector('div[id="jira-issue-header"]');
            const container = issueHeader ? (issueHeader.closest('#jira-frontend') || issueHeader.parentElement) : document.body;

            processIssueView(container);
        }
    }

    const observer = new MutationObserver(debounced(scanPage, 300));
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            log('URL change detected via poll:', currentUrl);
            scanPage();
        }
    }, POLLING_INTERVAL);

    setTimeout(scanPage, 1000);

})();
