const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

let mainWindow = null;
let serverProcess = null;
let serverPort = null;
let isQuitting = false;

app.setAppUserModelId('studio.spleeter.desktop');
if (process.env.SPLEETER_STUDIO_QA_SCREENSHOT_DIR) app.disableHardwareAcceleration();
if (process.env.SPLEETER_STUDIO_QA_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.SPLEETER_STUDIO_QA_USER_DATA));
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), line, 'utf8');
  } catch (_) {
    // Logging must never keep the app from opening.
  }
}

function getPaths() {
  if (app.isPackaged) {
    return {
      server: path.join(process.resourcesPath, 'studio', 'server.py'),
      workingDirectory: path.join(process.resourcesPath, 'studio'),
      icon: path.join(process.resourcesPath, 'app.asar', 'assets', 'icon.png'),
    };
  }
  const root = path.resolve(__dirname, '..');
  return {
    server: path.join(root, 'server.py'),
    workingDirectory: root,
    icon: path.join(root, 'assets', 'icon.png'),
  };
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 8765;
      probe.close(() => resolve(port));
    });
  });
}

function pythonCandidates() {
  const configured = process.env.SPLEETER_STUDIO_SERVER_PYTHON;
  const values = [];
  if (configured) values.push({ command: configured, prefix: [] });
  const roformerPython = process.env.ROFORMER_PYTHON || 'D:\\Anaconda\\envs\\SpleeterRoFormer\\python.exe';
  if (fs.existsSync(roformerPython)) values.push({ command: roformerPython, prefix: [] });
  if (process.platform === 'win32') values.push({ command: 'py', prefix: ['-3'] });
  values.push({ command: 'python', prefix: [] });
  return values;
}

function spawnCandidate(candidate, serverPath, dataPath, modelPath, port, cwd) {
  const args = [
    ...candidate.prefix,
    serverPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--data-dir',
    dataPath,
    '--model-dir',
    modelPath,
  ];
  const child = spawn(candidate.command, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  child.stdout.on('data', (chunk) => appendLog(`server: ${String(chunk).trimEnd()}`));
  child.stderr.on('data', (chunk) => appendLog(`server error: ${String(chunk).trimEnd()}`));
  return child;
}

function getModelPath() {
  if (process.env.ROFORMER_MODEL_DIR || process.env.SPLEETER_STUDIO_MODEL_DIR) {
    return path.resolve(process.env.ROFORMER_MODEL_DIR || process.env.SPLEETER_STUDIO_MODEL_DIR);
  }
  if (process.platform === 'win32') {
    for (const models of ['E:\\Spleeter\\RoFormerModels', 'E:\\Spleeter\\experiments\\roformer-rtx3050\\models']) {
      if (fs.existsSync(models)) return models;
    }
  }
  return path.join(app.getPath('userData'), 'roformer_models');
}

function waitForHealth(port, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(`http://127.0.0.1:${port}/api/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });
      request.setTimeout(1000, () => request.destroy());
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('后台服务启动超时'));
      } else {
        setTimeout(check, 250);
      }
    };
    check();
  });
}

async function startServer() {
  const paths = getPaths();
  const dataPath = process.env.SPLEETER_STUDIO_DATA || path.join(app.getPath('userData'), 'projects');
  const modelPath = getModelPath();
  fs.mkdirSync(dataPath, { recursive: true });
  serverPort = await getOpenPort();
  appendLog(`using model directory ${modelPath}`);

  let lastError = null;
  for (const candidate of pythonCandidates()) {
    appendLog(`starting server with ${candidate.command}`);
    const child = spawnCandidate(candidate, paths.server, dataPath, modelPath, serverPort, paths.workingDirectory);
    const spawnResult = await new Promise((resolve) => {
      let settled = false;
      child.once('spawn', () => {
        if (!settled) {
          settled = true;
          resolve({ ok: true });
        }
      });
      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, error });
        }
      });
    });
    if (!spawnResult.ok) {
      lastError = spawnResult.error;
      appendLog(`python candidate failed: ${String(lastError)}`);
      continue;
    }
    serverProcess = child;
    try {
      await waitForHealth(serverPort);
      return;
    } catch (error) {
      lastError = error;
      stopServer();
    }
  }
  throw lastError || new Error('未找到可运行的 Python 3');
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  const pid = serverProcess.pid;
  if (process.platform === 'win32' && pid) {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.unref();
  } else {
    serverProcess.kill('SIGTERM');
  }
  serverProcess = null;
}

function createWindow() {
  const paths = getPaths();
  const qaProject = process.env.SPLEETER_STUDIO_QA_PROJECT;
  const qaScreenshot = process.env.SPLEETER_STUDIO_QA_SCREENSHOT;
  const qaScreenshotDir = process.env.SPLEETER_STUDIO_QA_SCREENSHOT_DIR;
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b0e10',
    title: 'Spleeter Studio',
    icon: paths.icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !qaScreenshotDir,
    },
  });

  const projectHash = qaProject ? `#project=${encodeURIComponent(qaProject)}` : '';
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/${projectHash}`);
  mainWindow.once('ready-to-show', () => {
    if (!qaScreenshotDir) mainWindow.show();
  });
  if (qaScreenshotDir) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          fs.mkdirSync(qaScreenshotDir, { recursive: true });
          await mainWindow.webContents.executeJavaScript('Promise.all([loadRuntime(), loadProjects({quiet:true})])');
          const captureScreenshot = async (filename) => {
            // A hidden QA window needs a capture to request a fresh compositor frame.
            await mainWindow.webContents.capturePage(undefined, {stayHidden:true});
            await new Promise(resolve => setTimeout(resolve, 200));
            const image = await mainWindow.webContents.capturePage(undefined, {stayHidden:true});
            fs.writeFileSync(path.join(qaScreenshotDir, filename), image.toPNG());
          };
          await captureScreenshot('library.png');
          const dialog = await mainWindow.webContents.executeJavaScript(`(() => {
            openNewProjectDialog();
            return { ready: state.runtime?.ready, engine: state.runtime?.engine,
              modes: [...document.querySelectorAll('[name="stemCount"]')].map(input => ({value: Number(input.value), disabled: input.disabled})) };
          })()`);
          await captureScreenshot('new-project.png');
          if (!dialog.ready || dialog.engine !== 'roformer' || dialog.modes.length !== 4 || dialog.modes.some(mode => mode.disabled)) {
            throw new Error('RoFormer modes were not available: ' + JSON.stringify(dialog));
          }
          mainWindow.webContents.setAudioMuted(true);
          const playback = await mainWindow.webContents.executeJavaScript(`(async () => {
            elements.dialog.close();
            const project = state.projects.find(item => item.status === 'ready' && item.stemCount === 6);
            if (!project) throw new Error('No six-track QA project');
            await openProject(project.id);
            await openProject(project.id);
            const matchingTabs = [...document.querySelectorAll('[data-project-tab]')]
              .filter(tab => tab.dataset.projectTab === project.id).length;
            const studioSidebarHidden = getComputedStyle(document.querySelector('.sidebar')).display === 'none'
              && document.querySelector('#appShell').getBoundingClientRect().left === 0;
            setMixerWidth(999);
            const maximumMixerWidth = state.mixerWidth;
            setMixerWidth(1);
            const minimumMixerWidth = state.mixerWidth;
            setMixerWidth(286);
            const unrenderedIcons = document.querySelectorAll('i[data-lucide]').length;
            await play();
            await new Promise(resolve => setTimeout(resolve, 900));
            const nodes = state.nodes.size;
            const advanced = state.position;
            document.querySelector('[data-channel="vocals"] .solo').click();
            const soloGains = [...state.channelState.keys()].map(effectiveVolume);
            document.querySelector('[data-channel="vocals"] .mute').click();
            const muteGains = [...state.channelState.keys()].map(effectiveVolume);
            document.querySelector('[data-channel="vocals"] .mute').click();
            document.querySelector('[data-channel="vocals"] .solo').click();
            const pan = document.querySelector('[data-channel="guitar"] .track-pan');
            pan.value = '-0.5'; pan.dispatchEvent(new Event('input', {bubbles:true}));
            elements.playbackRate.value = '1.25';
            elements.playbackRate.dispatchEvent(new Event('change', {bubbles:true}));
            pause(); seekTo(5);
            await Promise.resolve();
            const pending = play(); pause(); await pending;
            const pauseCanceledPendingPlay = !state.isPlaying && state.nodes.size === 0;
            drawAllWaveforms();
            return {projectId: project.id, matchingTabs, studioSidebarHidden, maximumMixerWidth, minimumMixerWidth, unrenderedIcons,
              tracks: state.buffers.size, nodes, advanced,
              soloGains, muteGains, guitarPan: state.channelState.get('guitar').pan,
              speed: state.playbackRate, position: state.position, pauseCanceledPendingPlay,
              canvases: [...elements.waveformRows.querySelectorAll('canvas')].map(canvas => ({width: canvas.width, height: canvas.height,
                painted: canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((value,index) => index % 4 === 3 && value > 0)}))};
          })()`, true);
          if (playback.matchingTabs !== 1 || !playback.studioSidebarHidden || playback.maximumMixerWidth !== 500 || playback.minimumMixerWidth !== 250 ||
              playback.unrenderedIcons !== 0 || playback.tracks !== 6 || playback.nodes !== 6 || playback.advanced <= 0 ||
              playback.soloGains.filter(gain => gain > 0).length !== 1 || playback.muteGains.some(gain => gain > 0) ||
              playback.guitarPan !== -0.5 || playback.speed !== 1.25 || playback.position !== 5 ||
              !playback.pauseCanceledPendingPlay ||
              playback.canvases.some(canvas => canvas.width < 100 || canvas.height < 10 || !canvas.painted)) {
            throw new Error('Six-track playback check failed: ' + JSON.stringify(playback));
          }
          await captureScreenshot('studio.png');
          await mainWindow.webContents.executeJavaScript('setMixerWidth(500)');
          await captureScreenshot('studio-mixer-max.png');
          await mainWindow.webContents.executeJavaScript('setMixerWidth(250)');
          await captureScreenshot('studio-mixer-min.png');
          await mainWindow.webContents.executeJavaScript('setMixerWidth(286)');
          const libraryTransition = await mainWindow.webContents.executeJavaScript(`(async () => {
            const cacheEntry = state.projectAudioCache.get(${JSON.stringify(playback.projectId)});
            const cachedBuffers = state.buffers;
            showLibrary();
            const sidebar = document.querySelector('.sidebar');
            const sidebarVisible = getComputedStyle(sidebar).display !== 'none' && sidebar.getBoundingClientRect().width > 0;
            await openProject(${JSON.stringify(playback.projectId)});
            return {sidebarVisible,
              cacheReused: state.projectAudioCache.get(${JSON.stringify(playback.projectId)}) === cacheEntry
                && state.buffers === cachedBuffers,
              loadingSkipped: elements.studioLoading.classList.contains('is-hidden')
                && !elements.mixer.classList.contains('is-hidden')};
          })()`);
          if (!libraryTransition.sidebarVisible || !libraryTransition.cacheReused || !libraryTransition.loadingSkipped) {
            throw new Error('Cached library transition failed: ' + JSON.stringify(libraryTransition));
          }
          mainWindow.setSize(1040, 700);
          await new Promise(resolve => setTimeout(resolve, 400));
          const compact = await mainWindow.webContents.executeJavaScript(`(() => {
            updateTimelineSize(); drawAllWaveforms();
            const strips = [...elements.channelStrips.children].map(strip => strip.getBoundingClientRect().toJSON());
            const mixer = elements.mixer.getBoundingClientRect().toJSON();
            return {count: strips.length, lastBottom: strips.at(-1).bottom, mixerBottom: mixer.bottom,
              trackHeight: getComputedStyle(elements.mixer).getPropertyValue('--track-height')};
          })()`);
          await captureScreenshot('studio-compact.png');
          if (compact.count !== 6 || compact.lastBottom > compact.mixerBottom + 1) {
            throw new Error('Six tracks do not fit the minimum window size: ' + JSON.stringify(compact));
          }
          const tabNavigation = await mainWindow.webContents.executeJavaScript(`(async () => {
            const original = state.projects.find(project => project.id === ${JSON.stringify(playback.projectId)});
            const syntheticId = original.id + '-qa-second-tab';
            const synthetic = {...original, id: syntheticId, title: 'QA 第二个标签'};
            state.projects.push(synthetic);
            const originalEntry = state.projectAudioCache.get(original.id);
            const syntheticEntry = {
              buffers: new Map(originalEntry.buffers),
              channelState: new Map([...originalEntry.channelState].map(([id, channel]) => [id, {...channel}])),
              selectedTrackId: originalEntry.selectedTrackId,
              position: 0,
              duration: originalEntry.duration,
              status: 'ready',
              disposed: false,
              promise: null,
            };
            syntheticEntry.promise = Promise.resolve(syntheticEntry);
            state.projectAudioCache.set(syntheticId, syntheticEntry);
            await openProject(syntheticId);
            await openProject(original.id);
            const hadTwoProjectTabs = document.querySelectorAll('[data-project-tab]').length === 2;
            const switchedWithoutReloading = state.projectAudioCache.get(original.id) === originalEntry
              && state.buffers === originalEntry.buffers
              && elements.studioLoading.classList.contains('is-hidden');
            const sourceTab = document.querySelector('[data-project-tab="' + syntheticId + '"]');
            const targetTab = document.querySelector('[data-project-tab="' + original.id + '"]');
            const sourceRect = sourceTab.getBoundingClientRect();
            const targetRect = targetTab.getBoundingClientRect();
            const pointerId = 41;
            sourceTab.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true,
              pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
              clientX: sourceRect.left + sourceRect.width / 2, clientY: sourceRect.top + sourceRect.height / 2}));
            window.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, cancelable: true,
              pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
              clientX: targetRect.left + 2, clientY: targetRect.bottom + 220}));
            const dragPreview = document.querySelector('.tab-drag-preview');
            const previewRect = dragPreview?.getBoundingClientRect();
            const xAxisLocked = Boolean(previewRect)
              && Math.abs(previewRect.top - sourceRect.top) < 1
              && Math.abs(previewRect.height - sourceRect.height) < 1;
            const nativeDragDisabled = !sourceTab.hasAttribute('draggable') && !sourceTab.draggable;
            window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, cancelable: true,
              pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0,
              clientX: targetRect.left + 2, clientY: targetRect.bottom + 220}));
            const reorderedIds = [...state.openProjectIds];
            const reorderedDomIds = [...document.querySelectorAll('#projectTabs [data-project-tab]')]
              .map(tab => tab.dataset.projectTab);
            const dragReordered = reorderedIds[0] === syntheticId && reorderedIds[1] === original.id
              && JSON.stringify(reorderedIds) === JSON.stringify(reorderedDomIds)
              && elements.workspaceTabs.firstElementChild === elements.libraryTab;
            reorderProjectTab(syntheticId, original.id, true);
            await openProject(syntheticId);
            closeProjectTab(syntheticId);
            const returnedToPreviousTab = state.currentProject?.id === original.id
              && state.openProjectIds.length === 1 && state.openProjectIds[0] === original.id
              && state.projectAudioCache.get(original.id) === originalEntry
              && !state.projectAudioCache.has(syntheticId);
            state.projects = state.projects.filter(project => project.id !== syntheticId);
            renderWorkspaceTabs();
            const tab = document.querySelector('[data-project-tab="' + original.id + '"]');
            const tabStyle = getComputedStyle(tab.querySelector('.tab-title'));
            const transportStyle = getComputedStyle(elements.transportTitle);
            const matchingTitleFont = tabStyle.fontFamily === transportStyle.fontFamily
              && tabStyle.fontSize === transportStyle.fontSize
              && tabStyle.fontWeight === transportStyle.fontWeight
              && tabStyle.lineHeight === transportStyle.lineHeight
              && tabStyle.letterSpacing === transportStyle.letterSpacing;
            tab.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 420, clientY: 28}));
            const menu = document.querySelector('.tab-context-menu');
            return {hadTwoProjectTabs, switchedWithoutReloading, dragReordered, xAxisLocked, nativeDragDisabled, reorderedIds,
              returnedToPreviousTab, matchingTitleFont,
              labels: [...menu.querySelectorAll('button')].map(button => button.textContent.trim()),
              closeEnabled: !menu.querySelector('[data-tab-action="close"]').disabled};
          })()`);
          await captureScreenshot('studio-tab-context-menu.png');
          const tabClosing = await mainWindow.webContents.executeJavaScript(`(() => {
            closeTabContextMenu();
            elements.libraryTab.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 50, clientY: 28}));
            const homeMenu = document.querySelector('.tab-context-menu');
            const homeHasFullMenu = homeMenu.querySelectorAll('button').length === 4
              && homeMenu.querySelector('[data-tab-action="close"]').disabled;
            closeTabContextMenu();
            const projectTab = document.querySelector('[data-project-tab="' + ${JSON.stringify(playback.projectId)} + '"]');
            projectTab.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 420, clientY: 28}));
            document.querySelector('[data-tab-action="close-all"]').click();
            const sidebar = document.querySelector('.sidebar');
            return {homeHasFullMenu, allTabsClosed: !state.currentProject && state.openProjectIds.length === 0,
              audioCacheCleared: state.projectAudioCache.size === 0,
              sidebarVisible: getComputedStyle(sidebar).display !== 'none' && sidebar.getBoundingClientRect().width > 0};
          })()`);
          const expectedTabMenu = ['关闭标签页', '关闭其他标签页', '关闭右侧标签页', '关闭全部标签页'];
          if (!tabNavigation.hadTwoProjectTabs || !tabNavigation.switchedWithoutReloading || !tabNavigation.dragReordered
              || !tabNavigation.xAxisLocked || !tabNavigation.nativeDragDisabled
              || !tabNavigation.returnedToPreviousTab || !tabNavigation.matchingTitleFont || !tabNavigation.closeEnabled
              || JSON.stringify(tabNavigation.labels) !== JSON.stringify(expectedTabMenu)
              || !tabClosing.homeHasFullMenu || !tabClosing.allTabsClosed || !tabClosing.audioCacheCleared
              || !tabClosing.sidebarVisible) {
            throw new Error('Browser-style tab behavior failed: ' + JSON.stringify({tabNavigation, tabClosing}));
          }
          fs.writeFileSync(path.join(qaScreenshotDir, 'ui-report.json'), JSON.stringify({status: 'success', dialog, playback, compact, libraryTransition, tabNavigation, tabClosing}, null, 2));
          appendLog(`QA screenshots and playback checks saved: ${qaScreenshotDir}`);
          app.quit();
        } catch (error) {
          appendLog(`QA screenshots failed: ${error.stack || error}`);
          fs.writeFileSync(path.join(qaScreenshotDir, 'ui-report.json'), JSON.stringify({status:'failed', error:String(error)}, null, 2));
          app.quit();
        }
      }, 1200);
    });
  } else if (qaScreenshot) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(qaScreenshot, image.toPNG());
          appendLog(`QA screenshot saved: ${qaScreenshot}`);
        } catch (error) {
          appendLog(`QA screenshot failed: ${error.stack || error}`);
        } finally {
          app.quit();
        }
      }, qaProject ? 3500 : 1200);
    });
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('select-python', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 RoFormer Python（SpleeterRoFormer 环境）',
    properties: ['openFile'],
    filters: [{ name: 'Python', extensions: ['exe'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  try {
    await session.defaultSession.setProxy({ mode: 'direct' });
    await startServer();
    createWindow();
  } catch (error) {
    appendLog(`fatal: ${error.stack || error}`);
    dialog.showErrorBox(
      'Spleeter Studio 无法启动',
      `后台服务启动失败。请确认已安装 Python 3。\n\n${error.message || error}`,
    );
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isQuitting) app.quit();
});
