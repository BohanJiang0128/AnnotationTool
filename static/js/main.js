import { Viewer3D } from './viewer3d.js';

// ── DOM refs ────────────────────────────────────────────────
const elPatientSelect= document.getElementById('patient-select');
const elImageList  = document.getElementById('image-list');
const elPreviewArea= document.getElementById('image-preview-area');
const elPreviewName= document.getElementById('image-preview-name');
const elModelList  = document.getElementById('model-list');
const elModelInfo  = document.getElementById('model-info-box');
const elModelName  = document.getElementById('model-info-name');
const elModelStats = document.getElementById('model-info-stats');
const elViewerCont = document.getElementById('viewer-container');
const elToolCursor = document.getElementById('tool-cursor');
const elToolPen    = document.getElementById('tool-pen');
const elClearBtn   = document.getElementById('clear-btn');
const elBsaBtn     = document.getElementById('bsa-btn');
const elBsaDisplay = document.getElementById('bsa-display');
const elBsaPct     = document.getElementById('bsa-pct');
const elLoadOvl    = document.getElementById('loading-overlay');
const elLoadFill   = document.getElementById('load-progress-fill');
const elNoModel    = document.getElementById('no-model-msg');
const elPenHint    = document.getElementById('pen-hint');
const elSaveStatus = document.getElementById('save-status');
const elSaveText   = document.getElementById('save-status-text');

// ── State ───────────────────────────────────────────────────
let viewer              = null;
let currentModel        = null;   // e.g. "f_1.obj"
let currentPatientFolder = null; 
let currentImage        = null;
let currentAnnotationData= null;
let currentTool         = 'cursor';
let shiftHeld           = false;
let saveTimer           = null;

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  viewer = new Viewer3D(elViewerCont);

  viewer.onLoadProgress = (pct) => {
    elLoadFill.style.width = `${Math.round(pct * 100)}%`;
  };

  viewer.onLoadComplete = async () => {
    elLoadOvl.classList.add('hidden');
    elNoModel.classList.add('hidden');
    if (currentAnnotationData) {
      viewer.loadAnnotationData(currentAnnotationData);
      updateStatsAfterRestore();
    }
  };

  viewer.onLoadError = () => {
    elLoadOvl.classList.add('hidden');
    showToast('Failed to load model.', 'error');
  };

  viewer.onStatsReady = ({ totalFaces }) => {
    elModelStats.textContent = `${totalFaces.toLocaleString()} triangles`;
  };

  viewer.onAnnotationChange = () => debouncedSave();

  loadAssetList();
  initSplitters();
  initImageZoom();

  // ── Tool buttons ──
  elToolCursor.addEventListener('click', () => setTool('cursor'));
  elToolPen.addEventListener('click',    () => setTool('pen'));

  // ── Shift key: temporarily toggle tool ──
  window.addEventListener('keydown', (e) => {
    // Don't intercept when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Shift' && !shiftHeld) {
      shiftHeld = true;
      _applyTool(currentTool === 'cursor' ? 'pen' : 'cursor');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      shiftHeld = false;
      _applyTool(currentTool); // restore actual tool
    }
  });

  // ── Brush size ──
  document.querySelectorAll('.brush-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      viewer?.setBrushSize(btn.dataset.size);
    });
  });

  // ── Clear + BSA ──
  elClearBtn.addEventListener('click', () => {
    viewer.clearAnnotations();
    elBsaDisplay.classList.add('hidden');
  });
  elBsaBtn.addEventListener('click', computeBSA);

  // ── Directory ──
  elPatientSelect.addEventListener('change', () => loadPatientImages(elPatientSelect.value));
  loadPatients();
});

// ── Asset List ──────────────────────────────────────────────
async function loadAssetList() {
  try {
    const data = await apiFetch('/api/assets');
    renderModelList(data.files || []);
  } catch {
    elModelList.innerHTML = '<div class="list-placeholder">Failed to load models.</div>';
  }
}

function renderModelList(files) {
  elModelList.innerHTML = '';
  if (!files.length) {
    elModelList.innerHTML = '<div class="list-placeholder">No .obj files found.</div>';
    return;
  }
  files.forEach((file) => {
    const item = document.createElement('div');
    item.className = 'model-item';
    const gender = file.startsWith('f') ? '👩' : '🧑';
    item.innerHTML = `<span class="model-item-icon">${gender}</span>${file}`;
    item.addEventListener('click', () => selectModel(file, item));
    elModelList.appendChild(item);
  });
}

function selectModel(file, itemEl) {
  document.querySelectorAll('.model-item').forEach(el => el.classList.remove('active'));
  if (itemEl) itemEl.classList.add('active');

  if (currentPatientFolder) {
    fetch(`/api/patients/${encodeURIComponent(currentPatientFolder)}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_model: file })
    }).catch(e => console.warn('Could not save metadata', e));
  }

  if (viewer && currentImage) {
    const existing = viewer.getAnnotationData();
    if (Object.values(existing).some(arr => arr.length > 0)) {
      currentAnnotationData = existing;
    }
  }

  currentModel = file;
  elModelName.textContent   = file;
  elModelStats.textContent  = 'Loading…';
  elModelInfo.style.display = 'block';

  elLoadFill.style.width = '0%';
  elLoadOvl.classList.remove('hidden');
  elBsaDisplay.classList.add('hidden');
  setSaveStatus('idle');

  viewer.loadModel(`/assets/${file}`);
}

// ── Annotations: Load ───────────────────────────────────────
async function loadAnnotationsForImage(imageName) {
  if (!imageName || !currentPatientFolder) return;
  if (viewer) viewer.clearAnnotations();
  currentAnnotationData = null;
  setSaveStatus('idle');
  try {
    const data = await apiFetch(
      `/api/annotations/${encodeURIComponent(currentPatientFolder)}/${encodeURIComponent(imageName)}`
    );
    if (data.meshes && Object.keys(data.meshes).length) {
      currentAnnotationData = data.meshes;
      if (viewer && currentModel) {
        viewer.loadAnnotationData(currentAnnotationData);
        const savedAt = data.savedAt ? new Date(data.savedAt).toLocaleString() : '';
        setSaveStatus('saved', savedAt ? `Loaded: ${savedAt}` : 'Loaded');
        updateStatsAfterRestore();
      }
    }
  } catch (err) {
    if (!err.message.includes('404')) console.warn('Could not load annotations:', err);
  }
}

function updateStatsAfterRestore() {
  const result = viewer.calculateBSA();
  if (!result) return;
  elModelStats.textContent =
    `${result.annotatedFaces.toLocaleString()} / ${result.totalFaces.toLocaleString()} triangles annotated`;
}

// ── Annotations: Save ───────────────────────────────────────
function debouncedSave() {
  setSaveStatus('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAnnotations, 800);
}

async function saveAnnotations() {
  if (!currentImage || !viewer || !currentModel) return;
  const folder = currentPatientFolder;
  setSaveStatus('saving');
  try {
    const meshes = viewer.getAnnotationData();
    const res = await fetch(
      `/api/annotations/${encodeURIComponent(folder)}/${encodeURIComponent(currentImage)}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ meshes }),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setSaveStatus('saved');
  } catch (err) {
    setSaveStatus('error');
    console.error('Save failed:', err);
  }
}

// ── Save Status Badge ───────────────────────────────────────
function setSaveStatus(state, label) {
  if (!elSaveStatus) return;
  elSaveStatus.className = `save-status save-${state}`;
  const icons  = { idle: '', pending: '●', saving: '⟳', saved: '✓', error: '✕' };
  const labels = {
    idle: '', pending: 'Unsaved changes', saving: 'Saving…',
    saved: label || 'Saved', error: 'Save failed',
  };
  elSaveText.textContent = `${icons[state] || ''} ${labels[state] || ''}`.trim();
  elSaveStatus.classList.toggle('hidden', state === 'idle');

  if (state === 'saved') {
    clearTimeout(elSaveStatus._hideTimer);
    elSaveStatus._hideTimer = setTimeout(() => setSaveStatus('idle'), 4000);
  }
}

// ── Patients Directory ──────────────────────────────────────
async function loadPatients() {
  try {
    const data = await apiFetch('/api/patients');
    if (data.error) { showToast(data.error, 'error'); return; }
    data.patients.forEach(pat => {
      const opt = document.createElement('option');
      opt.value = pat; opt.textContent = pat;
      elPatientSelect.appendChild(opt);
    });
  } catch (err) { console.error('Could not load patients:', err); }
}

async function loadPatientImages(patient) {
  if (!patient) return;
  currentPatientFolder = patient;
  currentImage = null;
  elPreviewName.textContent = '';
  elPreviewArea.innerHTML = `<div class="preview-placeholder"><div class="placeholder-icon">🖼</div><span>Select an image</span></div>`;
  if (viewer) viewer.clearAnnotations();
  currentAnnotationData = null;
  setSaveStatus('idle');

  try {
    const data = await apiFetch(`/api/patients/${encodeURIComponent(patient)}/images`);
    if (data.error) { showToast(data.error, 'error'); return; }
    renderImageList(data.files, data.path);

    try {
      const meta = await apiFetch(`/api/patients/${encodeURIComponent(patient)}/metadata`);
      if (meta && meta.last_model) {
        const items = Array.from(document.querySelectorAll('.model-item'));
        const targetItem = items.find(el => el.textContent.includes(meta.last_model));
        selectModel(meta.last_model, targetItem || document.createElement('div'));
      }
    } catch (ignore) {}

  } catch (err) {
    showToast('Could not load directory: ' + err.message, 'error');
  }
}

function renderImageList(files, basePath) {
  elImageList.innerHTML = '';
  if (!files.length) {
    elImageList.innerHTML = '<div class="list-placeholder">No images found in this directory.</div>';
    return;
  }
  files.forEach((file) => {
    const item    = document.createElement('div');
    item.className = 'image-item';
    const imgUrl  = `/api/image?path=${encodeURIComponent(basePath + '/' + file)}`;
    item.innerHTML = `
      <img class="image-thumb" src="${imgUrl}" loading="lazy" alt="${file}">
      <span class="image-name" title="${file}">${file}</span>`;
    item.addEventListener('click', () => selectImage(file, imgUrl, item));
    elImageList.appendChild(item);
  });
}

function selectImage(file, url, itemEl) {
  document.querySelectorAll('.image-item').forEach(el => el.classList.remove('active'));
  itemEl.classList.add('active');
  currentImage = file;
  elPreviewArea.innerHTML = `<img src="${url}" alt="${file}">`;
  elPreviewName.textContent = file;
  resetImgZoom(false); // reset without animation on new image load
  
  loadAnnotationsForImage(file);
}

// ── Tool Selection ──────────────────────────────────────────
/** Permanently switches the active tool and updates state + UI. */
function setTool(tool) {
  currentTool = tool;
  _applyTool(tool);
}

/** Applies tool to viewer + updates UI without changing currentTool state.
 *  Used for temporary Shift-toggle. */
function _applyTool(tool) {
  viewer?.setTool(tool);
  elToolCursor.classList.toggle('active', tool === 'cursor');
  elToolPen.classList.toggle('active',    tool === 'pen');
  elPenHint.classList.toggle('hidden', tool !== 'pen');
}

// ── BSA ─────────────────────────────────────────────────────
function computeBSA() {
  if (!viewer) return;
  const result = viewer.calculateBSA();
  if (!result) { showToast('Load a model first.', 'error'); return; }

  elBsaPct.textContent = result.percentage.toFixed(2) + '%';
  elBsaDisplay.classList.remove('hidden');
  elModelStats.textContent =
    `${result.annotatedFaces.toLocaleString()} / ${result.totalFaces.toLocaleString()} triangles annotated`;
}

// ── Helpers ─────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showToast(msg, type = 'info') {
  const el  = document.createElement('div');
  const bg  = type === 'error' ? 'rgba(239,68,68,0.15)' : 'rgba(0,180,255,0.1)';
  const bdr = type === 'error' ? 'rgba(239,68,68,0.4)'  : 'rgba(0,180,255,0.3)';
  const clr = type === 'error' ? '#fca5a5'               : '#7dd3fc';
  el.style.cssText = `
    position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
    background:${bg}; border:1px solid ${bdr}; color:${clr};
    font-size:13px; padding:10px 20px; border-radius:10px;
    z-index:999; backdrop-filter:blur(8px); font-family:inherit; white-space:nowrap;
  `;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Splitter Resize ──────────────────────────────────────────
function initSplitters() {
  document.querySelectorAll('.splitter').forEach((splitter) => {
    const leftId  = splitter.dataset.left;
    const rightId = splitter.dataset.right;
    // data-left  → resize the panel to the LEFT  of the splitter  (grow on right-drag)
    // data-right → resize the panel to the RIGHT of the splitter  (shrink on right-drag)
    const panelId  = leftId || rightId;
    const growsRight = !!leftId;

    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const panel  = document.getElementById(panelId);
      const startX = e.clientX;
      const startW = panel.offsetWidth;

      splitter.classList.add('is-dragging');
      document.body.style.cursor    = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const dx   = e.clientX - startX;
        const newW = Math.max(
          parseInt(getComputedStyle(panel).minWidth) || 100,
          startW + dx * (growsRight ? 1 : -1)
        );
        panel.style.flex = `0 0 ${newW}px`;
      }

      function onUp() {
        splitter.classList.remove('is-dragging');
        document.body.style.cursor    = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });
}

// ── Image Zoom / Pan ─────────────────────────────────────────
let imgZoom   = 1;
let imgPanX   = 0;
let imgPanY   = 0;
let imgRotate = 0;
let zoomBadgeTimer = null;
const elZoomBadge  = document.getElementById('zoom-badge');

function currentPreviewImg() {
  return elPreviewArea.querySelector('img');
}

function applyImgTransform(animate = false) {
  const img = currentPreviewImg();
  if (!img) return;
  img.style.transition = animate ? 'transform 0.22s ease' : 'none';
  img.style.transform  = `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom}) rotate(${imgRotate}deg)`;

  // Cursor hint
  elPreviewArea.style.cursor = imgZoom > 1.01 ? 'grab' : 'default';

  // Zoom badge
  if (elZoomBadge) {
    elZoomBadge.textContent = Math.round(imgZoom * 100) + '%';
    elZoomBadge.classList.remove('hidden');
    clearTimeout(zoomBadgeTimer);
    zoomBadgeTimer = setTimeout(() => elZoomBadge.classList.add('hidden'), 1400);
  }
}

function resetImgZoom(animate = true) {
  imgZoom = 1; imgPanX = 0; imgPanY = 0; imgRotate = 0;
  applyImgTransform(animate);
  if (elZoomBadge) elZoomBadge.classList.add('hidden');
}

function initImageZoom() {
  // Prevent context menu
  elPreviewArea.addEventListener('contextmenu', e => e.preventDefault());

  // Scroll to zoom
  elPreviewArea.addEventListener('wheel', (e) => {
    if (!currentPreviewImg()) return;
    e.preventDefault();

    const factor = e.deltaY < 0 ? 1.13 : 1 / 1.13;
    const rect   = elPreviewArea.getBoundingClientRect();
    // Cursor position relative to container center
    const cx = e.clientX - rect.left  - rect.width  / 2;
    const cy = e.clientY - rect.top   - rect.height / 2;

    // Adjust pan so the point under the cursor stays fixed
    imgPanX = cx - (cx - imgPanX) * factor;
    imgPanY = cy - (cy - imgPanY) * factor;
    imgZoom = Math.max(0.25, Math.min(16, imgZoom * factor));
    applyImgTransform(false);
  }, { passive: false });

  // Drag to pan or rotate
  elPreviewArea.addEventListener('mousedown', (e) => {
    if (!currentPreviewImg()) return;
    
    // Left-click to pan
    if (e.button === 0 && imgZoom > 1.01) {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const spx = imgPanX, spy = imgPanY;
      elPreviewArea.style.cursor = 'grabbing';

      const onMove = (e) => {
        imgPanX = spx + (e.clientX - sx);
        imgPanY = spy + (e.clientY - sy);
        applyImgTransform(false);
      };

      const onUp = () => {
        elPreviewArea.style.cursor = imgZoom > 1.01 ? 'grab' : 'default';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    }
    // Right-click to rotate
    else if (e.button === 2) {
      e.preventDefault();
      const sx = e.clientX;
      const sr = imgRotate;
      elPreviewArea.style.cursor = 'ew-resize';

      const onMove = (e) => {
        imgRotate = sr + (e.clientX - sx) * 0.4;
        applyImgTransform(false);
      };

      const onUp = () => {
        elPreviewArea.style.cursor = imgZoom > 1.01 ? 'grab' : 'default';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    }
  });

  // Double-click to reset
  elPreviewArea.addEventListener('dblclick', () => resetImgZoom(true));
}

