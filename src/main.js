import './style.css';
import {
  BrowserDatamatrixCodeReader,
  ChecksumException,
  FormatException,
  NotFoundException,
} from '@zxing/library';
import { decodeTrackingNumber, formatRawBytes } from './tracking.js';

const DEFAULT_PREFIX = 'DEA';
const DEFAULT_INTERVAL = 500;
const HISTORY_LIMIT = 100;
const HISTORY_STORAGE_KEY = 'stamp-tracking-history';
const STATUS_RESET_DELAY = 900;

document.querySelector('#app').innerHTML = `
  <main class="app-shell">
    <header class="page-header">
      <div>
        <p class="eyebrow">Datamatrix Scanner</p>
        <h1>Briefmarken-Sendungsnummer auslesen</h1>
        <p class="intro">
          Scannt den Datamatrix-Code direkt über eine Kamera und extrahiert die
          Sendungsnummer lokal im Browser.
        </p>
      </div>
    </header>

    <section class="scanner-layout" aria-label="Scannerbereich">
      <div class="video-panel">
        <div class="video-frame video-frame--ready" id="video-frame">
          <video id="camera-feed" autoplay muted playsinline></video>
          <p class="video-overlay" id="video-overlay">Kamera wird vorbereitet…</p>
        </div>
        <div class="status-row">
          <p id="status-message" class="status-message" aria-live="polite">Bereit.</p>
          <p id="error-message" class="error-message" role="alert"></p>
        </div>
      </div>

      <aside class="control-panel">
        <section class="card">
          <h2>Kamera</h2>
          <label class="field">
            <span>Kamera auswählen</span>
            <select id="camera-select" aria-label="Kamera auswählen"></select>
          </label>
        </section>

        <section class="card tracking-card">
          <div class="tracking-card__header">
            <h2>Letzte Sendungsnummer</h2>
            <button id="copy-current" type="button" class="secondary-button" disabled>
              Kopieren
            </button>
          </div>
          <output id="tracking-number" class="tracking-number" aria-live="polite">
            Noch keine gültige Sendungsnummer erkannt.
          </output>
        </section>

        <section class="card">
          <h2>Konfiguration</h2>
          <label class="field">
            <span>Präfix</span>
            <input id="prefix-input" name="prefix" type="text" maxlength="3" value="${DEFAULT_PREFIX}" />
          </label>

          <label class="field">
            <span>Scan-Intervall: <strong id="scan-interval-value">${DEFAULT_INTERVAL} ms</strong></span>
            <input id="scan-interval" type="range" min="100" max="2000" step="100" value="${DEFAULT_INTERVAL}" />
          </label>

          <label class="toggle-field" for="debug-toggle">
            <input id="debug-toggle" type="checkbox" />
            <span>Debug-Modus</span>
          </label>
        </section>
      </aside>
    </section>

    <section class="card debug-panel hidden" id="debug-panel" aria-label="Debug-Informationen">
      <div class="panel-header">
        <h2>Debug</h2>
      </div>
      <pre id="debug-output" class="debug-output">Noch keine Scandaten.</pre>
    </section>

    <section class="card history-panel" aria-label="Scan-Verlauf">
      <div class="panel-header">
        <h2>Scan-Verlauf</h2>
        <p>Bis zu ${HISTORY_LIMIT} eindeutige Einträge, lokal gespeichert.</p>
      </div>
      <ul id="history-list" class="history-list"></ul>
    </section>
  </main>
`;

const elements = {
  cameraFeed: document.querySelector('#camera-feed'),
  cameraSelect: document.querySelector('#camera-select'),
  copyCurrent: document.querySelector('#copy-current'),
  debugOutput: document.querySelector('#debug-output'),
  debugPanel: document.querySelector('#debug-panel'),
  debugToggle: document.querySelector('#debug-toggle'),
  errorMessage: document.querySelector('#error-message'),
  historyList: document.querySelector('#history-list'),
  prefixInput: document.querySelector('#prefix-input'),
  scanInterval: document.querySelector('#scan-interval'),
  scanIntervalValue: document.querySelector('#scan-interval-value'),
  statusMessage: document.querySelector('#status-message'),
  trackingNumber: document.querySelector('#tracking-number'),
  videoFrame: document.querySelector('#video-frame'),
  videoOverlay: document.querySelector('#video-overlay'),
};

const codeReader = new BrowserDatamatrixCodeReader(DEFAULT_INTERVAL);
let history = loadHistory();
let availableCameras = [];
let currentStream = null;
let scanTimer = null;
let scanInProgress = false;
let lastDetectedTrackingNumber = '';
let statusTimeoutId = 0;
let audioContext = null;

renderHistory();
updateScanIntervalLabel();
updateDebugVisibility();
attachEventListeners();
void initialize().catch(() => {
  setError('Die Kamera konnte nicht initialisiert werden.');
  elements.videoOverlay.textContent = 'Kamera konnte nicht initialisiert werden.';
});

async function initialize() {
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
    setError('Dieser Browser unterstützt keinen Kamerazugriff.');
    elements.videoOverlay.textContent = 'Kamerazugriff wird von diesem Browser nicht unterstützt.';
    return;
  }

  await refreshCameraOptions();

  if (availableCameras.length === 0) {
    setError('Keine Kamera verfügbar.');
    elements.videoOverlay.textContent = 'Keine Kamera gefunden.';
    return;
  }

  await startCamera(availableCameras[0].deviceId);
}

function attachEventListeners() {
  elements.cameraSelect.addEventListener('change', async (event) => {
    await startCamera(event.target.value);
  });

  elements.copyCurrent.addEventListener('click', async () => {
    const currentTrackingNumber = getCurrentTrackingNumber();

    if (!currentTrackingNumber) {
      return;
    }

    const copied = await copyToClipboard(currentTrackingNumber);

    if (copied) {
      setStatus('Sendungsnummer kopiert.', 'ready');
    }
  });

  elements.prefixInput.addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  });

  elements.scanInterval.addEventListener('input', () => {
    updateScanIntervalLabel();
    restartScanning();
  });

  elements.debugToggle.addEventListener('change', updateDebugVisibility);

  elements.historyList.addEventListener('click', async (event) => {
    const button = event.target.closest('button');

    if (!button) {
      return;
    }

    const { action, trackingNumber } = button.dataset;

    if (!trackingNumber) {
      return;
    }

    if (action === 'copy') {
      const copied = await copyToClipboard(trackingNumber);

      if (copied) {
        setStatus('Verlaufseintrag kopiert.', 'ready');
      }
    }

    if (action === 'delete') {
      history = history.filter((entry) => entry !== trackingNumber);
      persistHistory();
      renderHistory();
      setStatus('Verlaufseintrag gelöscht.', 'ready');
    }
  });

  navigator.mediaDevices.addEventListener?.('devicechange', async () => {
    const activeDeviceId = getActiveDeviceId();

    await refreshCameraOptions(activeDeviceId);

    if (availableCameras.length === 0) {
      stopCamera();
      setError('Keine Kamera verfügbar.');
      elements.videoOverlay.textContent = 'Keine Kamera gefunden.';
    }
  });
}

async function refreshCameraOptions(preferredDeviceId = '') {
  const devices = await navigator.mediaDevices.enumerateDevices();

  availableCameras = devices.filter((device) => device.kind === 'videoinput');

  elements.cameraSelect.innerHTML = '';
  elements.cameraSelect.disabled = availableCameras.length === 0;

  for (const [index, camera] of availableCameras.entries()) {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Kamera ${index + 1}`;
    option.selected = camera.deviceId === preferredDeviceId;
    elements.cameraSelect.append(option);
  }

  if (!elements.cameraSelect.value && availableCameras[0]) {
    elements.cameraSelect.value = availableCameras[0].deviceId;
  }
}

async function startCamera(deviceId) {
  stopCamera();
  clearError();
  setStatus('Kamera wird gestartet…', 'ready');
  elements.videoOverlay.textContent = 'Kamera wird gestartet…';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        facingMode: deviceId ? undefined : { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    currentStream = stream;
    elements.cameraFeed.srcObject = stream;
    await elements.cameraFeed.play();
    elements.videoOverlay.textContent = '';

    const activeDeviceId = getActiveDeviceId() || deviceId;
    await refreshCameraOptions(activeDeviceId);
    elements.cameraSelect.value = activeDeviceId || elements.cameraSelect.value;

    restartScanning();
    setStatus('Kamera bereit. Scanner läuft.', 'ready');
  } catch (error) {
    handleCameraError(error);
  }
}

function restartScanning() {
  stopScanning();

  if (!currentStream) {
    return;
  }

  const interval = Number(elements.scanInterval.value);
  codeReader.timeBetweenDecodingAttempts = interval;
  scanTimer = window.setInterval(scanCurrentFrame, interval);
  void scanCurrentFrame();
}

function stopScanning() {
  if (scanTimer) {
    window.clearInterval(scanTimer);
    scanTimer = null;
  }
}

async function scanCurrentFrame() {
  if (scanInProgress || !currentStream || elements.cameraFeed.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  scanInProgress = true;

  try {
    const result = codeReader.decode(elements.cameraFeed);
    const rawBytes = getRawBytes(result);

    elements.debugOutput.textContent = `${formatRawBytes(rawBytes)}\n\nText:\n${result.getText() || '(leer)'}`;

    const trackingNumber = decodeTrackingNumber(rawBytes, elements.prefixInput.value || DEFAULT_PREFIX);
    const isNewTrackingNumber = trackingNumber !== lastDetectedTrackingNumber;

    elements.trackingNumber.textContent = trackingNumber;
    elements.copyCurrent.disabled = false;
    clearError();
    setStatus('Gültige Sendungsnummer erkannt.', 'success');
    addToHistory(trackingNumber);

    if (isNewTrackingNumber) {
      playSuccessTone();
    }

    lastDetectedTrackingNumber = trackingNumber;
  } catch (error) {
    if (error instanceof NotFoundException || error instanceof ChecksumException || error instanceof FormatException) {
      return;
    }

    if (error?.name === 'InvalidPrefixError') {
      setError(error.message, 'error');
      return;
    }

    setError(error?.message || 'Der Datamatrix-Code konnte nicht verarbeitet werden.', 'error');
  } finally {
    scanInProgress = false;
  }
}

function stopCamera() {
  stopScanning();
  codeReader.reset();

  if (currentStream) {
    for (const track of currentStream.getTracks()) {
      track.stop();
    }
  }

  currentStream = null;
  elements.cameraFeed.srcObject = null;
}

function getActiveDeviceId() {
  const [track] = currentStream?.getVideoTracks() || [];
  return track?.getSettings?.().deviceId || '';
}

function getRawBytes(result) {
  const rawBytes = result.getRawBytes();

  if (rawBytes instanceof Uint8Array && rawBytes.length > 0) {
    return rawBytes;
  }

  return new TextEncoder().encode(result.getText() || '');
}

function updateScanIntervalLabel() {
  elements.scanIntervalValue.textContent = `${elements.scanInterval.value} ms`;
}

function updateDebugVisibility() {
  elements.debugPanel.classList.toggle('hidden', !elements.debugToggle.checked);
}

function getCurrentTrackingNumber() {
  const value = elements.trackingNumber.textContent?.trim();
  return value && !value.startsWith('Noch keine') ? value : '';
}

function addToHistory(trackingNumber) {
  history = [trackingNumber, ...history.filter((entry) => entry !== trackingNumber)].slice(0, HISTORY_LIMIT);
  persistHistory();
  renderHistory();
}

function renderHistory() {
  elements.historyList.textContent = '';

  if (history.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'history-empty';
    emptyItem.textContent = 'Noch keine Sendungsnummern gespeichert.';
    elements.historyList.append(emptyItem);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const trackingNumber of history) {
    const item = document.createElement('li');
    item.className = 'history-item';

    const value = document.createElement('span');
    value.className = 'history-item__value';
    value.textContent = trackingNumber;

    const actions = document.createElement('div');
    actions.className = 'history-item__actions';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'secondary-button';
    copyButton.dataset.action = 'copy';
    copyButton.dataset.trackingNumber = trackingNumber;
    copyButton.setAttribute('aria-label', `Sendungsnummer ${trackingNumber} kopieren`);
    copyButton.textContent = 'Kopieren';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger-button';
    deleteButton.dataset.action = 'delete';
    deleteButton.dataset.trackingNumber = trackingNumber;
    deleteButton.setAttribute('aria-label', `Sendungsnummer ${trackingNumber} löschen`);
    deleteButton.textContent = 'Löschen';

    actions.append(copyButton, deleteButton);
    item.append(value, actions);
    fragment.append(item);
  }

  elements.historyList.append(fragment);
}

function loadHistory() {
  try {
    const storedHistory = localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsedHistory = storedHistory ? JSON.parse(storedHistory) : [];

    return Array.isArray(parsedHistory)
      ? parsedHistory.filter((entry) => typeof entry === 'string').slice(0, HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function persistHistory() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    setError('Der Verlauf konnte nicht gespeichert werden.');
  }
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'absolute';
    textArea.style.left = '-9999px';
    document.body.append(textArea);
    textArea.select();
    const copied = document.execCommand('copy');
    textArea.remove();
    return copied;
  } catch {
    setError('Kopieren in die Zwischenablage ist fehlgeschlagen.');
    return false;
  }
}

function setStatus(message, state = 'ready') {
  elements.statusMessage.textContent = message;
  elements.videoFrame.className = `video-frame video-frame--${state}`;

  if (statusTimeoutId) {
    window.clearTimeout(statusTimeoutId);
  }

  if (state !== 'ready') {
    statusTimeoutId = window.setTimeout(() => {
      elements.videoFrame.className = 'video-frame video-frame--ready';
    }, STATUS_RESET_DELAY);
  }
}

function setError(message, state = 'error') {
  elements.errorMessage.textContent = message;
  setStatus('Fehler beim Verarbeiten des Codes.', state);
}

function clearError() {
  elements.errorMessage.textContent = '';
}

function handleCameraError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    setError('Kamerazugriff wurde verweigert. Bitte Berechtigung erteilen.');
    elements.videoOverlay.textContent = 'Kamerazugriff verweigert.';
    return;
  }

  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    setError('Keine Kamera verfügbar.');
    elements.videoOverlay.textContent = 'Keine Kamera gefunden.';
    return;
  }

  setError('Die Kamera konnte nicht gestartet werden.');
  elements.videoOverlay.textContent = 'Kamera konnte nicht gestartet werden.';
}

function playSuccessTone() {
  const Context = window.AudioContext || window.webkitAudioContext;

  if (!Context) {
    return;
  }

  audioContext ||= new Context();

  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }

  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const startTime = audioContext.currentTime;

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, startTime);
  gain.gain.setValueAtTime(0.001, startTime);
  gain.gain.exponentialRampToValueAtTime(0.18, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.16);

  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + 0.18);
}
