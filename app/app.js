const TRACK_COLORS = {
  vocals: '#20d5c4',
  accompaniment: '#56a9f2',
  drums: '#ffb54a',
  bass: '#ee6d9f',
  piano: '#72d890',
  guitar: '#d3a474',
  other: '#9a8de8',
};

const STATUS_LABELS = {
  ready: '已完成',
  processing: '处理中',
  queued: '等待中',
  error: '失败',
};

const MIXER_WIDTH_MIN = 250;
const MIXER_WIDTH_MAX = 500;
const MIXER_WIDTH_STORAGE_KEY = 'spleeter-studio:mixer-width';

function savedMixerWidth() {
  try {
    const value = Number(localStorage.getItem(MIXER_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : 286;
  } catch (_) {
    return 286;
  }
}

const state = {
  projects: [],
  runtime: null,
  filter: 'all',
  search: '',
  sort: 'newest',
  selectedFile: null,
  currentProject: null,
  openProjectIds: [],
  projectAudioCache: new Map(),
  tabPointerDrag: null,
  suppressTabClick: false,
  mixerWidth: savedMixerWidth(),
  buffers: new Map(),
  audioContext: null,
  masterGain: null,
  nodes: new Map(),
  channelState: new Map(),
  selectedTrackId: null,
  isPlaying: false,
  isStarting: false,
  playGeneration: 0,
  isLooping: false,
  position: 0,
  duration: 0,
  startedAt: 0,
  startOffset: 0,
  playbackRate: 1,
  animationFrame: null,
  zoom: 1,
  pollTimer: null,
  renderGeneration: 0,
};

const elements = {
  appShell: document.querySelector('#appShell'),
  sidebar: document.querySelector('.sidebar'),
  workspaceTabs: document.querySelector('#workspaceTabs'),
  libraryTab: document.querySelector('#libraryTab'),
  projectTabs: document.querySelector('#projectTabs'),
  newTabButton: document.querySelector('#newTabButton'),
  libraryView: document.querySelector('#libraryView'),
  studioView: document.querySelector('#studioView'),
  libraryNav: document.querySelector('#libraryNav'),
  newProjectNav: document.querySelector('#newProjectNav'),
  brandButton: document.querySelector('#brandButton'),
  projectCount: document.querySelector('#projectCount'),
  recentProjects: document.querySelector('#recentProjects'),
  runtimeCard: document.querySelector('#runtimeCard'),
  runtimeTitle: document.querySelector('#runtimeTitle'),
  runtimeDetail: document.querySelector('#runtimeDetail'),
  runtimeRetry: document.querySelector('#runtimeRetry'),
  runtimeBanner: document.querySelector('#runtimeBanner'),
  runtimeBannerText: document.querySelector('#runtimeBannerText'),
  runtimeBannerRetry: document.querySelector('#runtimeBannerRetry'),
  configurePythonButton: document.querySelector('#configurePythonButton'),
  projectSearch: document.querySelector('#projectSearch'),
  projectSort: document.querySelector('#projectSort'),
  projectList: document.querySelector('#projectList'),
  emptyState: document.querySelector('#emptyState'),
  newProjectButton: document.querySelector('#newProjectButton'),
  emptyAddButton: document.querySelector('#emptyAddButton'),
  dialog: document.querySelector('#newProjectDialog'),
  newProjectForm: document.querySelector('#newProjectForm'),
  closeDialog: document.querySelector('#closeDialog'),
  cancelDialog: document.querySelector('#cancelDialog'),
  audioFileInput: document.querySelector('#audioFileInput'),
  dropZone: document.querySelector('#dropZone'),
  dropZoneTitle: document.querySelector('#dropZoneTitle'),
  dropZoneMeta: document.querySelector('#dropZoneMeta'),
  createProjectButton: document.querySelector('#createProjectButton'),
  uploadProgress: document.querySelector('#uploadProgress'),
  uploadStatus: document.querySelector('#uploadStatus'),
  uploadPercent: document.querySelector('#uploadPercent'),
  uploadProgressBar: document.querySelector('#uploadProgressBar'),
  dialogError: document.querySelector('#dialogError'),
  modelHint: document.querySelector('#modelHint'),
  backToLibrary: document.querySelector('#backToLibrary'),
  studioCover: document.querySelector('#studioCover'),
  studioTitle: document.querySelector('#studioTitle'),
  studioMeta: document.querySelector('#studioMeta'),
  exportButton: document.querySelector('#exportButton'),
  studioLoading: document.querySelector('#studioLoading'),
  mixer: document.querySelector('#mixer'),
  mixerResizer: document.querySelector('#mixerResizer'),
  channelStrips: document.querySelector('#channelStrips'),
  waveformRows: document.querySelector('#waveformRows'),
  timelineViewport: document.querySelector('#timelineViewport'),
  timelineContent: document.querySelector('#timelineContent'),
  timelineRuler: document.querySelector('#timelineRuler'),
  playhead: document.querySelector('#playhead'),
  trackCountLabel: document.querySelector('#trackCountLabel'),
  zoomSlider: document.querySelector('#zoomSlider'),
  transportTitle: document.querySelector('#transportTitle'),
  transportTracks: document.querySelector('#transportTracks'),
  transportCover: document.querySelector('#transportCover'),
  playButton: document.querySelector('#playButton'),
  backwardButton: document.querySelector('#backwardButton'),
  forwardButton: document.querySelector('#forwardButton'),
  loopButton: document.querySelector('#loopButton'),
  currentTime: document.querySelector('#currentTime'),
  totalTime: document.querySelector('#totalTime'),
  playbackRate: document.querySelector('#playbackRate'),
  masterVolume: document.querySelector('#masterVolume'),
  toastRegion: document.querySelector('#toastRegion'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function coverContent(project, fallback = '<span></span><span></span><span></span>') {
  if (!project?.coverUrl) return fallback;
  const version = encodeURIComponent(project.updatedAt || project.createdAt || '1');
  return `<img src="${escapeHtml(project.coverUrl)}?v=${version}" alt="" />`;
}

function coverMarkup(project, className, fallback) {
  return `<span class="${className}">${coverContent(project, fallback)}</span>`;
}

function setProjectCover(element, project) {
  element.innerHTML = coverContent(project);
  element.classList.toggle('has-artwork', Boolean(project?.coverUrl));
}

function renderWorkspaceTabs() {
  const existingIds = new Set(state.projects.map((project) => project.id));
  disposeProjectAudios([...state.projectAudioCache.keys()].filter((projectId) => !existingIds.has(projectId)));
  state.openProjectIds = state.openProjectIds.filter((projectId) => existingIds.has(projectId));
  const activeId = state.currentProject?.id || null;
  elements.libraryTab.classList.toggle('is-active', !activeId);
  elements.libraryTab.setAttribute('aria-selected', String(!activeId));
  elements.projectTabs.innerHTML = state.openProjectIds.map((projectId) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return '';
    const active = projectId === activeId;
    return `
      <div class="workspace-tab project-tab${active ? ' is-active' : ''}" data-project-tab="${escapeHtml(projectId)}" aria-haspopup="menu">
        <button class="project-tab-select" type="button" role="tab" aria-selected="${active}" title="${escapeHtml(project.title)}">
          ${coverMarkup(project, 'tab-cover')}
          <span class="tab-title">${escapeHtml(project.title)}</span>
        </button>
        <button class="tab-close" type="button" data-close-tab="${escapeHtml(projectId)}" title="关闭标签页" aria-label="关闭 ${escapeHtml(project.title)}"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>`;
  }).join('');
  refreshIcons();
}

function disposeProjectAudio(projectId) {
  const entry = state.projectAudioCache.get(projectId);
  if (entry) entry.disposed = true;
  state.projectAudioCache.delete(projectId);
}

function disposeProjectAudios(projectIds) {
  projectIds.forEach(disposeProjectAudio);
}

function reorderProjectTab(sourceId, targetId, placeAfter = false) {
  if (!sourceId || sourceId === targetId || !state.openProjectIds.includes(sourceId)) return false;
  const nextIds = state.openProjectIds.filter((id) => id !== sourceId);
  let targetIndex = targetId ? nextIds.indexOf(targetId) : nextIds.length;
  if (targetIndex < 0) targetIndex = nextIds.length;
  if (targetId && placeAfter) targetIndex += 1;
  nextIds.splice(targetIndex, 0, sourceId);
  if (nextIds.every((id, index) => id === state.openProjectIds[index])) return false;
  state.openProjectIds = nextIds;
  renderWorkspaceTabs();
  return true;
}

function closeProjectTab(projectId) {
  const index = state.openProjectIds.indexOf(projectId);
  if (index < 0) return;
  state.openProjectIds.splice(index, 1);
  disposeProjectAudio(projectId);
  if (state.currentProject?.id !== projectId) {
    renderWorkspaceTabs();
    return;
  }
  const previousId = state.openProjectIds[index - 1] || state.openProjectIds[index];
  if (previousId) openProject(previousId);
  else showLibrary();
}

function closeTabContextMenu() {
  document.querySelector('.tab-context-menu')?.remove();
}

function closeOtherProjectTabs(projectId) {
  if (!projectId) {
    closeAllProjectTabs();
    return;
  }
  disposeProjectAudios(state.openProjectIds.filter((id) => id !== projectId));
  state.openProjectIds = state.openProjectIds.filter((id) => id === projectId);
  if (state.currentProject?.id === projectId) renderWorkspaceTabs();
  else openProject(projectId);
}

function closeProjectTabsToRight(projectId) {
  if (!projectId) {
    closeAllProjectTabs();
    return;
  }
  const index = state.openProjectIds.indexOf(projectId);
  if (index < 0) return;
  const removedIds = new Set(state.openProjectIds.slice(index + 1));
  disposeProjectAudios(removedIds);
  state.openProjectIds = state.openProjectIds.slice(0, index + 1);
  if (state.currentProject && removedIds.has(state.currentProject.id)) openProject(projectId);
  else renderWorkspaceTabs();
}

function closeAllProjectTabs() {
  disposeProjectAudios(state.openProjectIds);
  state.openProjectIds = [];
  showLibrary();
}

function openTabContextMenu(projectId, x, y) {
  closeTabContextMenu();
  const isHome = !projectId;
  const index = isHome ? -1 : state.openProjectIds.indexOf(projectId);
  const hasOtherTabs = isHome ? state.openProjectIds.length > 0 : state.openProjectIds.some((id) => id !== projectId);
  const hasTabsToRight = isHome ? state.openProjectIds.length > 0 : index >= 0 && index < state.openProjectIds.length - 1;
  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" data-tab-action="close"${isHome ? ' disabled' : ''}>关闭标签页</button>
    <button type="button" role="menuitem" data-tab-action="close-others"${hasOtherTabs ? '' : ' disabled'}>关闭其他标签页</button>
    <button type="button" role="menuitem" data-tab-action="close-right"${hasTabsToRight ? '' : ' disabled'}>关闭右侧标签页</button>
    <div class="tab-context-menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-tab-action="close-all"${state.openProjectIds.length ? '' : ' disabled'}>关闭全部标签页</button>`;
  document.body.append(menu);
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.addEventListener('click', (event) => {
    const action = event.target.closest('[data-tab-action]:not(:disabled)')?.dataset.tabAction;
    if (!action) return;
    closeTabContextMenu();
    if (action === 'close') closeProjectTab(projectId);
    if (action === 'close-others') closeOtherProjectTabs(projectId);
    if (action === 'close-right') closeProjectTabsToRight(projectId);
    if (action === 'close-all') closeAllProjectTabs();
  });
  menu.querySelector('button:not(:disabled)')?.focus();
}

function setMixerWidth(value, { persist = false } = {}) {
  const availableWidth = elements.mixer.clientWidth || elements.studioView.clientWidth || window.innerWidth;
  const responsiveMax = Math.max(MIXER_WIDTH_MIN, availableWidth - 360);
  const maximum = Math.min(MIXER_WIDTH_MAX, responsiveMax);
  const width = Math.round(Math.max(MIXER_WIDTH_MIN, Math.min(maximum, Number(value) || 286)));
  state.mixerWidth = width;
  elements.mixer.style.setProperty('--channel-width', `${width}px`);
  elements.mixerResizer.setAttribute('aria-valuenow', String(width));
  elements.mixerResizer.setAttribute('aria-valuemax', String(Math.round(maximum)));
  if (persist) {
    try { localStorage.setItem(MIXER_WIDTH_STORAGE_KEY, String(width)); } catch (_) { /* Storage is optional. */ }
  }
  if (state.currentProject) window.requestAnimationFrame(updateTimelineSize);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(date);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(body?.error || body || `请求失败 (${response.status})`);
  }
  return body;
}

function toast(message, type = 'info') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  window.setTimeout(() => item.remove(), 4200);
}

async function loadRuntime(refresh = false) {
  elements.runtimeCard.className = 'runtime-card';
  elements.runtimeTitle.textContent = '正在检查引擎';
  try {
    const result = refresh ? await api('/api/runtime/recheck', { method: 'POST' }) : await api('/api/config');
    state.runtime = result.runtime;
    const ready = Boolean(state.runtime.ready);
    elements.runtimeCard.classList.add(ready ? 'is-ready' : 'is-error');
    elements.runtimeTitle.textContent = ready ? '分离引擎已就绪' : '分离引擎未就绪';
    elements.runtimeDetail.textContent = ready
      ? `RoFormer · ${state.runtime.device === 'cuda' ? 'GPU' : 'CPU'}` : '需要配置 RoFormer';
    elements.runtimeCard.title = state.runtime.message || '';
    elements.runtimeBanner.classList.toggle('is-hidden', ready);
    elements.runtimeBannerText.textContent = state.runtime.message || '';
    updateModeAvailability();
    return ready;
  } catch (error) {
    state.runtime = { ready: false, message: error.message };
    elements.runtimeCard.classList.add('is-error');
    elements.runtimeTitle.textContent = '无法检查引擎';
    elements.runtimeDetail.textContent = '后台服务异常';
    elements.runtimeBanner.classList.remove('is-hidden');
    elements.runtimeBannerText.textContent = error.message;
    updateModeAvailability();
    return false;
  }
}

function selectedStemCount() {
  return Number(elements.newProjectForm.querySelector('[name="stemCount"]:checked')?.value || 2);
}

function modeReady(stemCount) {
  return Boolean(state.runtime?.ready && Object.values(state.runtime.models || {})
    .some((model) => model.ready && model.stemCounts.includes(stemCount)));
}

function updateModeAvailability() {
  const inputs = [...elements.newProjectForm.querySelectorAll('[name="stemCount"]')];
  inputs.forEach((input) => {
    input.disabled = !modeReady(Number(input.value));
    const model = Object.values(state.runtime?.models || {}).find((item) => item.stemCounts.includes(Number(input.value)));
    input.closest('label').title = model?.message || model?.name || '';
  });
  if (inputs.find((input) => input.checked)?.disabled) {
    const available = inputs.find((input) => !input.disabled);
    if (available) available.checked = true;
  }
  const count = selectedStemCount();
  const descriptions = {
    2: 'Big Beta 6X · 分离人声与伴奏。',
    4: 'SW Fixed · 钢琴、吉他合入“其他”，输出四轨。',
    5: 'SW Fixed · 保留钢琴，吉他合入“其他”，输出五轨。',
    6: 'SW Fixed · 保留人声、鼓、贝斯、钢琴、吉他和其他六轨。',
  };
  const missing = Object.values(state.runtime?.models || {}).filter((model) => !model.ready);
  elements.modelHint.textContent = descriptions[count] + (missing.length ? ' 部分模式缺少本地模型，暂不可用。' : '');
  elements.createProjectButton.disabled = !state.selectedFile || !modeReady(count);
}

async function loadProjects({ quiet = false } = {}) {
  try {
    const result = await api('/api/projects');
    const previous = new Map(state.projects.map((project) => [project.id, project.status]));
    state.projects = result.projects || [];
    if (state.currentProject) {
      const refreshed = state.projects.find((project) => project.id === state.currentProject.id);
      if (refreshed) state.currentProject = refreshed;
      else showLibrary();
    }
    renderProjects();
    if (!quiet) renderRecents();
    for (const project of state.projects) {
      if (previous.has(project.id) && previous.get(project.id) !== project.status) {
        if (project.status === 'ready') toast(`“${project.title}”分离完成`);
        if (project.status === 'error') toast(`“${project.title}”分离失败：${project.error || '未知错误'}`, 'error');
      }
    }
    updatePolling();
    const hashId = location.hash.startsWith('#project=') ? decodeURIComponent(location.hash.slice(9)) : '';
    if (hashId && !state.currentProject) {
      const project = state.projects.find((item) => item.id === hashId && item.status === 'ready');
      if (project) openProject(project.id);
    }
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
  }
}

function updatePolling() {
  const needsPolling = state.projects.some((project) => ['queued', 'processing'].includes(project.status));
  if (needsPolling && !state.pollTimer) {
    state.pollTimer = window.setInterval(() => loadProjects({ quiet: true }), 1500);
  } else if (!needsPolling && state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function filteredProjects() {
  const search = state.search.trim().toLocaleLowerCase('zh-CN');
  const projects = state.projects.filter((project) => {
    const matchesFilter = state.filter === 'all'
      || (state.filter === 'processing' && ['queued', 'processing'].includes(project.status))
      || project.status === state.filter;
    const matchesSearch = !search || project.title.toLocaleLowerCase('zh-CN').includes(search)
      || project.sourceName.toLocaleLowerCase('zh-CN').includes(search);
    return matchesFilter && matchesSearch;
  });
  projects.sort((left, right) => {
    if (state.sort === 'name') return left.title.localeCompare(right.title, 'zh-CN');
    if (state.sort === 'stems') return right.stemCount - left.stemCount;
    return String(right.createdAt).localeCompare(String(left.createdAt));
  });
  return projects;
}

function projectRow(project) {
  const canOpen = project.status === 'ready';
  const isProcessing = project.status === 'processing';
  const progress = ['queued', 'processing'].includes(project.status)
    ? `<div class="project-progress"><span style="width:${Math.max(3, project.progress || 0)}%"></span></div>`
    : '';
  const statusLabel = isProcessing
    ? `${project.progress || 0}% · ${formatTime(project.processingSeconds || 0)}`
    : (STATUS_LABELS[project.status] || project.phase || project.status);
  return `
    <div class="project-row" data-project-id="${escapeHtml(project.id)}" tabindex="0" role="button" aria-label="${canOpen ? '打开' : '查看'} ${escapeHtml(project.title)}">
      <div class="project-main">
        ${coverMarkup(project, 'project-cover')}
        <div>
          <strong>${escapeHtml(project.title)}</strong>
          <small>${project.artist ? `${escapeHtml(project.artist)} · ` : ''}${escapeHtml(project.sourceName)} · ${project.engine === 'roformer' ? 'RoFormer · ' : ''}${formatDate(project.createdAt)}</small>
        </div>
      </div>
      <span class="project-cell">${project.stemCount} 轨</span>
      <span class="project-cell">${formatTime(project.duration)}</span>
      <span class="status-pill ${escapeHtml(project.status)}">${escapeHtml(statusLabel)}</span>
      <button class="row-menu-button" type="button" data-menu-id="${escapeHtml(project.id)}" aria-label="项目操作" title="项目操作">⋯</button>
      ${progress}
    </div>`;
}

function renderProjects() {
  const projects = filteredProjects();
  elements.projectCount.textContent = String(state.projects.length);
  elements.projectList.innerHTML = projects.map(projectRow).join('');
  const trulyEmpty = state.projects.length === 0;
  elements.emptyState.classList.toggle('is-hidden', !trulyEmpty);
  elements.projectList.parentElement.classList.toggle('is-hidden', trulyEmpty);

  elements.projectList.querySelectorAll('.project-row').forEach((row) => {
    const activate = () => handleProjectActivation(row.dataset.projectId);
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-menu-id]')) return;
      activate();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  });
  elements.projectList.querySelectorAll('[data-menu-id]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openProjectMenu(button.dataset.menuId, button);
    });
  });
  renderRecents();
  renderWorkspaceTabs();
}

function renderRecents() {
  elements.recentProjects.innerHTML = state.projects.slice(0, 4).map((project) => `
    <button class="recent-project" type="button" data-recent-id="${escapeHtml(project.id)}">
      ${coverMarkup(project, 'tiny-cover', escapeHtml(String(project.stemCount)))}
      <span>${escapeHtml(project.title)}</span>
    </button>`).join('');
  elements.recentProjects.querySelectorAll('[data-recent-id]').forEach((button) => {
    button.addEventListener('click', () => handleProjectActivation(button.dataset.recentId));
  });
}

function handleProjectActivation(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  if (project.status === 'ready') {
    openProject(projectId);
  } else if (project.status === 'error') {
    toast(project.error || '分离失败', 'error');
  } else {
    const elapsed = project.processingSeconds ? ` · 已用时 ${formatTime(project.processingSeconds)}` : '';
    toast(`${project.phase || '正在处理'}${elapsed}`);
  }
}

function closeProjectMenu() {
  document.querySelector('.project-menu')?.remove();
}

function openProjectMenu(projectId, anchor) {
  closeProjectMenu();
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  const menu = document.createElement('div');
  menu.className = 'project-menu';
  if (project.status === 'ready') {
    menu.innerHTML += '<button type="button" data-action="open"><i data-lucide="folder-open" aria-hidden="true"></i>打开工程</button>';
    menu.innerHTML += '<a data-action="export" href="' + project.exportUrl + '" download><i data-lucide="download" aria-hidden="true"></i>导出音轨</a>';
  }
  if (project.status === 'error') menu.innerHTML += '<button type="button" data-action="retry"><i data-lucide="refresh-cw" aria-hidden="true"></i>重新分离</button>';
  if (!['queued', 'processing'].includes(project.status)) menu.innerHTML += '<button type="button" class="danger" data-action="delete"><i data-lucide="trash-2" aria-hidden="true"></i>删除项目</button>';
  document.body.append(menu);
  refreshIcons();
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 12)}px`;
  menu.style.left = `${Math.max(12, rect.right - menu.offsetWidth)}px`;
  menu.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || action === 'export') return;
    closeProjectMenu();
    if (action === 'open') openProject(projectId);
    if (action === 'retry') retryProject(projectId);
    if (action === 'delete') deleteProject(projectId);
  });
}

async function retryProject(projectId) {
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/retry`, { method: 'POST' });
    toast('已重新加入分离队列');
    loadProjects({ quiet: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project || !window.confirm(`删除项目“${project.title}”及其所有分离音轨？`)) return;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
    state.openProjectIds = state.openProjectIds.filter((id) => id !== projectId);
    disposeProjectAudio(projectId);
    toast('项目已删除');
    await loadProjects({ quiet: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openNewProjectDialog() {
  closeProjectMenu();
  resetDialog();
  if (!state.runtime?.ready) {
    elements.dialogError.textContent = state.runtime?.message || '分离引擎尚未就绪';
    elements.dialogError.classList.remove('is-hidden');
  }
  elements.dialog.showModal();
}

function resetDialog() {
  state.selectedFile = null;
  elements.audioFileInput.value = '';
  elements.dropZone.classList.remove('has-file', 'is-dragging');
  elements.dropZoneTitle.textContent = '选择音频文件';
  elements.dropZoneMeta.textContent = 'MP3、WAV、FLAC、OGG、M4A、AAC、WMA';
  elements.createProjectButton.disabled = true;
  elements.uploadProgress.classList.add('is-hidden');
  elements.dialogError.classList.add('is-hidden');
  elements.dialogError.textContent = '';
  updateModeAvailability();
}

function chooseFile(file) {
  if (!file) return;
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma'].includes(extension)) {
    elements.dialogError.textContent = '请选择受支持的音频文件。';
    elements.dialogError.classList.remove('is-hidden');
    return;
  }
  state.selectedFile = file;
  elements.dropZone.classList.add('has-file');
  elements.dropZoneTitle.textContent = file.name;
  elements.dropZoneMeta.textContent = formatBytes(file.size);
  elements.createProjectButton.disabled = !modeReady(selectedStemCount());
  if (modeReady(selectedStemCount())) elements.dialogError.classList.add('is-hidden');
}

function uploadProject(file, stemCount) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/projects');
    request.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    request.setRequestHeader('X-Stems', String(stemCount));
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      elements.uploadPercent.textContent = `${percent}%`;
      elements.uploadProgressBar.value = percent;
    });
    request.addEventListener('load', () => {
      let body = null;
      try { body = JSON.parse(request.responseText); } catch (_) { body = null; }
      if (request.status >= 200 && request.status < 300) resolve(body);
      else reject(new Error(body?.error || `上传失败 (${request.status})`));
    });
    request.addEventListener('error', () => reject(new Error('无法连接本地后台服务')));
    request.send(file);
  });
}

async function createProject(event) {
  event.preventDefault();
  if (!state.selectedFile || !modeReady(selectedStemCount())) return;
  const stemCount = Number(new FormData(elements.newProjectForm).get('stemCount'));
  elements.createProjectButton.disabled = true;
  elements.uploadProgress.classList.remove('is-hidden');
  elements.uploadStatus.textContent = '正在导入音频';
  elements.uploadPercent.textContent = '0%';
  elements.uploadProgressBar.value = 0;
  elements.dialogError.classList.add('is-hidden');
  try {
    const project = await uploadProject(state.selectedFile, stemCount);
    elements.dialog.close();
    toast(`“${project.title}”已加入 ${stemCount} 轨分离队列`);
    await loadProjects({ quiet: true });
  } catch (error) {
    elements.dialogError.textContent = error.message;
    elements.dialogError.classList.remove('is-hidden');
    updateModeAvailability();
  }
}

async function ensureAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextClass();
    state.masterGain = state.audioContext.createGain();
    state.masterGain.gain.value = Number(elements.masterVolume.value);
    state.masterGain.connect(state.audioContext.destination);
  }
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
  return state.audioContext;
}

function projectAudioEntry(project) {
  const existing = state.projectAudioCache.get(project.id);
  if (existing) return existing;
  const entry = {
    buffers: new Map(),
    channelState: new Map(project.tracks.map((track) => [track.id, {
      volume: 0.82,
      muted: false,
      solo: false,
      pan: 0,
    }])),
    selectedTrackId: project.tracks[0]?.id || null,
    position: 0,
    duration: project.duration || 0,
    status: 'loading',
    disposed: false,
    promise: null,
  };
  state.projectAudioCache.set(project.id, entry);
  entry.promise = (async () => {
    const context = await ensureAudioContext();
    await Promise.all(project.tracks.map(async (track) => {
      const response = await fetch(track.url);
      if (!response.ok) throw new Error(`无法读取${track.label}音轨`);
      const data = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(data);
      if (entry.disposed || state.projectAudioCache.get(project.id) !== entry) return;
      entry.buffers.set(track.id, buffer);
      entry.duration = Math.max(entry.duration, buffer.duration);
    }));
    if (!entry.disposed && state.projectAudioCache.get(project.id) === entry) entry.status = 'ready';
    return entry;
  })().catch((error) => {
    if (state.projectAudioCache.get(project.id) === entry) state.projectAudioCache.delete(project.id);
    entry.status = 'error';
    throw error;
  });
  return entry;
}

function saveCurrentProjectSession() {
  if (!state.currentProject) return;
  const entry = state.projectAudioCache.get(state.currentProject.id);
  if (!entry || entry.disposed) return;
  entry.selectedTrackId = state.selectedTrackId;
  entry.position = state.position;
  entry.duration = state.duration;
}

function activateProjectSession(project, entry) {
  state.buffers = entry.buffers;
  state.channelState = entry.channelState;
  state.selectedTrackId = entry.selectedTrackId || project.tracks[0]?.id || null;
  state.duration = entry.duration || project.duration || 0;
  state.position = Math.min(entry.position || 0, state.duration);
  elements.studioLoading.classList.add('is-hidden');
  elements.mixer.classList.remove('is-hidden');
  renderMixer();
  elements.totalTime.textContent = formatTime(state.duration);
  elements.currentTime.textContent = formatTime(state.position);
  updatePlayhead();
}

async function openProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project || project.status !== 'ready') return;
  if (!state.openProjectIds.includes(projectId)) state.openProjectIds.push(projectId);
  if (state.currentProject?.id === projectId && !elements.studioView.classList.contains('is-hidden')
      && state.projectAudioCache.has(projectId)) {
    renderWorkspaceTabs();
    return;
  }
  closeProjectMenu();
  stopPlayback(false);
  saveCurrentProjectSession();
  state.currentProject = project;
  state.position = 0;
  state.duration = project.duration || 0;
  state.buffers = new Map();
  state.channelState = new Map();
  state.selectedTrackId = project.tracks[0]?.id || null;
  state.renderGeneration += 1;
  const generation = state.renderGeneration;
  location.hash = `project=${encodeURIComponent(project.id)}`;

  elements.appShell.classList.add('is-studio');
  elements.sidebar.setAttribute('aria-hidden', 'true');
  elements.libraryView.classList.add('is-hidden');
  elements.studioView.classList.remove('is-hidden');
  setMixerWidth(state.mixerWidth);
  elements.libraryNav.classList.remove('is-active');
  elements.studioLoading.innerHTML = '<span class="spinner"></span><strong>正在载入音轨</strong>';
  renderWorkspaceTabs();
  setProjectCover(elements.studioCover, project);
  setProjectCover(elements.transportCover, project);
  elements.studioTitle.textContent = project.title;
  elements.studioMeta.textContent = `${project.artist ? `${project.artist} · ` : ''}${project.stemCount} 轨工程 · ${formatTime(project.duration)}${project.engine === 'roformer' ? ` · ${project.modelName || 'RoFormer'}` : ''}`;
  elements.transportTitle.textContent = project.title;
  elements.transportTracks.textContent = `${project.artist ? `${project.artist} · ` : ''}${project.stemCount} 条分离音轨`;
  elements.exportButton.href = project.exportUrl;
  elements.totalTime.textContent = formatTime(project.duration);
  elements.currentTime.textContent = '0:00';

  const entry = projectAudioEntry(project);
  if (entry.status === 'ready') {
    activateProjectSession(project, entry);
    return;
  }
  elements.studioLoading.classList.remove('is-hidden');
  elements.mixer.classList.add('is-hidden');
  try {
    await entry.promise;
    if (generation !== state.renderGeneration || state.currentProject?.id !== project.id
        || entry.disposed || state.projectAudioCache.get(project.id) !== entry) return;
    activateProjectSession(project, entry);
  } catch (error) {
    if (generation !== state.renderGeneration || state.currentProject?.id !== project.id) return;
    elements.studioLoading.innerHTML = `<strong>音轨载入失败</strong><span>${escapeHtml(error.message)}</span>`;
    toast(error.message, 'error');
  }
}

function showLibrary() {
  stopPlayback(false);
  saveCurrentProjectSession();
  state.renderGeneration += 1;
  state.currentProject = null;
  state.buffers = new Map();
  state.channelState = new Map();
  state.selectedTrackId = null;
  state.position = 0;
  state.duration = 0;
  location.hash = '';
  elements.appShell.classList.remove('is-studio');
  elements.sidebar.removeAttribute('aria-hidden');
  elements.studioView.classList.add('is-hidden');
  elements.libraryView.classList.remove('is-hidden');
  elements.libraryNav.classList.add('is-active');
  elements.studioLoading.innerHTML = '<span class="spinner"></span><strong>正在载入音轨</strong>';
  renderWorkspaceTabs();
}

function renderMixer() {
  const project = state.currentProject;
  if (!project) return;
  elements.trackCountLabel.textContent = `${project.tracks.length} 轨`;
  elements.channelStrips.innerHTML = project.tracks.map((track) => {
    const color = TRACK_COLORS[track.id] || '#20d5c4';
    const channel = state.channelState.get(track.id) || { volume: 0.82, muted: false, solo: false, pan: 0 };
    return `
      <section class="channel-strip" data-channel="${escapeHtml(track.id)}" style="--track-color:${color}">
        <div class="channel-strip-header">
          <span class="track-color"></span>
          <strong>${escapeHtml(track.label)}</strong>
          <span>${escapeHtml(track.id)}</span>
        </div>
        <div class="channel-controls">
          <input class="track-volume" type="range" min="0" max="1" step="0.01" value="${channel.volume}" aria-label="${escapeHtml(track.label)}音量" />
          <button class="toggle-button mute${channel.muted ? ' is-active' : ''}" type="button" aria-label="静音${escapeHtml(track.label)}">M</button>
          <button class="toggle-button solo${channel.solo ? ' is-active' : ''}" type="button" aria-label="独奏${escapeHtml(track.label)}">S</button>
          <label class="pan-control" title="声像"><span>L</span><input class="track-pan" type="range" min="-1" max="1" step="0.01" value="${channel.pan}" aria-label="${escapeHtml(track.label)}声像" /><span>R</span></label>
        </div>
      </section>`;
  }).join('');
  elements.waveformRows.innerHTML = project.tracks.map((track) => `
    <div class="waveform-row" data-waveform="${escapeHtml(track.id)}" style="--track-color:${TRACK_COLORS[track.id] || '#20d5c4'}">
      <canvas aria-label="${escapeHtml(track.label)}波形"></canvas>
    </div>`).join('');

  elements.channelStrips.querySelectorAll('[data-channel]').forEach((strip) => {
    const id = strip.dataset.channel;
    strip.addEventListener('click', (event) => {
      if (event.target.closest('button, input, label')) return;
      selectTrack(id);
    });
    strip.querySelector('.track-volume').addEventListener('input', (event) => {
      state.channelState.get(id).volume = Number(event.target.value);
      updateChannelGains();
    });
    strip.querySelector('.track-pan').addEventListener('input', (event) => {
      state.channelState.get(id).pan = Number(event.target.value);
      updateChannelGains();
    });
    strip.querySelector('.mute').addEventListener('click', (event) => toggleChannelState(id, 'muted', event.currentTarget));
    strip.querySelector('.solo').addEventListener('click', (event) => toggleChannelState(id, 'solo', event.currentTarget));
  });
  elements.waveformRows.querySelectorAll('[data-waveform]').forEach((row) => {
    row.addEventListener('click', (event) => {
      selectTrack(row.dataset.waveform);
      const rect = elements.timelineContent.getBoundingClientRect();
      seekTo(((event.clientX - rect.left) / rect.width) * state.duration);
    });
  });
  updateWaveformStates();
  updateTimelineSize();
}

function selectTrack(trackId) {
  if (!state.channelState.has(trackId) || state.selectedTrackId === trackId) return;
  state.selectedTrackId = trackId;
  updateWaveformStates();
}

function toggleChannelState(trackId, key, button) {
  const channel = state.channelState.get(trackId);
  channel[key] = !channel[key];
  if (key === 'solo' && channel[key]) state.selectedTrackId = trackId;
  button.classList.toggle('is-active', channel[key]);
  updateChannelGains();
  updateWaveformStates();
}

function effectiveVolume(trackId) {
  const channel = state.channelState.get(trackId);
  const hasSolo = [...state.channelState.values()].some((item) => item.solo);
  if (!channel || channel.muted || (hasSolo && !channel.solo)) return 0;
  return channel.volume;
}

function updateChannelGains() {
  state.nodes.forEach((node, trackId) => {
    const channel = state.channelState.get(trackId);
    node.gain.gain.setTargetAtTime(effectiveVolume(trackId), state.audioContext.currentTime, 0.01);
    if (node.pan?.pan) node.pan.pan.setTargetAtTime(channel.pan, state.audioContext.currentTime, 0.01);
  });
}

function updateWaveformStates() {
  const hasSolo = [...state.channelState.values()].some((item) => item.solo);
  elements.waveformRows.querySelectorAll('[data-waveform]').forEach((row) => {
    const channel = state.channelState.get(row.dataset.waveform);
    row.classList.toggle('is-muted', channel.muted || (hasSolo && !channel.solo));
    row.classList.toggle('is-solo', channel.solo);
    row.classList.toggle('is-selected', row.dataset.waveform === state.selectedTrackId);
  });
  elements.channelStrips.querySelectorAll('[data-channel]').forEach((strip) => {
    strip.classList.toggle('is-selected', strip.dataset.channel === state.selectedTrackId);
  });
  requestAnimationFrame(drawAllWaveforms);
}

function createSources(offset) {
  const context = state.audioContext;
  state.nodes.clear();
  state.buffers.forEach((buffer, trackId) => {
    const source = context.createBufferSource();
    const gain = context.createGain();
    const pan = context.createStereoPanner ? context.createStereoPanner() : null;
    source.buffer = buffer;
    source.playbackRate.value = state.playbackRate;
    gain.gain.value = effectiveVolume(trackId);
    if (pan) {
      pan.pan.value = state.channelState.get(trackId).pan;
      source.connect(gain).connect(pan).connect(state.masterGain);
    } else {
      source.connect(gain).connect(state.masterGain);
    }
    source.start(0, Math.min(offset, Math.max(0, buffer.duration - 0.001)));
    state.nodes.set(trackId, { source, gain, pan });
  });
}

async function play() {
  if (!state.currentProject || !state.buffers.size || state.isPlaying || state.isStarting) return;
  const generation = ++state.playGeneration;
  state.isStarting = true;
  try {
    await ensureAudioContext();
  } finally {
    if (generation === state.playGeneration) state.isStarting = false;
  }
  if (generation !== state.playGeneration || !state.currentProject) return;
  if (state.position >= state.duration - 0.02) state.position = 0;
  createSources(state.position);
  state.startOffset = state.position;
  state.startedAt = state.audioContext.currentTime;
  state.isPlaying = true;
  elements.playButton.classList.add('is-playing');
  elements.playButton.setAttribute('aria-label', '暂停');
  tick();
}

function pause() {
  state.playGeneration += 1;
  state.isStarting = false;
  if (!state.isPlaying) return;
  state.position = Math.min(state.duration, state.startOffset + (state.audioContext.currentTime - state.startedAt) * state.playbackRate);
  stopSources();
  state.isPlaying = false;
  elements.playButton.classList.remove('is-playing');
  elements.playButton.setAttribute('aria-label', '播放');
  if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
  state.animationFrame = null;
  updatePlayhead();
}

function stopSources() {
  state.nodes.forEach(({ source }) => {
    try { source.stop(); } catch (_) { /* Already stopped. */ }
    try { source.disconnect(); } catch (_) { /* Already disconnected. */ }
  });
  state.nodes.clear();
}

function stopPlayback(reset = false) {
  pause();
  stopSources();
  if (reset) state.position = 0;
  updatePlayhead();
}

function togglePlayback() {
  if (state.isPlaying || state.isStarting) pause();
  else play();
}

function tick() {
  if (!state.isPlaying) return;
  state.position = state.startOffset + (state.audioContext.currentTime - state.startedAt) * state.playbackRate;
  if (state.position >= state.duration) {
    if (state.isLooping) {
      stopSources();
      state.position = 0;
      createSources(0);
      state.startOffset = 0;
      state.startedAt = state.audioContext.currentTime;
    } else {
      state.position = state.duration;
      pause();
      return;
    }
  }
  updatePlayhead();
  state.animationFrame = requestAnimationFrame(tick);
}

function seekTo(seconds) {
  const next = Math.max(0, Math.min(state.duration, seconds));
  const resume = state.isPlaying;
  if (resume) pause();
  state.position = next;
  updatePlayhead();
  if (resume) play();
}

function updatePlayhead() {
  const ratio = state.duration ? state.position / state.duration : 0;
  elements.playhead.style.left = `${ratio * 100}%`;
  elements.currentTime.textContent = formatTime(state.position);
}

function updateTimelineSize() {
  if (!state.currentProject) return;
  const trackCount = state.currentProject.tracks.length;
  const rowHeight = Math.max(64, Math.min(116, Math.floor((elements.mixer.clientHeight - 44) / trackCount)));
  elements.mixer.style.setProperty('--track-height', `${rowHeight}px`);
  elements.mixer.classList.toggle('is-compact', rowHeight < 96);
  const viewportWidth = Math.max(300, elements.timelineViewport.clientWidth);
  const width = Math.max(viewportWidth, state.duration * 5 * state.zoom);
  elements.timelineContent.style.width = `${Math.ceil(width)}px`;
  renderRuler(width);
  requestAnimationFrame(drawAllWaveforms);
  updatePlayhead();
}

function renderRuler(width) {
  if (!state.duration) {
    elements.timelineRuler.innerHTML = '';
    return;
  }
  const targetMarks = Math.max(2, Math.floor(width / 100));
  const rawInterval = state.duration / targetMarks;
  const candidates = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600];
  const interval = candidates.find((value) => value >= rawInterval) || 900;
  const marks = [];
  for (let time = 0; time <= state.duration; time += interval) {
    marks.push(`<span class="ruler-mark" style="left:${(time / state.duration) * 100}%">${formatTime(time)}</span>`);
  }
  elements.timelineRuler.innerHTML = marks.join('');
  const grid = Math.max(24, (interval / state.duration) * width);
  elements.timelineRuler.style.backgroundSize = `${grid}px 100%`;
  elements.waveformRows.querySelectorAll('.waveform-row').forEach((row) => { row.style.backgroundSize = `${grid}px 100%`; });
}

function drawAllWaveforms() {
  if (!state.currentProject) return;
  elements.waveformRows.querySelectorAll('[data-waveform]').forEach((row) => {
    const buffer = state.buffers.get(row.dataset.waveform);
    if (buffer) drawWaveform(row.querySelector('canvas'), buffer, row.dataset.waveform === state.selectedTrackId);
  });
}

function drawWaveform(canvas, buffer, selected) {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.floor(rect.width));
  const cssHeight = Math.max(1, Math.floor(rect.height));
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(cssWidth * pixelRatio);
  canvas.height = Math.floor(cssHeight * pixelRatio);
  const context = canvas.getContext('2d');
  context.scale(pixelRatio, pixelRatio);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const channels = [];
  for (let index = 0; index < buffer.numberOfChannels; index += 1) channels.push(buffer.getChannelData(index));
  const sampleCount = channels[0].length;
  const samplesPerPixel = Math.max(1, Math.floor(sampleCount / cssWidth));
  const center = cssHeight / 2;
  const amplitude = cssHeight * 0.44;
  const upper = [];
  const lower = [];
  context.fillStyle = selected ? '#063945' : '#4d545c';
  context.globalAlpha = selected ? 0.98 : 0.92;
  for (let x = 0; x < cssWidth; x += 1) {
    const start = x * samplesPerPixel;
    const end = Math.min(sampleCount, start + samplesPerPixel);
    let minimum = 1;
    let maximum = -1;
    const stride = Math.max(1, Math.floor((end - start) / 72));
    for (let sample = start; sample < end; sample += stride) {
      let value = 0;
      for (const channel of channels) value += channel[sample] || 0;
      value /= channels.length;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    upper.push(center - Math.max(0.008, maximum) * amplitude);
    lower.push(center - Math.min(-0.008, minimum) * amplitude);
  }
  context.beginPath();
  context.moveTo(0, upper[0]);
  for (let x = 1; x < cssWidth; x += 1) context.lineTo(x, upper[x]);
  for (let x = cssWidth - 1; x >= 0; x -= 1) context.lineTo(x, lower[x]);
  context.closePath();
  context.fill();
  context.globalAlpha = selected ? 0.28 : 0.18;
  context.fillRect(0, center, cssWidth, 1);
}

function bindEvents() {
  const openButtons = [elements.newProjectNav, elements.newProjectButton, elements.emptyAddButton];
  openButtons.forEach((button) => button.addEventListener('click', openNewProjectDialog));
  [elements.brandButton, elements.libraryNav, elements.backToLibrary].forEach((button) => button.addEventListener('click', showLibrary));
  elements.libraryTab.addEventListener('click', showLibrary);
  elements.newTabButton.addEventListener('click', openNewProjectDialog);
  elements.projectTabs.addEventListener('click', (event) => {
    if (state.suppressTabClick) {
      event.preventDefault();
      return;
    }
    const closeButton = event.target.closest('[data-close-tab]');
    if (closeButton) {
      closeProjectTab(closeButton.dataset.closeTab);
      return;
    }
    const tab = event.target.closest('[data-project-tab]');
    if (tab) openProject(tab.dataset.projectTab);
  });
  const clearTabDropIndicators = () => {
    elements.projectTabs.classList.remove('is-drop-at-end');
    elements.projectTabs.querySelectorAll('.is-drop-before, .is-drop-after').forEach((tab) => {
      tab.classList.remove('is-drop-before', 'is-drop-after');
    });
  };
  const tabDropTargetAt = (sourceId, clientX) => {
    const candidates = [...elements.projectTabs.querySelectorAll('[data-project-tab]')]
      .filter((tab) => tab.dataset.projectTab !== sourceId);
    if (!candidates.length) return null;
    const before = candidates.find((tab) => {
      const rect = tab.getBoundingClientRect();
      return clientX < rect.left + rect.width / 2;
    });
    if (before) return { targetId: before.dataset.projectTab, placeAfter: false, tab: before };
    const last = candidates.at(-1);
    return { targetId: last.dataset.projectTab, placeAfter: true, tab: last };
  };
  const showTabDropTarget = (dropTarget) => {
    clearTabDropIndicators();
    if (!dropTarget) return;
    dropTarget.tab.classList.add(dropTarget.placeAfter ? 'is-drop-after' : 'is-drop-before');
  };
  const startTabPointerDrag = (drag, event) => {
    const bounds = elements.projectTabs.getBoundingClientRect();
    const rect = drag.tab.getBoundingClientRect();
    const preview = drag.tab.cloneNode(true);
    preview.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    preview.classList.add('tab-drag-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.querySelectorAll('button').forEach((button) => { button.tabIndex = -1; });
    Object.assign(preview.style, {
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    document.body.append(preview);
    drag.active = true;
    drag.bounds = bounds;
    drag.originRect = rect;
    drag.pointerOffsetX = event.clientX - rect.left;
    drag.preview = preview;
    drag.tab.classList.add('is-dragging');
    document.body.classList.add('is-reordering-tabs');
    try { elements.projectTabs.setPointerCapture(event.pointerId); } catch (_) { /* Synthetic QA events have no active pointer. */ }
  };
  const moveTabPointerDrag = (event) => {
    const drag = state.tabPointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const distance = event.clientX - drag.startX;
    if (!drag.active && Math.abs(distance) < 5) return;
    if (!drag.active) startTabPointerDrag(drag, event);
    event.preventDefault();
    const minLeft = drag.bounds.left;
    const maxLeft = Math.max(minLeft, drag.bounds.right - drag.originRect.width);
    const left = Math.max(minLeft, Math.min(event.clientX - drag.pointerOffsetX, maxLeft));
    drag.preview.style.transform = `translateX(${left - drag.originRect.left}px)`;
    drag.dropTarget = tabDropTargetAt(drag.projectId, event.clientX);
    showTabDropTarget(drag.dropTarget);
  };
  const finishTabPointerDrag = (event, commit = false) => {
    const drag = state.tabPointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const wasActive = drag.active;
    const dropTarget = drag.dropTarget;
    clearTabDropIndicators();
    drag.tab.classList.remove('is-dragging');
    drag.preview?.remove();
    document.body.classList.remove('is-reordering-tabs');
    if (elements.projectTabs.hasPointerCapture?.(event.pointerId)) {
      elements.projectTabs.releasePointerCapture(event.pointerId);
    }
    state.tabPointerDrag = null;
    if (wasActive) {
      state.suppressTabClick = true;
      window.setTimeout(() => { state.suppressTabClick = false; }, 0);
    }
    if (commit && wasActive && dropTarget) {
      reorderProjectTab(drag.projectId, dropTarget.targetId, dropTarget.placeAfter);
    }
  };
  elements.projectTabs.addEventListener('dragstart', (event) => event.preventDefault());
  elements.projectTabs.addEventListener('pointerdown', (event) => {
    const tab = event.target.closest('[data-project-tab]');
    if (!tab || event.button !== 0 || event.target.closest('[data-close-tab]')) return;
    state.tabPointerDrag = {
      projectId: tab.dataset.projectTab,
      pointerId: event.pointerId,
      startX: event.clientX,
      tab,
      active: false,
      dropTarget: null,
      preview: null,
    };
  });
  window.addEventListener('pointermove', moveTabPointerDrag, { passive: false });
  window.addEventListener('pointerup', (event) => finishTabPointerDrag(event, true));
  window.addEventListener('pointercancel', (event) => finishTabPointerDrag(event, false));
  elements.workspaceTabs.addEventListener('contextmenu', (event) => {
    const tab = event.target.closest('.workspace-tab');
    if (!tab) return;
    event.preventDefault();
    openTabContextMenu(tab.dataset.projectTab || null, event.clientX, event.clientY);
  });
  elements.mixerResizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = state.mixerWidth;
    elements.mixerResizer.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-mixer');
    const move = (moveEvent) => setMixerWidth(startWidth + moveEvent.clientX - startX);
    const finish = (finishEvent) => {
      elements.mixerResizer.removeEventListener('pointermove', move);
      elements.mixerResizer.removeEventListener('pointerup', finish);
      elements.mixerResizer.removeEventListener('pointercancel', finish);
      if (elements.mixerResizer.hasPointerCapture(finishEvent.pointerId)) {
        elements.mixerResizer.releasePointerCapture(finishEvent.pointerId);
      }
      document.body.classList.remove('is-resizing-mixer');
      setMixerWidth(state.mixerWidth, { persist: true });
    };
    elements.mixerResizer.addEventListener('pointermove', move);
    elements.mixerResizer.addEventListener('pointerup', finish);
    elements.mixerResizer.addEventListener('pointercancel', finish);
  });
  elements.mixerResizer.addEventListener('keydown', (event) => {
    const values = {
      ArrowLeft: state.mixerWidth - 12,
      ArrowRight: state.mixerWidth + 12,
      Home: MIXER_WIDTH_MIN,
      End: MIXER_WIDTH_MAX,
    };
    if (!(event.key in values)) return;
    event.preventDefault();
    setMixerWidth(values[event.key], { persist: true });
  });
  [elements.closeDialog, elements.cancelDialog].forEach((button) => button.addEventListener('click', () => elements.dialog.close()));
  elements.audioFileInput.addEventListener('change', () => chooseFile(elements.audioFileInput.files[0]));
  elements.newProjectForm.addEventListener('submit', createProject);
  elements.newProjectForm.querySelectorAll('[name="stemCount"]').forEach((input) => input.addEventListener('change', updateModeAvailability));
  elements.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('is-dragging');
  });
  elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('is-dragging'));
  elements.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('is-dragging');
    chooseFile(event.dataTransfer.files[0]);
  });
  elements.projectSearch.addEventListener('input', (event) => {
    state.search = event.target.value;
    renderProjects();
  });
  elements.projectSort.addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderProjects();
  });
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-filter]').forEach((item) => item.classList.remove('is-active'));
      button.classList.add('is-active');
      state.filter = button.dataset.filter;
      renderProjects();
    });
  });
  const recheck = async () => {
    const ready = await loadRuntime(true);
    toast(ready ? '分离引擎已就绪' : '分离引擎仍未就绪', ready ? 'info' : 'error');
  };
  elements.runtimeRetry.addEventListener('click', recheck);
  elements.runtimeBannerRetry.addEventListener('click', recheck);
  if (!window.desktop?.selectPython) elements.configurePythonButton.classList.add('is-hidden');
  elements.configurePythonButton.addEventListener('click', async () => {
    try {
      const python = await window.desktop.selectPython();
      if (!python) return;
      const result = await api('/api/runtime/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ python }),
      });
      state.runtime = result.runtime;
      await loadRuntime();
      toast(state.runtime.ready ? 'Python 环境已连接' : state.runtime.message, state.runtime.ready ? 'info' : 'error');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  elements.playButton.addEventListener('click', togglePlayback);
  elements.backwardButton.addEventListener('click', () => seekTo(state.position - 10));
  elements.forwardButton.addEventListener('click', () => seekTo(state.position + 10));
  elements.loopButton.addEventListener('click', () => {
    state.isLooping = !state.isLooping;
    elements.loopButton.classList.toggle('is-active', state.isLooping);
  });
  elements.masterVolume.addEventListener('input', (event) => {
    if (state.masterGain) state.masterGain.gain.setTargetAtTime(Number(event.target.value), state.audioContext.currentTime, 0.01);
  });
  elements.playbackRate.addEventListener('change', (event) => {
    const resume = state.isPlaying;
    if (resume) pause();
    state.playbackRate = Number(event.target.value);
    if (resume) play();
  });
  elements.zoomSlider.addEventListener('input', (event) => {
    state.zoom = Number(event.target.value);
    updateTimelineSize();
  });
  elements.playhead.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const resumeAfterDrag = state.isPlaying;
    if (resumeAfterDrag) pause();
    elements.playhead.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const rect = elements.timelineContent.getBoundingClientRect();
      state.position = Math.max(0, Math.min(state.duration, ((moveEvent.clientX - rect.left) / rect.width) * state.duration));
      updatePlayhead();
    };
    const end = () => {
      elements.playhead.removeEventListener('pointermove', move);
      elements.playhead.removeEventListener('pointerup', end);
      if (resumeAfterDrag) play();
    };
    elements.playhead.addEventListener('pointermove', move);
    elements.playhead.addEventListener('pointerup', end);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.project-menu') && !event.target.closest('[data-menu-id]')) closeProjectMenu();
    if (!event.target.closest('.tab-context-menu')) closeTabContextMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && state.currentProject && !event.target.matches('input, select, button')) {
      event.preventDefault();
      togglePlayback();
    }
    if (event.key === 'Escape' && document.querySelector('.tab-context-menu')) {
      closeTabContextMenu();
      return;
    }
    if (event.key === 'Escape' && !elements.dialog.open && state.currentProject) showLibrary();
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      closeTabContextMenu();
      setMixerWidth(state.mixerWidth);
      updateTimelineSize();
    }, 120);
  });
}

async function initialize() {
  refreshIcons();
  bindEvents();
  await Promise.all([loadRuntime(), loadProjects()]);
}

initialize();
