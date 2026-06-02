// Native Yjs Awareness Provider Cursors Tracker

const COLOR_PALETTE = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6',
  '#e11d48', '#84cc16'
];

const ANIMAL_NAMES = [
  'Falcon', 'Otter', 'Panther', 'Dolphin', 'Phoenix',
  'Wolf', 'Tiger', 'Eagle', 'Fox', 'Hawk',
  'Lion', 'Bear', 'Lynx', 'Raven', 'Cobra'
];

const ADJECTIVES = [
  'Swift', 'Curious', 'Brave', 'Quiet', 'Clever',
  'Fierce', 'Noble', 'Agile', 'Bold', 'Keen'
];

function generateRandomProfile() {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMAL_NAMES[Math.floor(Math.random() * ANIMAL_NAMES.length)];
  const color = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
  return {
    name: `${adjective} ${animal}`,
    color
  };
}

export function initPresence(provider, quill) {
  const awareness = provider.awareness;
  const cursorsModule = quill.getModule('cursors');

  // 1. Get or generate user identity profile
  let localName = localStorage.getItem('syncanvas-username');
  let localColor = localStorage.getItem('syncanvas-color');

  if (!localName || !localColor) {
    const profile = generateRandomProfile();
    localName = profile.name;
    localColor = profile.color;
    localStorage.setItem('syncanvas-username', localName);
    localStorage.setItem('syncanvas-color', localColor);
  }

  // 2. Register local state fields in Awareness
  awareness.setLocalStateField('user', {
    name: localName,
    color: localColor
  });

  const sidebarClose = document.getElementById('sidebar-toggle-close');
  const sidebar = document.getElementById('sidebar');

  sidebarClose?.addEventListener('click', () => {
    sidebar.classList.remove('open');
  });

  // Track cursor changes and user lists
  const refreshUsersList = () => {
    const activeUsers = [];
    const clientStates = awareness.getStates();

    clientStates.forEach((state, clientId) => {
      if (clientId === awareness.clientID) return; // skip self
      if (state.user) {
        activeUsers.push({ clientId, ...state.user });
      }
    });

    const userList = document.getElementById('user-list');
    const userCountElement = document.getElementById('user-count');

    // Add self to user list first
    let listHtml = `
      <li class="user-item self" data-client-id="${awareness.clientID}">
        <span class="user-avatar" id="avatar-${awareness.clientID}" style="background:${localColor}">${localName[0]}</span>
        <span class="user-name">${localName} (You)</span>
      </li>
    `;

    // Append other active users
    listHtml += activeUsers.map(u => `
      <li class="user-item" data-client-id="${u.clientId}">
        <span class="user-avatar" id="avatar-${u.clientId}" style="background:${u.color}">${u.name[0]}</span>
        <span class="user-name">${u.name}</span>
        <span class="user-status">editing</span>
      </li>
    `).join('');

    userList.innerHTML = listHtml;

    // Update user counter in topbar
    const totalUsers = activeUsers.length + 1;
    userCountElement.textContent = `${totalUsers} user${totalUsers > 1 ? 's' : ''}`;
  };

  // Listen to awareness updates
  awareness.on('change', ({ added, removed, updated }) => {
    const clientStates = awareness.getStates();

    // Show toasts for new members joining
    added.forEach(clientId => {
      if (clientId === awareness.clientID) return;
      const state = clientStates.get(clientId);
      if (state && state.user) {
        window.showToast?.(`${state.user.name} joined the session`, 'info', 2000);
      }
    });

    // Show toasts for members leaving
    removed.forEach(clientId => {
      window.showToast?.('A collaborator left', 'info', 2000);
    });

    // Notify user list UI
    refreshUsersList();
  });

  // Initial draw
  refreshUsersList();
}
