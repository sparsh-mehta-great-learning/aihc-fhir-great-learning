/**
 * EpicCare Dashboard — EPIC EHR-style interface
 * Connects to HAPI FHIR R4 server + n8n plugin registry
 *
 * ═══════════════════════════════════════════════════════════════
 *  ORIGINAL: n8n PLUGIN REGISTRY (Risk Score, Care Gaps, etc.)
 * ═══════════════════════════════════════════════════════════════
 *  Any n8n workflow can register a new panel in this dashboard.
 *  The dashboard polls GET /webhook/list-panels every 30 seconds
 *  and injects sidebar links + content panels for each plugin.
 *
 * ═══════════════════════════════════════════════════════════════
 *  NEW FEATURE 1: Manual Data Entry
 *    → Add/update labs, vitals, medications, conditions, allergies
 *    → Posts directly to FHIR server
 *    → Missing fields retain previous FHIR value with original date
 *
 *  NEW FEATURE 2: PDF Report Upload via n8n
 *    → Sends PDF as base64 to POST /webhook/process-report
 *    → n8n extracts values and returns structured FHIR resources
 *    → Merges: fields absent in new report keep previous FHIR value
 *    → n8n workflow receives: { patientId, fhirBase, reportType,
 *        keepPrevious, showDates, pdfBase64, filename }
 *    → n8n workflow returns: { extracted: [...], summary: "...",
 *        reportDate: "...", resources: [...FHIR resources...] }
 *
 *  NEW FEATURE 3: Live Doctor–Patient Consultation
 *    → Dual-speaker transcript (doctor / patient)
 *    → Web Speech API for real microphone input (with text fallback)
 *    → POST /webhook/generate-clinical-notes → SOAP clinical notes
 *    → POST /webhook/extract-chart-updates   → structured FHIR updates
 *    → Both results rendered inline; doctor clicks to apply to chart
 * ═══════════════════════════════════════════════════════════════
 */

const FHIR_BASE = `${window.location.origin}/api/fhir`;
const N8N_BASE  = `${window.location.origin}/api/n8n`;
const POLL_MS   = 30000;

let selectedPatient = null;
const patientCache  = new Map();
const pluginRegistry = new Map();

// ─── DOM REFS ──────────────────────────────────────────────────
const elements = {
  currentDate:           document.getElementById('currentDate'),
  patientSearch:         document.getElementById('patientSearch'),
  searchBtn:             document.getElementById('searchBtn'),
  addPatientBtn:         document.getElementById('addPatientBtn'),
  patientList:           document.getElementById('patientList'),
  patientListSection:    document.getElementById('patientListSection'),
  patientChartSection:   document.getElementById('patientChartSection'),
  patientBanner:         document.getElementById('patientBanner'),
  bannerMRN:             document.getElementById('bannerMRN'),
  bannerName:            document.getElementById('bannerName'),
  bannerDOB:             document.getElementById('bannerDOB'),
  bannerAge:             document.getElementById('bannerAge'),
  bannerSex:             document.getElementById('bannerSex'),
  bannerPhone:           document.getElementById('bannerPhone'),
  editPatientBtn:        document.getElementById('editPatientBtn'),
  deletePatientBtn:      document.getElementById('deletePatientBtn'),
  clearPatientBtn:       document.getElementById('clearPatientBtn'),
  patientModal:          document.getElementById('patientModal'),
  patientModalTitle:     document.getElementById('patientModalTitle'),
  patientForm:           document.getElementById('patientForm'),
  closePatientModal:     document.getElementById('closePatientModal'),
  cancelPatientModal:    document.getElementById('cancelPatientModal'),
  savePatientBtn:        document.getElementById('savePatientBtn'),
  loadingOverlay:        document.getElementById('loadingOverlay'),
  dynamicPluginLinks:    document.getElementById('dynamicPluginLinks'),
  dynamicPanelContainer: document.getElementById('dynamicPanelContainer'),
  refreshPluginsBtn:     document.getElementById('refreshPluginsBtn'),
  pluginStatus:          document.getElementById('pluginStatus'),
};

// ─── BOOT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setCurrentDate();
  bindEvents();
  loadInitialPatients();
  pollPluginRegistry();
  setInterval(pollPluginRegistry, POLL_MS);
  initManualEntry();
  initPdfUpload();
  initLiveConsult();
});

function setCurrentDate() {
  if (elements.currentDate) {
    elements.currentDate.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    });
  }
}

function bindEvents() {
  elements.searchBtn?.addEventListener('click', handleSearch);
  elements.patientSearch?.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleSearch(); });
  elements.clearPatientBtn?.addEventListener('click', clearPatient);
  elements.addPatientBtn?.addEventListener('click', openAddPatientModal);
  elements.editPatientBtn?.addEventListener('click', openEditPatientModal);
  elements.deletePatientBtn?.addEventListener('click', deletePatient);
  elements.closePatientModal?.addEventListener('click', closePatientModal);
  elements.cancelPatientModal?.addEventListener('click', closePatientModal);
  elements.savePatientBtn?.addEventListener('click', savePatient);
  elements.patientModal?.querySelector('.epic-modal-overlay')?.addEventListener('click', closePatientModal);
  elements.refreshPluginsBtn?.addEventListener('click', () => pollPluginRegistry(true));

  document.querySelectorAll('.activity-item[data-tab]').forEach((item) => {
    item.addEventListener('click', (e) => { e.preventDefault(); switchTab(item.dataset.tab); });
  });
}

// ═══════════════════════════════════════════════════════════════
//  ORIGINAL: PLUGIN REGISTRY (Risk Score, Care Gaps, etc.)
// ═══════════════════════════════════════════════════════════════

async function pollPluginRegistry(manual = false) {
  try {
    const res = await fetch(`${N8N_BASE}/webhook/list-panels`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const payload = Array.isArray(raw) ? raw[0] : raw;
    const panels = Array.isArray(payload.panels) ? payload.panels : [];
    reconcilePlugins(panels);
    setN8nConnectionStatus(true, panels.length);
    if (manual) setPluginStatus(`${panels.length} plugin(s) loaded`, 'ok');
  } catch (err) {
    setN8nConnectionStatus(false, 0);
    if (manual) setPluginStatus('Cannot reach n8n — is it running?', 'warn');
  }
}

function setN8nConnectionStatus(online, count) {
  // Show a subtle status dot in the AI Features section label
  const label = document.querySelector('#aiSection .activity-label');
  if (!label) return;
  let dot = document.getElementById('n8nStatusDot');
  if (!dot) {
    dot = document.createElement('span');
    dot.id = 'n8nStatusDot';
    dot.style.cssText = 'display:inline-block;width:7px;height:7px;border-radius:50%;margin-left:6px;vertical-align:middle;transition:background 0.3s;';
    label.appendChild(dot);
  }
  dot.style.background = online ? '#48bb78' : '#fc8181';
  dot.title = online ? `n8n connected · ${count} plugin(s)` : 'n8n offline or not reachable';
}

function reconcilePlugins(panels) {
  // Accept panels that have id + label. 'builtin' trigger doesn't need a webhook.
  const valid = panels.filter((p) => p.id && p.label && (p.webhook || p.trigger === 'builtin'));
  const incomingIds = new Set(valid.map((p) => p.id));
  for (const [id] of pluginRegistry) { if (!incomingIds.has(id)) removePlugin(id); }
  for (const panel of valid) {
    if (!pluginRegistry.has(panel.id)) registerPlugin(panel);
  }
}

function registerPlugin(plugin) {
  pluginRegistry.set(plugin.id, plugin);
  injectPluginLink(plugin);
  // 'builtin' panels already exist in the HTML — don't inject a duplicate content panel
  if (plugin.trigger !== 'builtin') injectPluginPanel(plugin);
}

function removePlugin(id) {
  pluginRegistry.delete(id);
  document.getElementById(`plugin-link-${id}`)?.remove();
  // Never remove a builtin panel (e.g. live-consultPanel is in the HTML)
  const panel = document.getElementById(`${id}Panel`);
  if (panel && !panel.classList.contains('epic-builtin-panel')) panel.remove();
}

function injectPluginLink(plugin) {
  if (document.getElementById(`plugin-link-${plugin.id}`)) return;
  const a = document.createElement('a');
  a.href = '#'; a.className = 'activity-item plugin-item';
  a.id = `plugin-link-${plugin.id}`; a.dataset.tab = plugin.id;
  // Builtin panels get a distinct badge; others show n8n badge
  const badge = plugin.trigger === 'builtin'
    ? '<span class="plugin-badge" style="background:#2b7a0b;">live</span>'
    : '<span class="plugin-badge">n8n</span>';
  a.innerHTML = `${escapeHtml(plugin.label)} ${badge}`;
  a.addEventListener('click', (e) => { e.preventDefault(); switchTab(plugin.id); });
  elements.dynamicPluginLinks.appendChild(a);
}

function injectPluginPanel(plugin) {
  if (document.getElementById(`${plugin.id}Panel`)) return;
  const panel = document.createElement('div');
  panel.id = `${plugin.id}Panel`;
  panel.className = 'epic-tab-panel epic-ai-panel epic-plugin-panel';
  panel.dataset.pluginId = plugin.id;
  panel.innerHTML = `
    <div class="panel-header">
      <h2>${escapeHtml(plugin.title || plugin.label)} <span class="ai-badge">n8n</span></h2>
      <p class="panel-subtitle">${escapeHtml(plugin.description || `Powered by n8n webhook: ${plugin.webhook}`)}</p>
    </div>
    ${plugin.trigger === 'button' ? `
      <button type="button" class="epic-btn epic-btn-primary plugin-run-btn" data-plugin-id="${plugin.id}" disabled>
        ${escapeHtml(plugin.buttonLabel || `Run ${plugin.label}`)}
      </button>` : ''}
    <div id="${plugin.id}Content" class="epic-data-content epic-plugin-output">
      <p class="no-data">Select a patient to use this feature.</p>
    </div>`;
  elements.dynamicPanelContainer.appendChild(panel);
  panel.querySelector('.plugin-run-btn')?.addEventListener('click', () => runPlugin(plugin.id));
}

function updatePluginButtons(enabled) {
  document.querySelectorAll('.plugin-run-btn').forEach((btn) => { btn.disabled = !enabled; });
}

function runAutoPlugins() {
  for (const [id, plugin] of pluginRegistry) {
    if (plugin.trigger === 'auto' || !plugin.trigger) runPlugin(id);
  }
}

async function runPlugin(pluginId) {
  const plugin = pluginRegistry.get(pluginId);
  if (!plugin || !selectedPatient) return;
  // Builtin panels (live-consult) manage their own UI — never fire a webhook
  if (plugin.trigger === 'builtin') { switchTab(pluginId); return; }
  const contentEl = document.getElementById(`${pluginId}Content`);
  if (!contentEl) return;
  contentEl.innerHTML = `<p class="no-data plugin-loading"><span class="epic-spinner-inline"></span> Running ${escapeHtml(plugin.label)}…</p>`;
  try {
    const payload = { patientId: selectedPatient.id, fhirBase: FHIR_BASE, patientData: selectedPatient };
    const res = await fetch(`${N8N_BASE}/webhook/${plugin.webhook}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
    const raw = await res.json();
    const data = Array.isArray(raw) ? raw[0] : raw;
    contentEl.innerHTML = renderPluginResponse(data, plugin);
  } catch (err) {
    contentEl.innerHTML = `<div class="plugin-error"><strong>Plugin failed:</strong> ${escapeHtml(err.message)}<br>
      <small>Check that your n8n workflow at <code>${N8N_BASE}/webhook/${plugin.webhook}</code> is active.</small></div>`;
  }
}

function renderPluginResponse(data, plugin) {
  if (data.html) return `<div class="plugin-html-output">${data.html}</div>`;
  if (data.cards && Array.isArray(data.cards)) {
    return data.cards.map((card) => {
      const cls = card.indicator === 'warning' ? 'card-warn' : card.indicator === 'critical' ? 'card-crit' : 'card-info';
      return `<div class="plugin-card ${cls}">
        <div class="plugin-card-summary">${escapeHtml(card.summary || '')}</div>
        ${card.detail ? `<div class="plugin-card-detail">${escapeHtml(card.detail)}</div>` : ''}
        ${card.source?.label ? `<div class="plugin-card-source">◦ ${escapeHtml(card.source.label)}</div>` : ''}
      </div>`;
    }).join('');
  }
  if (data.table && data.table.headers) {
    const { headers, rows } = data.table;
    return `<div class="plugin-table-wrap"><table class="plugin-table">
      <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${(rows || []).map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  }
  if (data.text) return `<pre class="plugin-text-output">${escapeHtml(data.text)}</pre>`;
  return `<pre class="plugin-text-output">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
}

function setPluginStatus(msg, type = 'ok') {
  const el = elements.pluginStatus;
  if (!el) return;
  el.textContent = msg; el.className = `plugin-status plugin-status-${type}`;
  setTimeout(() => { el.textContent = ''; el.className = 'plugin-status'; }, 4000);
}

// ═══════════════════════════════════════════════════════════════
//  ORIGINAL: PATIENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function loadInitialPatients() { await fetchAndRenderPatients(''); }
async function handleSearch() { await fetchAndRenderPatients(elements.patientSearch?.value?.trim() ?? ''); }

async function fetchAndRenderPatients(query) {
  if (!elements.patientList) return;
  showLoading(true);
  try {
    const url = query
      ? `${FHIR_BASE}/Patient?_count=20&name=${encodeURIComponent(query)}`
      : `${FHIR_BASE}/Patient?_count=20`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bundle = await response.json();
    const patients = bundle.entry?.map((e) => e.resource) ?? [];
    renderPatientList(patients);
    if (patients.length === 0) elements.patientList.innerHTML = '<div class="empty-message">No patients found.</div>';
  } catch (err) {
    elements.patientList.innerHTML = `<div class="error-msg">Unable to fetch patients. Ensure the FHIR server is running. Error: ${err.message}</div>`;
  } finally { showLoading(false); }
}

function renderPatientList(patients) {
  if (!elements.patientList) return;
  patientCache.clear();
  patients.forEach((p) => patientCache.set(p.id, p));
  elements.patientList.innerHTML = patients.map((p) => {
    const name = formatPatientName(p);
    return `<div class="epic-patient-item" data-id="${p.id}">
      <div><div class="patient-item-name">${escapeHtml(name)}</div>
      <div class="patient-item-meta">DOB: ${p.birthDate || '—'} | ${p.gender || '—'}</div></div>
      <span class="patient-item-mrn">MRN: ${p.id}</span>
    </div>`;
  }).join('');
  elements.patientList.querySelectorAll('.epic-patient-item').forEach((el) => {
    el.addEventListener('click', () => {
      const patient = patientCache.get(el.dataset.id);
      if (patient) selectPatient(patient);
    });
  });
}

function selectPatient(patient) {
  selectedPatient = patient;
  document.querySelector('.epic-layout')?.classList.add('has-patient');
  elements.patientListSection?.classList.add('hidden');
  elements.patientChartSection?.classList.remove('hidden');
  elements.patientBanner?.classList.remove('hidden');
  updatePatientBanner(patient);
  updatePluginButtons(true);
  // Enable new feature buttons
  enableEntryButtons(true);
  enableConsultButtons(true);
  document.getElementById('processPdfBtn').disabled = !currentPdfFile;
  // Update consult patient name
  document.getElementById('consultPatientName').textContent = formatPatientName(patient);
  loadAllergies(); loadOverview(); loadMedications(); loadLabs();
  loadProblems(); loadVitals(); loadDemographics();
  runAutoPlugins();
  switchTab('allergies');
}

function clearPatient() {
  selectedPatient = null;
  document.querySelector('.epic-layout')?.classList.remove('has-patient');
  elements.patientChartSection?.classList.add('hidden');
  elements.patientListSection?.classList.remove('hidden');
  elements.patientBanner?.classList.add('hidden');
  elements.patientSearch.value = '';
  updatePluginButtons(false);
  enableEntryButtons(false);
  enableConsultButtons(false);
  for (const [id] of pluginRegistry) {
    const el = document.getElementById(`${id}Content`);
    if (el) el.innerHTML = '<p class="no-data">Select a patient to use this feature.</p>';
  }
}

function updatePatientBanner(p) {
  const phone = p.telecom?.find((t) => t.system === 'phone')?.value || '—';
  elements.bannerMRN.textContent   = p.id;
  elements.bannerName.textContent  = formatPatientName(p);
  elements.bannerDOB.textContent   = p.birthDate || '—';
  elements.bannerAge.textContent   = getPatientAge(p.birthDate);
  elements.bannerSex.textContent   = p.gender || '—';
  elements.bannerPhone.textContent = phone;
}

function switchTab(tabId) {
  // Chart panels are inside patientChartSection — show it, or prompt to select a patient
  const chartSection = elements.patientChartSection;
  const panelEl = document.getElementById(`${tabId}Panel`);
  if (panelEl && chartSection) {
    if (chartSection.classList.contains('hidden')) {
      if (!selectedPatient) {
        // Show a temporary toast instead of silently failing
        showNoPatientToast();
        return;
      }
      chartSection.classList.remove('hidden');
      elements.patientListSection?.classList.add('hidden');
    }
  }
  document.querySelectorAll('.activity-item').forEach((i) => i.classList.remove('active'));
  document.querySelectorAll('.epic-tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelector(`.activity-item[data-tab="${tabId}"]`)?.classList.add('active');
  panelEl?.classList.add('active');
}

function showNoPatientToast() {
  let toast = document.getElementById('noPatientToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'noPatientToast';
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
      'background:#2d3748;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;' +
      'font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.3);pointer-events:none;';
    document.body.appendChild(toast);
  }
  toast.textContent = '⚠ Please search for and select a patient first.';
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// ═══════════════════════════════════════════════════════════════
//  ORIGINAL: FHIR HELPERS
// ═══════════════════════════════════════════════════════════════

async function fhirGet(resource, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const res = await fetch(`${FHIR_BASE}/${resource}${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fhirPost(resource, body) {
  const res = await fetch(`${FHIR_BASE}/${resource}`, {
    method: 'POST', headers: { 'Content-Type': 'application/fhir+json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fhirPut(resource, id, body) {
  const res = await fetch(`${FHIR_BASE}/${resource}/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/fhir+json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fhirDelete(resource, id) {
  const res = await fetch(`${FHIR_BASE}/${resource}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ═══════════════════════════════════════════════════════════════
//  ORIGINAL: PATIENT CRUD MODAL
// ═══════════════════════════════════════════════════════════════

function openAddPatientModal() {
  elements.patientModalTitle.textContent = 'Add Patient';
  ['patientFormId','patientFamily','patientGiven','patientBirthDate','patientPhone','patientAddress']
    .forEach((id) => document.getElementById(id).value = '');
  document.getElementById('patientGender').value = '';
  elements.patientModal?.classList.remove('hidden');
}
function openEditPatientModal() {
  if (!selectedPatient) return;
  elements.patientModalTitle.textContent = 'Edit Patient';
  const p = selectedPatient;
  const name = p.name?.find((n) => n.use === 'official') || p.name?.[0];
  document.getElementById('patientFormId').value    = p.id;
  document.getElementById('patientFamily').value    = name?.family || '';
  document.getElementById('patientGiven').value     = (name?.given || []).join(' ');
  document.getElementById('patientBirthDate').value = p.birthDate || '';
  document.getElementById('patientGender').value    = p.gender || '';
  document.getElementById('patientPhone').value     = p.telecom?.find((t) => t.system === 'phone')?.value || '';
  const addr = p.address?.[0];
  document.getElementById('patientAddress').value   = addr
    ? [addr.line?.join(', '), addr.city, addr.state, addr.postalCode].filter(Boolean).join(', ') : '';
  elements.patientModal?.classList.remove('hidden');
}
function closePatientModal() { elements.patientModal?.classList.add('hidden'); }

function buildPatientResource() {
  const id = document.getElementById('patientFormId').value?.trim();
  const family = document.getElementById('patientFamily').value?.trim();
  const given = document.getElementById('patientGiven').value?.trim().split(/\s+/).filter(Boolean);
  const birthDate = document.getElementById('patientBirthDate').value || undefined;
  const gender = document.getElementById('patientGender').value || undefined;
  const phone = document.getElementById('patientPhone').value?.trim();
  const addrRaw = document.getElementById('patientAddress').value?.trim();
  const resource = {
    resourceType: 'Patient',
    name: [{ use: 'official', family: family || undefined, given: given.length ? given : undefined }].filter((n) => n.family || n.given),
  };
  if (birthDate) resource.birthDate = birthDate;
  if (gender) resource.gender = gender;
  if (phone) resource.telecom = [{ system: 'phone', value: phone }];
  if (addrRaw) {
    const parts = addrRaw.split(',').map((s) => s.trim());
    const addr = { line: parts[0] ? [parts[0]] : undefined, city: parts[1], state: parts[2], postalCode: parts[3] };
    const clean = Object.fromEntries(Object.entries(addr).filter(([, v]) => v));
    if (Object.keys(clean).length) resource.address = [clean];
  }
  if (id) resource.id = id;
  return resource;
}

async function savePatient() {
  const family = document.getElementById('patientFamily').value?.trim();
  const given  = document.getElementById('patientGiven').value?.trim();
  if (!family || !given) { alert('Family name and Given name are required.'); return; }
  const resource = buildPatientResource();
  const isEdit = !!resource.id;
  showLoading(true); elements.savePatientBtn.disabled = true;
  try {
    isEdit ? await fhirPut('Patient', resource.id, resource) : await fhirPost('Patient', resource);
    closePatientModal();
    await fetchAndRenderPatients(isEdit ? (elements.patientSearch?.value?.trim() ?? '') : '');
    if (isEdit && selectedPatient?.id === resource.id) selectPatient(patientCache.get(resource.id) || resource);
  } catch (err) { alert(`Failed to save patient: ${err.message}`); }
  finally { showLoading(false); elements.savePatientBtn.disabled = false; }
}

async function deletePatient() {
  if (!selectedPatient) return;
  if (!confirm(`Delete patient ${formatPatientName(selectedPatient)} (MRN: ${selectedPatient.id})? This cannot be undone.`)) return;
  showLoading(true);
  try {
    await fhirDelete('Patient', selectedPatient.id);
    clearPatient();
    await fetchAndRenderPatients(elements.patientSearch?.value?.trim() ?? '');
  } catch (err) { alert(`Failed to delete patient: ${err.message}`); }
  finally { showLoading(false); }
}

// ═══════════════════════════════════════════════════════════════
//  ORIGINAL: FHIR DATA LOADERS
// ═══════════════════════════════════════════════════════════════

async function loadAllergies() {
  const el = document.getElementById('allergiesContent');
  if (!el || !selectedPatient) return;
  el.innerHTML = '<p class="no-data">Loading allergies...</p>';
  try {
    const bundle = await fhirGet('AllergyIntolerance', { patient: selectedPatient.id, _count: 20 }).catch(() => ({ entry: [] }));
    const allergies = bundle.entry?.map((e) => e.resource) ?? [];
    el.innerHTML = allergies.length
      ? allergies.map((a) => `<div class="allergy-item ${a.criticality === 'high' ? 'severe' : ''}">
          <strong>${a.code?.text || a.code?.coding?.[0]?.display || 'Allergen'}</strong>
          <span> — ${a.type || '—'} | ${a.criticality || '—'} | ${a.clinicalStatus?.coding?.[0]?.code || '—'}</span>
        </div>`).join('')
      : '<p class="no-data">No known allergies on record.</p>';
  } catch { el.innerHTML = '<p class="no-data">No known allergies on record.</p>'; }
}

async function loadOverview() {
  const el = document.getElementById('overviewContent');
  if (!el || !selectedPatient) return;
  el.innerHTML = '<p class="no-data">Loading chart review...</p>';
  try {
    const [encBundle, condBundle] = await Promise.all([
      fhirGet('Encounter',  { patient: selectedPatient.id, _count: 10 }).catch(() => ({ entry: [] })),
      fhirGet('Condition',  { patient: selectedPatient.id, _count: 5  }).catch(() => ({ entry: [] })),
    ]);
    const encounters = encBundle.entry?.map((e) => e.resource) ?? [];
    const conditions = condBundle.entry?.map((e) => e.resource) ?? [];
    el.innerHTML = `
      <div class="epic-data-row header"><span>Recent Encounters</span><span>Status</span><span>Date</span></div>
      ${encounters.length
        ? encounters.map((e) => `<div class="epic-data-row"><span>${e.type?.[0]?.text || 'Encounter'}</span><span>${e.status || '—'}</span><span>${e.period?.start ? new Date(e.period.start).toLocaleDateString() : '—'}</span></div>`).join('')
        : '<div class="epic-data-row"><span class="no-data">No encounters</span></div>'}
      <h4 style="margin-top:20px">Active Problems</h4>
      ${conditions.length
        ? conditions.map((c) => `<div class="epic-data-row"><span>${c.code?.text || c.code?.coding?.[0]?.display || 'Condition'}</span><span>${c.clinicalStatus?.coding?.[0]?.code || '—'}</span><span>—</span></div>`).join('')
        : '<p class="no-data">No conditions found</p>'}`;
  } catch { el.innerHTML = '<p class="no-data">Unable to load chart review.</p>'; }
}

async function loadMedications() {
  const el = document.getElementById('medicationsContent');
  if (!el || !selectedPatient) return;
  el.innerHTML = '<p class="no-data">Loading medications...</p>';
  try {
    const bundle = await fhirGet('MedicationRequest', { patient: selectedPatient.id, _count: 20 });
    const meds = bundle.entry?.map((e) => e.resource) ?? [];
    el.innerHTML = meds.length
      ? `<div class="epic-data-row header"><span>Medication</span><span>Status</span><span>Date</span></div>
         ${meds.map((m) => `<div class="epic-data-row"><span>${m.medicationCodeableConcept?.text || m.medicationCodeableConcept?.coding?.[0]?.display || '—'}</span><span>${m.status || '—'}</span><span>${m.authoredOn ? new Date(m.authoredOn).toLocaleDateString() : '—'}</span></div>`).join('')}`
      : '<p class="no-data">No medications found.</p>';
  } catch { el.innerHTML = '<p class="no-data">Unable to load medications.</p>'; }
}

async function loadLabs() {
  const el = document.getElementById('labsContent');
  if (!el || !selectedPatient) return;
  el.innerHTML = '<p class="no-data">Loading lab results...</p>';
  try {
    const bundle = await fhirGet('Observation', { patient: selectedPatient.id, category: 'laboratory', _count: 20 });
    const obs = bundle.entry?.map((e) => e.resource) ?? [];
    el.innerHTML = obs.length
      ? `<div class="epic-data-row header"><span>Test</span><span>Value</span><span>Date</span></div>
         ${obs.map((o) => `<div class="epic-data-row"><span>${o.code?.text || o.code?.coding?.[0]?.display || 'Lab'}</span><span>${formatObsValue(o)}</span><span>${o.effectiveDateTime ? new Date(o.effectiveDateTime).toLocaleDateString() : '—'}</span></div>`).join('')}`
      : '<p class="no-data">No lab results found.</p>';
  } catch { el.innerHTML = '<p class="no-data">Unable to load lab results.</p>'; }
}

async function loadProblems() {
  const el = document.getElementById('problemsContent');
  if (!el || !selectedPatient) return;
  el.innerHTML = '<p class="no-data">Loading problem list...</p>';
  try {
    const bundle = await fhirGet('Condition', { patient: selectedPatient.id, _count: 20 });
    const conditions = bundle.entry?.map((e) => e.resource) ?? [];
    el.innerHTML = conditions.length
      ? `<div class="epic-data-row header"><span>Condition</span><span>Status</span><span>Date</span></div>
         ${conditions.map((c) => `<div class="epic-data-row"><span>${c.code?.text || c.code?.coding?.[0]?.display || 'Condition'}</span><span>${c.clinicalStatus?.coding?.[0]?.code || '—'}</span><span>${c.recordedDate ? new Date(c.recordedDate).toLocaleDateString() : '—'}</span></div>`).join('')}`
      : '<p class="no-data">No conditions found.</p>';
  } catch { el.innerHTML = '<p class="no-data">Unable to load problem list.</p>'; }
}

async function loadVitals() {
  const el = document.getElementById('vitalsContent');
  if (!el || !selectedPatient) return;
  el.innerHTML = '<p class="no-data">Loading vitals...</p>';
  try {
    const bundle = await fhirGet('Observation', { patient: selectedPatient.id, category: 'vital-signs', _count: 20 });
    const vitals = bundle.entry?.map((e) => e.resource) ?? [];
    el.innerHTML = vitals.length
      ? `<div class="epic-data-row header"><span>Vital</span><span>Value</span><span>Date</span></div>
         ${vitals.map((v) => `<div class="epic-data-row"><span>${v.code?.text || v.code?.coding?.[0]?.display || 'Vital'}</span><span>${formatObsValue(v)}</span><span>${v.effectiveDateTime ? new Date(v.effectiveDateTime).toLocaleDateString() : '—'}</span></div>`).join('')}`
      : '<p class="no-data">No vital signs found.</p>';
  } catch { el.innerHTML = '<p class="no-data">Unable to load vitals.</p>'; }
}

function loadDemographics() {
  const el = document.getElementById('demographicsContent');
  if (!el || !selectedPatient) return;
  const p = selectedPatient;
  const addr = p.address?.[0];
  const items = [
    { label: 'Patient Name', value: formatPatientName(p) },
    { label: 'MRN',          value: p.id },
    { label: 'Date of Birth', value: p.birthDate || '—' },
    { label: 'Age',           value: getPatientAge(p.birthDate) },
    { label: 'Sex',           value: p.gender || '—' },
    { label: 'Phone',         value: p.telecom?.find((t) => t.system === 'phone')?.value || '—' },
    { label: 'Address',       value: addr ? [addr.line?.join(', '), addr.city, addr.state, addr.postalCode].filter(Boolean).join(', ') : '—' },
  ];
  el.innerHTML = `<div class="demographics-grid">
    ${items.map((i) => `<div class="demographics-item"><div class="label">${i.label}</div><div class="value">${escapeHtml(String(i.value))}</div></div>`).join('')}
  </div>`;
}

// generateAISummary() removed — discharge and pre-visit summaries are now
// fully driven by n8n list-panels as plugin panels (trigger: "button").
// To customise them, edit the n8n "list-panels" workflow response.

// ═══════════════════════════════════════════════════════════════
//  NEW FEATURE 1: MANUAL DATA ENTRY
//  Posts FHIR resources directly. "Keep previous" means we don't
//  overwrite existing FHIR observations — we post a new entry
//  only for the fields actually filled in.
// ═══════════════════════════════════════════════════════════════

function initManualEntry() {
  // Type tab switching
  document.querySelectorAll('.entry-type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.entry-type-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.entry-section').forEach((s) => s.classList.remove('active-entry'));
      btn.classList.add('active');
      document.getElementById(`entry-${btn.dataset.entry}`)?.classList.add('active-entry');
    });
  });

  // Set default datetime to now
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  ['lab-date','vital-date'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = nowLocal; });

  // Save buttons
  document.getElementById('saveLab')?.addEventListener('click', saveLab);
  document.getElementById('saveVitals')?.addEventListener('click', saveVitals);
  document.getElementById('saveMed')?.addEventListener('click', saveMedication);
  document.getElementById('saveCond')?.addEventListener('click', saveCondition);
  document.getElementById('saveAllergy')?.addEventListener('click', saveAllergyEntry);
}

function enableEntryButtons(on) {
  ['saveLab','saveVitals','saveMed','saveCond','saveAllergy'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
  // Dim Data Entry and PDF sidebar links when no patient selected
  document.querySelectorAll('.activity-item[data-tab="manual-entry"], .activity-item[data-tab="pdf-upload"]')
    .forEach((a) => { a.style.opacity = on ? '' : '0.45'; a.title = on ? '' : 'Select a patient first'; });
}

function showEntryFeedback(msg, type = 'success') {
  const el = document.getElementById('entryFeedback');
  if (!el) return;
  el.textContent = msg;
  el.className = `entry-feedback entry-feedback-${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

async function saveLab() {
  if (!selectedPatient) return;
  const name  = document.getElementById('lab-name').value.trim();
  const value = document.getElementById('lab-value').value.trim();
  const date  = document.getElementById('lab-date').value;
  if (!name || !value || !date) { showEntryFeedback('Test name, value, and date are required.', 'error'); return; }

  const loinc  = document.getElementById('lab-loinc').value.trim();
  const unit   = document.getElementById('lab-unit').value.trim();
  const ref    = document.getElementById('lab-ref').value.trim();
  const status = document.getElementById('lab-status').value;

  const obs = {
    resourceType: 'Observation',
    status,
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }],
    code: { text: name, ...(loinc ? { coding: [{ system: 'http://loinc.org', code: loinc, display: name }] } : {}) },
    subject: { reference: `Patient/${selectedPatient.id}` },
    effectiveDateTime: new Date(date).toISOString(),
    valueQuantity: { value: parseFloat(value), ...(unit ? { unit, system: 'http://unitsofmeasure.org', code: unit } : {}) },
    ...(ref ? { referenceRange: [{ text: ref }] } : {}),
  };

  try {
    document.getElementById('saveLab').disabled = true;
    await fhirPost('Observation', obs);
    showEntryFeedback(`✓ Lab result "${name}" saved (${new Date(date).toLocaleDateString()}).`);
    setTimeout(() => loadLabs(), 600);
  } catch (err) { showEntryFeedback(`Failed to save: ${err.message}`, 'error'); }
  finally { document.getElementById('saveLab').disabled = false; }
}

async function saveVitals() {
  if (!selectedPatient) return;
  const dateVal = document.getElementById('vital-date').value;
  const effectiveDateTime = dateVal ? new Date(dateVal).toISOString() : new Date().toISOString();
  const saved = [];

  const buildObs = (loincCode, displayName, value, unit) => ({
    resourceType: 'Observation',
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: loincCode, display: displayName }], text: displayName },
    subject: { reference: `Patient/${selectedPatient.id}` },
    effectiveDateTime,
    valueQuantity: { value: parseFloat(value), unit, system: 'http://unitsofmeasure.org', code: unit },
  });

  const vitalsMap = [
    { id: 'vital-hr',     loinc: '8867-4',  name: 'Heart Rate',         unit: '/min' },
    { id: 'vital-spo2',   loinc: '2708-6',  name: 'Oxygen Saturation',  unit: '%' },
    { id: 'vital-rr',     loinc: '9279-1',  name: 'Respiratory Rate',   unit: '/min' },
    { id: 'vital-weight', loinc: '29463-7', name: 'Body Weight',        unitId: 'vital-weight-unit' },
    { id: 'vital-height', loinc: '8302-2',  name: 'Body Height',        unitId: 'vital-height-unit' },
  ];

  for (const v of vitalsMap) {
    const val = document.getElementById(v.id)?.value?.trim();
    if (!val) continue;
    const unit = v.unitId ? document.getElementById(v.unitId)?.value : v.unit;
    saved.push(fhirPost('Observation', buildObs(v.loinc, v.name, val, unit)));
  }

  // Temperature
  const temp = document.getElementById('vital-temp')?.value?.trim();
  if (temp) {
    const tu = document.getElementById('vital-temp-unit')?.value === 'C' ? 'Cel' : '[degF]';
    saved.push(fhirPost('Observation', buildObs('8310-5', 'Body Temperature', temp, tu)));
  }

  // Blood Pressure (panel)
  const bpSys = document.getElementById('vital-bp-sys')?.value?.trim();
  const bpDia = document.getElementById('vital-bp-dia')?.value?.trim();
  if (bpSys || bpDia) {
    const bpObs = {
      resourceType: 'Observation', status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '55284-4', display: 'Blood Pressure' }], text: 'Blood Pressure' },
      subject: { reference: `Patient/${selectedPatient.id}` },
      effectiveDateTime,
      component: [
        ...(bpSys ? [{ code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic BP' }] }, valueQuantity: { value: parseFloat(bpSys), unit: 'mmHg' } }] : []),
        ...(bpDia ? [{ code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic BP' }] }, valueQuantity: { value: parseFloat(bpDia), unit: 'mmHg' } }] : []),
      ],
    };
    saved.push(fhirPost('Observation', bpObs));
  }

  if (saved.length === 0) { showEntryFeedback('Please enter at least one vital sign value.', 'error'); return; }

  try {
    document.getElementById('saveVitals').disabled = true;
    await Promise.all(saved);
    showEntryFeedback(`✓ ${saved.length} vital sign(s) saved (${new Date(effectiveDateTime).toLocaleDateString()}).`);
    setTimeout(() => loadVitals(), 600);
  } catch (err) { showEntryFeedback(`Failed to save vitals: ${err.message}`, 'error'); }
  finally { document.getElementById('saveVitals').disabled = false; }
}

async function saveMedication() {
  if (!selectedPatient) return;
  const name = document.getElementById('med-name').value.trim();
  if (!name) { showEntryFeedback('Medication name is required.', 'error'); return; }

  const rxnorm = document.getElementById('med-rxnorm').value.trim();
  const dose   = document.getElementById('med-dose').value.trim();
  const route  = document.getElementById('med-route').value;
  const freq   = document.getElementById('med-freq').value.trim();
  const start  = document.getElementById('med-start').value;
  const status = document.getElementById('med-status').value;
  const notes  = document.getElementById('med-notes').value.trim();

  const med = {
    resourceType: 'MedicationRequest',
    status,
    intent: 'order',
    medicationCodeableConcept: {
      text: name,
      ...(rxnorm ? { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: rxnorm, display: name }] } : {}),
    },
    subject: { reference: `Patient/${selectedPatient.id}` },
    ...(start ? { authoredOn: start } : {}),
    dosageInstruction: [{
      ...(freq ? { text: freq } : {}),
      ...(dose ? { doseAndRate: [{ doseQuantity: { value: parseFloat(dose) || 1, unit: dose } }] } : {}),
      ...(route ? { route: { text: route } } : {}),
      ...(notes ? { patientInstruction: notes } : {}),
    }],
  };

  try {
    document.getElementById('saveMed').disabled = true;
    await fhirPost('MedicationRequest', med);
    showEntryFeedback(`✓ Medication "${name}" saved.`);
    setTimeout(() => loadMedications(), 600);
  } catch (err) { showEntryFeedback(`Failed to save: ${err.message}`, 'error'); }
  finally { document.getElementById('saveMed').disabled = false; }
}

async function saveCondition() {
  if (!selectedPatient) return;
  const name = document.getElementById('cond-name').value.trim();
  if (!name) { showEntryFeedback('Condition name is required.', 'error'); return; }

  const icd      = document.getElementById('cond-icd').value.trim();
  const status   = document.getElementById('cond-status').value;
  const severity = document.getElementById('cond-severity').value;
  const onset    = document.getElementById('cond-onset').value;
  const recorded = document.getElementById('cond-recorded').value;

  const cond = {
    resourceType: 'Condition',
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status }] },
    code: {
      text: name,
      ...(icd ? { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: icd, display: name }] } : {}),
    },
    subject: { reference: `Patient/${selectedPatient.id}` },
    ...(onset ? { onsetDateTime: onset } : {}),
    ...(recorded ? { recordedDate: recorded } : {}),
    ...(severity ? { severity: { text: severity } } : {}),
  };

  try {
    document.getElementById('saveCond').disabled = true;
    await fhirPost('Condition', cond);
    showEntryFeedback(`✓ Condition "${name}" saved.`);
    setTimeout(() => { loadProblems(); loadOverview(); }, 600);
  } catch (err) { showEntryFeedback(`Failed to save: ${err.message}`, 'error'); }
  finally { document.getElementById('saveCond').disabled = false; }
}

async function saveAllergyEntry() {
  if (!selectedPatient) return;
  const allergen = document.getElementById('allergy-name').value.trim();
  if (!allergen) { showEntryFeedback('Allergen name is required.', 'error'); return; }

  const type        = document.getElementById('allergy-type').value;
  const criticality = document.getElementById('allergy-criticality').value;
  const reaction    = document.getElementById('allergy-reaction').value.trim();
  const severity    = document.getElementById('allergy-sev').value;
  const onset       = document.getElementById('allergy-onset').value;

  const allergy = {
    resourceType: 'AllergyIntolerance',
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
    verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] },
    type, criticality,
    code: { text: allergen },
    patient: { reference: `Patient/${selectedPatient.id}` },
    ...(onset ? { onsetDateTime: onset } : {}),
    ...(reaction ? { reaction: [{ manifestation: [{ text: reaction }], ...(severity ? { severity } : {}) }] } : {}),
  };

  try {
    document.getElementById('saveAllergy').disabled = true;
    await fhirPost('AllergyIntolerance', allergy);
    showEntryFeedback(`✓ Allergy to "${allergen}" saved.`);
    setTimeout(() => loadAllergies(), 600);
  } catch (err) { showEntryFeedback(`Failed to save: ${err.message}`, 'error'); }
  finally { document.getElementById('saveAllergy').disabled = false; }
}

// ═══════════════════════════════════════════════════════════════
//  NEW FEATURE 2: PDF REPORT UPLOAD VIA n8n
//  Sends PDF as base64 to n8n webhook: process-report
//  n8n extracts values; missing fields keep previous FHIR value
//
//  n8n webhook expected at: POST /webhook/process-report
//  Payload:  { patientId, fhirBase, pdfBase64, filename,
//              reportType, keepPrevious, showDates }
//  Response: { extracted: [{name,value,unit,date,isNew},...],
//              summary: "...", reportDate: "...",
//              resources: [...FHIR resources to POST...] }
// ═══════════════════════════════════════════════════════════════

let currentPdfFile = null;
let pdfExtractedData = null;

function initPdfUpload() {
  const dropZone   = document.getElementById('pdfDropZone');
  const fileInput  = document.getElementById('pdfFileInput');
  const processBtn = document.getElementById('processPdfBtn');
  const clearBtn   = document.getElementById('clearPdfBtn');

  fileInput?.addEventListener('change', (e) => handlePdfFile(e.target.files[0]));
  clearBtn?.addEventListener('click', clearPdf);
  processBtn?.addEventListener('click', processPdf);
  document.getElementById('applyPdfResultBtn')?.addEventListener('click', applyPdfResult);
  document.getElementById('discardPdfResultBtn')?.addEventListener('click', () => {
    document.getElementById('pdfResult').classList.add('hidden');
    pdfExtractedData = null;
  });

  // Drag & drop
  dropZone?.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') handlePdfFile(file);
    else alert('Please drop a PDF file.');
  });
}

function handlePdfFile(file) {
  if (!file) return;
  currentPdfFile = file;
  document.getElementById('pdfDropZone').classList.add('has-file');
  document.getElementById('pdfFileInfo').classList.remove('hidden');
  document.getElementById('pdfFileName').textContent = file.name;
  document.getElementById('pdfFileSize').textContent = `(${(file.size / 1024).toFixed(1)} KB)`;
  document.getElementById('processPdfBtn').disabled = !selectedPatient;
}

function clearPdf() {
  currentPdfFile = null;
  pdfExtractedData = null;
  document.getElementById('pdfDropZone').classList.remove('has-file');
  document.getElementById('pdfFileInfo').classList.add('hidden');
  document.getElementById('pdfFileName').textContent = '';
  document.getElementById('pdfFileSize').textContent = '';
  document.getElementById('pdfFileInput').value = '';
  document.getElementById('processPdfBtn').disabled = true;
  document.getElementById('pdfResult').classList.add('hidden');
  document.getElementById('pdfProcessing').classList.add('hidden');
}

async function processPdf() {
  if (!currentPdfFile || !selectedPatient) return;

  const processingEl = document.getElementById('pdfProcessing');
  const msgEl        = document.getElementById('pdfProcessingMsg');
  const resultEl     = document.getElementById('pdfResult');

  processingEl.classList.remove('hidden');
  resultEl.classList.add('hidden');
  document.getElementById('processPdfBtn').disabled = true;

  try {
    msgEl.textContent = 'Reading PDF file...';
    const pdfBase64 = await fileToBase64(currentPdfFile);

    msgEl.textContent = 'Sending to n8n for AI extraction...';
    const payload = {
      patientId:    selectedPatient.id,
      fhirBase:     FHIR_BASE,
      pdfBase64,
      filename:     currentPdfFile.name,
      reportType:   document.getElementById('pdfReportType').value,
      keepPrevious: document.getElementById('pdfKeepPrevious').checked,
      showDates:    document.getElementById('pdfShowDates').checked,
      patientName:  formatPatientName(selectedPatient),
    };

    const res = await fetch(`${N8N_BASE}/webhook/process-report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`n8n returned HTTP ${res.status}${txt ? ': ' + txt.slice(0, 120) : ''}. Make sure the "process-report" webhook is active in n8n.`);
    }
    const raw = await res.json().catch(() => { throw new Error('n8n returned a non-JSON response. Check that the process-report workflow is active and responding correctly.'); });
    const data = Array.isArray(raw) ? raw[0] : raw;

    msgEl.textContent = 'Rendering results...';
    pdfExtractedData = data;
    renderPdfResult(data);

  } catch (err) {
    document.getElementById('pdfResultContent').innerHTML = `
      <div class="plugin-error">
        <strong>Could not process PDF.</strong><br>
        ${escapeHtml(err.message)}<br>
        <small>Make sure the <code>process-report</code> workflow is active in n8n at
        <a href="http://${window.location.hostname}:4014" target="_blank">localhost:4014</a></small>
      </div>`;
    resultEl.classList.remove('hidden');
  } finally {
    processingEl.classList.add('hidden');
    document.getElementById('processPdfBtn').disabled = false;
  }
}

function renderPdfResult(data) {
  const resultEl  = document.getElementById('pdfResult');
  const metaEl    = document.getElementById('pdfResultMeta');
  const contentEl = document.getElementById('pdfResultContent');

  metaEl.textContent = [
    data.reportDate ? `Report date: ${data.reportDate}` : '',
    data.summary    ? data.summary : '',
  ].filter(Boolean).join(' · ');

  // If n8n returned pre-rendered HTML
  if (data.html) { contentEl.innerHTML = data.html; resultEl.classList.remove('hidden'); return; }

  // If n8n returned structured extracted fields
  if (data.extracted && Array.isArray(data.extracted)) {
    const showDates = document.getElementById('pdfShowDates').checked;
    contentEl.innerHTML = `
      <div class="pdf-extracted-table">
        <div class="epic-data-row header">
          <span>Field</span><span>Value</span><span>Unit</span>${showDates ? '<span>Date</span>' : ''}<span>Source</span>
        </div>
        ${data.extracted.map((item) => `
          <div class="epic-data-row ${item.isNew ? 'pdf-row-new' : 'pdf-row-prev'}">
            <span>${escapeHtml(item.name || '—')}</span>
            <span><strong>${escapeHtml(String(item.value ?? '—'))}</strong></span>
            <span>${escapeHtml(item.unit || '—')}</span>
            ${showDates ? `<span>${item.date ? new Date(item.date).toLocaleDateString() : '—'}</span>` : ''}
            <span class="pdf-source-badge ${item.isNew ? 'new' : 'prev'}">${item.isNew ? 'This report' : 'Previous'}</span>
          </div>`).join('')}
      </div>`;
    resultEl.classList.remove('hidden');
    return;
  }

  // Fallback
  contentEl.innerHTML = renderPluginResponse(data, {});
  resultEl.classList.remove('hidden');
}

async function applyPdfResult() {
  if (!pdfExtractedData || !selectedPatient) return;
  const resources = pdfExtractedData.resources;
  if (!resources || !resources.length) {
    showEntryFeedback('No FHIR resources returned by n8n to apply.', 'error');
    return;
  }
  document.getElementById('applyPdfResultBtn').disabled = true;
  try {
    await Promise.all(resources.map((r) => fhirPost(r.resourceType, r)));
    showEntryFeedback(`✓ ${resources.length} resource(s) from PDF applied to chart.`);
    // Reload affected tabs
    loadLabs(); loadVitals(); loadMedications(); loadProblems(); loadAllergies();
    document.getElementById('pdfResult').classList.add('hidden');
  } catch (err) { showEntryFeedback(`Failed to apply: ${err.message}`, 'error'); }
  finally { document.getElementById('applyPdfResultBtn').disabled = false; }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

// ═══════════════════════════════════════════════════════════════
//  NEW FEATURE 3: LIVE DOCTOR–PATIENT CONSULTATION
//
//  Flow:
//  1. Doctor clicks "Start Consultation"
//  2. Speaker toggles between Doctor / Patient
//  3. Web Speech API transcribes each speaker's input
//     (falls back to manual text input if no mic / API unavailable)
//  4. Transcript builds up with speaker labels + timestamps
//  5. "Generate Clinical Notes" → POST /webhook/generate-clinical-notes
//     Receives: { patientId, fhirBase, transcript, patientName }
//     Returns:  { html } or { text } with SOAP note
//  6. "Extract & Update Chart" → POST /webhook/extract-chart-updates
//     Receives: { patientId, fhirBase, transcript, patientName }
//     Returns:  { html, resources: [...FHIR...] }
//  7. Doctor reviews and clicks "Apply" to post resources to FHIR
// ═══════════════════════════════════════════════════════════════

// ─── CONSULT STATE ─────────────────────────────────────────────
let consultState = {
  active:          false,
  mode:            'speak',    // 'speak' | 'type'
  currentSpeaker:  'patient',
  transcript:      [],          // [{speaker, text, time}]
  recognition:     null,
  timerInterval:   null,
  startTime:       null,
  pendingChartUpdates: [],
  aiThinking:      false,       // waiting for AI doctor n8n reply
};

// ── MODE SWITCHER ───────────────────────────────────────────────
function initConsultModeBar() {
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (consultState.active) return; // lock mode during session
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      consultState.mode = btn.dataset.mode;
      applyModeUI(consultState.mode);
    });
  });
}

function applyModeUI(mode) {
  const isSpeak = mode === 'speak';
  // Toggle button never needed — AI is always doctor
  document.getElementById('toggleSpeakerBtn').style.display = 'none';
  // Text input: shown in both modes but labelled differently
  const lbl = document.getElementById('textFallbackLabel');
  if (lbl) lbl.innerHTML = isSpeak
    ? '&#9998; Patient: type a message (or just speak — mic is active):'
    : '&#9998; Patient: type your message:';
  const inp = document.getElementById('consultTextInput');
  if (inp) inp.placeholder = isSpeak
    ? 'Type or speak — mic is always listening…'
    : 'Type patient\'s message and press Enter…';
  // Doctor card always shows AI
  document.getElementById('doctorAvatarLabel').textContent = '🤖';
  document.getElementById('doctorCardName').textContent    = 'AI Virtual Doctor';
  document.getElementById('doctorCardRole').textContent    = 'Powered by n8n + GPT-4o';
}

// ── INIT ────────────────────────────────────────────────────────
function initLiveConsult() {
  initConsultModeBar();
  document.getElementById('startConsultBtn')?.addEventListener('click', startConsultation);
  document.getElementById('toggleSpeakerBtn')?.addEventListener('click', toggleSpeaker);
  document.getElementById('endConsultBtn')?.addEventListener('click', endConsultation);
  document.getElementById('clearTranscriptBtn')?.addEventListener('click', clearTranscript);
  document.getElementById('generateClinicalNotesBtn')?.addEventListener('click', generateClinicalNotes);
  document.getElementById('updateChartFromConsultBtn')?.addEventListener('click', extractChartUpdates);
  document.getElementById('applyConsultUpdatesBtn')?.addEventListener('click', applyConsultUpdates);
  document.getElementById('discardConsultUpdatesBtn')?.addEventListener('click', () => {
    document.getElementById('chartUpdatePreview').classList.add('hidden');
  });
  document.getElementById('saveNotesToFhirBtn')?.addEventListener('click', saveNotesToFhir);
  document.getElementById('copyNotesBtn')?.addEventListener('click', copyClinicalNotes);

  const textInput = document.getElementById('consultTextInput');
  const addBtn    = document.getElementById('addTranscriptLineBtn');
  addBtn?.addEventListener('click', addTextLine);
  textInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter') addTextLine(); });
}

function enableConsultButtons(on) {
  const startBtn = document.getElementById('startConsultBtn');
  if (startBtn) startBtn.disabled = !on;
  if (!on) {
    document.getElementById('generateClinicalNotesBtn').disabled = true;
    document.getElementById('updateChartFromConsultBtn').disabled = true;
    document.getElementById('consultTextInput').disabled = true;
    document.getElementById('addTranscriptLineBtn').disabled = true;
    if (consultState.active) {
      consultState.active = false;
      stopSpeechRecognition();
      stopTimer();
      window.speechSynthesis?.cancel();
      setConsultStatus('idle', '● Idle');
      document.getElementById('startConsultBtn').classList.remove('hidden');
      document.getElementById('toggleSpeakerBtn')?.classList.add('hidden');
      document.getElementById('endConsultBtn')?.classList.add('hidden');
      document.getElementById('voiceWave')?.classList.add('hidden');
      document.getElementById('currentSpeakerLabel').textContent = '';
      document.getElementById('doctorMicStatus').className = 'mic-indicator off';
      document.getElementById('patientMicStatus').className = 'mic-indicator off';
      document.getElementById('aiDoctorBubble')?.classList.add('hidden');
    }
  }
}

// ── START / END ─────────────────────────────────────────────────
function startConsultation() {
  if (!selectedPatient) return;
  consultState.active         = true;
  consultState.currentSpeaker = 'patient';
  consultState.transcript     = [];
  consultState.startTime      = Date.now();
  consultState.aiThinking     = false;

  // Lock mode buttons during session
  document.querySelectorAll('.mode-btn').forEach((b) => b.disabled = true);

  setConsultStatus('recording', '● Recording');
  document.getElementById('startConsultBtn').classList.add('hidden');
  document.getElementById('endConsultBtn').classList.remove('hidden');
  document.getElementById('endConsultBtn').disabled = false;
  document.getElementById('consultTextInput').disabled = false;
  document.getElementById('addTranscriptLineBtn').disabled = false;
  document.getElementById('generateClinicalNotesBtn').disabled = false;
  document.getElementById('updateChartFromConsultBtn').disabled = false;
  document.getElementById('clinicalNotesSection')?.classList.add('hidden');
  document.getElementById('chartUpdatePreview')?.classList.add('hidden');

  // Both modes: AI is always the doctor
  document.getElementById('doctorAvatarLabel').textContent = '🤖';
  document.getElementById('doctorCardName').textContent    = 'AI Virtual Doctor';
  document.getElementById('doctorCardRole').textContent    = 'Powered by n8n + GPT-4o';
  document.getElementById('patientCard')?.classList.add('participant-active');
  document.getElementById('patientMicStatus').className   = 'mic-indicator off';
  document.getElementById('doctorMicStatus').className    = 'mic-indicator off';
  document.getElementById('voiceWave').classList.remove('hidden');

  if (consultState.mode === 'speak') {
    // Patient speaks via mic — AI doctor listens and replies
    document.getElementById('patientMicStatus').className = 'mic-indicator on';
    document.getElementById('currentSpeakerLabel').textContent = '🧑 Patient speaking — AI Doctor will reply';
    startSpeechRecognition('patient');
  } else {
    // Patient types — mic off, text box is the input
    document.getElementById('currentSpeakerLabel').textContent = '🧑 Patient types below — AI Doctor will reply';
  }

  // AI doctor always sends the opening greeting
  askVirtualDoctor('START_CONSULTATION');

  startTimer();
  renderTranscript();
}

function toggleSpeaker() {
  consultState.currentSpeaker = consultState.currentSpeaker === 'doctor' ? 'patient' : 'doctor';
  updateSpeakerUI();
  stopSpeechRecognition();
  startSpeechRecognition(consultState.currentSpeaker);
}

function updateSpeakerUI() {
  const sp = consultState.currentSpeaker;
  document.getElementById('currentSpeakerLabel').textContent =
    sp === 'doctor' ? '🩺 Dr. Provider speaking' : '🧑 Patient speaking';
  document.getElementById('toggleSpeakerBtn').textContent =
    sp === 'doctor' ? 'Switch to Patient' : 'Switch to Doctor';
  document.getElementById('doctorCard')?.classList.toggle('participant-active', sp === 'doctor');
  document.getElementById('patientCard')?.classList.toggle('participant-active', sp === 'patient');
  document.getElementById('doctorMicStatus').className = `mic-indicator ${sp === 'doctor' ? 'on' : 'off'}`;
  document.getElementById('patientMicStatus').className = `mic-indicator ${sp === 'patient' ? 'on' : 'off'}`;
  document.getElementById('voiceWave').classList.remove('hidden');
  const sel = document.getElementById('textInputSpeaker');
  if (sel) sel.value = sp;
}

function endConsultation() {
  consultState.active = false;
  stopSpeechRecognition();
  stopTimer();
  window.speechSynthesis?.cancel();
  setConsultStatus('done', '✓ Ended');

  document.querySelectorAll('.mode-btn').forEach((b) => b.disabled = false);
  document.getElementById('startConsultBtn').classList.remove('hidden');
  document.getElementById('startConsultBtn').textContent = '🎙 New Consultation';
  document.getElementById('toggleSpeakerBtn').classList.add('hidden');
  document.getElementById('endConsultBtn').classList.add('hidden');
  document.getElementById('voiceWave').classList.add('hidden');
  document.getElementById('currentSpeakerLabel').textContent = 'Consultation ended';
  document.getElementById('consultTextInput').disabled = true;
  document.getElementById('addTranscriptLineBtn').disabled = true;
  document.getElementById('doctorMicStatus').className = 'mic-indicator off';
  document.getElementById('patientMicStatus').className = 'mic-indicator off';
  document.getElementById('doctorCard')?.classList.remove('participant-active');
  document.getElementById('patientCard')?.classList.remove('participant-active', 'listening-mode');
  document.getElementById('aiDoctorBubble')?.classList.add('hidden');

  if (consultState.transcript.length > 0) {
    generateClinicalNotes();
    extractChartUpdates();
  }
}

function clearTranscript() {
  consultState.transcript = [];
  renderTranscript();
  document.getElementById('clinicalNotesSection').classList.add('hidden');
  document.getElementById('chartUpdatePreview').classList.add('hidden');
}

// ── TEXT INPUT ──────────────────────────────────────────────────
function addTextLine() {
  const input = document.getElementById('consultTextInput');
  const text  = input?.value?.trim();
  if (!text) return;
  // Text input is always patient in both modes
  addTranscriptEntry('patient', text);
  if (input) input.value = '';
  // Always trigger AI doctor reply
  if (consultState.active && !consultState.aiThinking) {
    askVirtualDoctor(text);
  }
}

// ── TRANSCRIPT ──────────────────────────────────────────────────
function addTranscriptEntry(speaker, text) {
  const entry = {
    speaker,
    text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
  consultState.transcript.push(entry);
  renderTranscript();
}

function renderTranscript() {
  const el = document.getElementById('consultTranscript');
  if (!el) return;
  if (!consultState.transcript.length) {
    el.innerHTML = '<p class="no-data">Start a consultation to see the live transcript here…</p>';
    return;
  }
  el.innerHTML = consultState.transcript.map((entry) => {
    const isAI = entry.speaker === 'ai-doctor';
    const speakerLabel = isAI ? '🤖 AI Doctor' : entry.speaker === 'doctor' ? '🩺 Dr. Provider' : '🧑 Patient';
    const cls = isAI ? 'ai-doctor' : entry.speaker;
    return `<div class="transcript-line ${cls}">
      <span class="transcript-speaker">${speakerLabel}</span>
      <span class="transcript-time">${entry.time}</span>
      <div class="transcript-text">${escapeHtml(entry.text)}</div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

// ── VIRTUAL DOCTOR ──────────────────────────────────────────────
async function askVirtualDoctor(patientInput) {
  if (!selectedPatient || consultState.aiThinking) return;
  consultState.aiThinking = true;

  // Show thinking bubble
  const bubble   = document.getElementById('aiDoctorBubble');
  const bubbleTxt = document.getElementById('aiDoctorText');
  bubble.classList.remove('hidden');
  bubble.classList.add('thinking');
  bubbleTxt.textContent = 'Thinking…';

  // Pause mic while AI is "speaking"
  stopSpeechRecognition();

  try {
    const res = await fetch(`${N8N_BASE}/webhook/virtual-doctor-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId:     selectedPatient.id,
        fhirBase:      FHIR_BASE,
        patientName:   formatPatientName(selectedPatient),
        patientInput,
        transcript:    buildTranscriptText(),
        rawTranscript: consultState.transcript,
        today:         new Date().toISOString().split('T')[0],
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) throw new Error(`n8n returned HTTP ${res.status}. Activate the "virtual-doctor-turn" webhook in n8n.`);
    const raw  = await res.json().catch(() => { throw new Error('n8n returned a non-JSON response. Check the virtual-doctor-turn workflow.'); });
    const data = Array.isArray(raw) ? raw[0] : raw;
    const reply = data.reply || data.text || "I didn't get a response. Please try again.";
    const done  = data.done === true; // n8n signals consultation complete

    // Show in bubble
    bubble.classList.remove('thinking');
    bubbleTxt.textContent = reply;

    // Add to transcript
    addTranscriptEntry('ai-doctor', reply);

    // Speak the reply aloud
    speakText(reply, () => {
      consultState.aiThinking = false;
      if (done) {
        // AI has collected all info — auto-end
        bubble.classList.add('hidden');
        endConsultation();
      } else if (consultState.active) {
        // Resume listening to patient
        startSpeechRecognition('patient');
        document.getElementById('consultTextInput').disabled = false;
        document.getElementById('addTranscriptLineBtn').disabled = false;
      }
    });

  } catch (err) {
    consultState.aiThinking = false;
    bubble.classList.remove('thinking');
    bubbleTxt.textContent = '⚠ Could not reach AI Doctor. Check n8n virtual-doctor-turn webhook.';
    console.error('Virtual doctor error:', err);
    // Resume mic anyway
    if (consultState.active) startSpeechRecognition('patient');
  }
}

function speakText(text, onDone) {
  if (!window.speechSynthesis) { onDone?.(); return; }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang  = 'en-US';
  utt.rate  = 0.95;
  utt.pitch = 1.05;
  // Prefer a female voice for the AI doctor
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find((v) => v.lang.startsWith('en') && /female|zira|samantha|karen|victoria/i.test(v.name))
    || voices.find((v) => v.lang.startsWith('en'));
  if (preferred) utt.voice = preferred;
  utt.onend   = () => onDone?.();
  utt.onerror = () => onDone?.();
  window.speechSynthesis.speak(utt);

  // Safari/Chrome bug: synthesis can stall — watchdog
  let started = false;
  utt.onstart = () => { started = true; };
  setTimeout(() => { if (!started) onDone?.(); }, 8000);
}

// ── SPEECH RECOGNITION ──────────────────────────────────────────
function startSpeechRecognition(speakerOverride) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  const recognition = new SpeechRecognition();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';

  recognition.onresult = (event) => {
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) final += event.results[i][0].transcript;
    }
    if (!final.trim()) return;

    const speaker = speakerOverride || consultState.currentSpeaker;
    addTranscriptEntry(speaker, final.trim());

    // Both modes: after patient speaks, get AI doctor reply
    if (speaker === 'patient' && consultState.active && !consultState.aiThinking) {
      // Pause mic so AI can reply without hearing itself
      stopSpeechRecognition();
      document.getElementById('consultTextInput').disabled = true;
      document.getElementById('addTranscriptLineBtn').disabled = true;
      askVirtualDoctor(final.trim());
    }
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') console.warn('Speech recognition error:', e.error);
  };

  recognition.onend = () => {
    if (consultState.active && consultState.recognition === recognition && !consultState.aiThinking) {
      try { recognition.start(); } catch { /* ignore */ }
    }
  };

  try {
    recognition.start();
    consultState.recognition = recognition;
  } catch (e) {
    console.warn('Could not start speech recognition:', e);
  }
}

function stopSpeechRecognition() {
  try { consultState.recognition?.stop(); } catch { /* ignore */ }
  consultState.recognition = null;
}

// ── TIMER ───────────────────────────────────────────────────────
function startTimer() {
  const durationEl = document.getElementById('consultDuration');
  consultState.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - consultState.startTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    if (durationEl) durationEl.textContent = `${m}:${s}`;
  }, 1000);
}
function stopTimer() { clearInterval(consultState.timerInterval); }

function setConsultStatus(cls, label) {
  const el = document.getElementById('consultStatus');
  if (!el) return;
  el.textContent = label;
  el.className = `consult-status-badge ${cls}`;
}

function buildTranscriptText() {
  return consultState.transcript.map((e) => {
    const label = e.speaker === 'ai-doctor' ? 'AI Doctor' : e.speaker === 'doctor' ? 'Doctor' : 'Patient';
    return `[${e.time}] ${label}: ${e.text}`;
  }).join('\n');
}

// ── CLINICAL NOTES ──────────────────────────────────────────────
async function generateClinicalNotes() {
  if (!selectedPatient || !consultState.transcript.length) return;
  const notesSection = document.getElementById('clinicalNotesSection');
  const notesContent = document.getElementById('clinicalNotesContent');
  notesSection.classList.remove('hidden');
  notesContent.innerHTML = '<p class="no-data plugin-loading"><span class="epic-spinner-inline"></span> Generating SOAP notes via n8n…</p>';
  try {
    const res = await fetch(`${N8N_BASE}/webhook/generate-clinical-notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId:     selectedPatient.id,
        fhirBase:      FHIR_BASE,
        patientName:   formatPatientName(selectedPatient),
        transcript:    buildTranscriptText(),
        rawTranscript: consultState.transcript,
        today:         new Date().toISOString().split('T')[0],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw  = await res.json();
    const data = Array.isArray(raw) ? raw[0] : raw;
    notesContent.innerHTML = data.html
      ? `<div class="plugin-html-output">${data.html}</div>`
      : `<pre class="plugin-text-output">${escapeHtml(data.text || JSON.stringify(data, null, 2))}</pre>`;
  } catch (err) {
    notesContent.innerHTML = `<div class="plugin-error">
      <strong>Could not reach n8n workflow.</strong><br>
      <small>Activate <code>generate-clinical-notes</code> webhook in n8n.</small><br>
      <small>${escapeHtml(err.message)}</small>
    </div>`;
  }
}

// ── CHART UPDATES ───────────────────────────────────────────────
async function extractChartUpdates() {
  if (!selectedPatient || !consultState.transcript.length) return;
  const previewSection = document.getElementById('chartUpdatePreview');
  const previewContent = document.getElementById('chartUpdateContent');
  previewSection.classList.remove('hidden');
  previewContent.innerHTML = '<p class="no-data plugin-loading"><span class="epic-spinner-inline"></span> Extracting chart updates via n8n…</p>';
  try {
    const res = await fetch(`${N8N_BASE}/webhook/extract-chart-updates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId:     selectedPatient.id,
        fhirBase:      FHIR_BASE,
        patientName:   formatPatientName(selectedPatient),
        transcript:    buildTranscriptText(),
        rawTranscript: consultState.transcript,
        today:         new Date().toISOString().split('T')[0],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw  = await res.json();
    const data = Array.isArray(raw) ? raw[0] : raw;
    consultState.pendingChartUpdates = data.resources || [];
    previewContent.innerHTML = data.html
      ? `<div class="plugin-html-output">${data.html}</div>`
      : `<pre class="plugin-text-output">${escapeHtml(data.text || JSON.stringify(data, null, 2))}</pre>`;
  } catch (err) {
    previewContent.innerHTML = `<div class="plugin-error">
      <strong>Could not reach n8n workflow.</strong><br>
      <small>Activate <code>extract-chart-updates</code> webhook in n8n.</small><br>
      <small>${escapeHtml(err.message)}</small>
    </div>`;
  }
}

async function applyConsultUpdates() {
  const resources = consultState.pendingChartUpdates;
  if (!resources?.length) { showEntryFeedback('No FHIR resources to apply.', 'error'); return; }
  document.getElementById('applyConsultUpdatesBtn').disabled = true;
  try {
    await Promise.all(resources.map((r) => fhirPost(r.resourceType, r)));
    showEntryFeedback(`✓ ${resources.length} update(s) from consultation applied to chart.`);
    loadLabs(); loadVitals(); loadMedications(); loadProblems(); loadAllergies(); loadOverview();
    document.getElementById('chartUpdatePreview').classList.add('hidden');
    consultState.pendingChartUpdates = [];
  } catch (err) { showEntryFeedback(`Failed to apply: ${err.message}`, 'error'); }
  finally { document.getElementById('applyConsultUpdatesBtn').disabled = false; }
}

async function saveNotesToFhir() {
  if (!selectedPatient) return;
  const notesEl   = document.getElementById('clinicalNotesContent');
  const notesText = notesEl?.innerText?.trim();
  if (!notesText) return;
  const docRef = {
    resourceType: 'DocumentReference',
    status: 'current',
    type: { coding: [{ system: 'http://loinc.org', code: '11488-4', display: 'Consult Note' }], text: 'Clinical Consultation Notes' },
    subject: { reference: `Patient/${selectedPatient.id}` },
    date: new Date().toISOString(),
    content: [{ attachment: { contentType: 'text/plain', data: btoa(unescape(encodeURIComponent(notesText))), title: 'Clinical Notes' } }],
  };
  document.getElementById('saveNotesToFhirBtn').disabled = true;
  try {
    await fhirPost('DocumentReference', docRef);
    showEntryFeedback('✓ Clinical notes saved to chart as DocumentReference.');
  } catch (err) { showEntryFeedback(`Failed to save notes: ${err.message}`, 'error'); }
  finally { document.getElementById('saveNotesToFhirBtn').disabled = false; }
}

function copyClinicalNotes() {
  const text = document.getElementById('clinicalNotesContent')?.innerText?.trim();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn  = document.getElementById('copyNotesBtn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

function formatPatientName(p) {
  const human = p.name?.find((n) => n.use === 'official') || p.name?.[0];
  if (!human) return 'Unknown';
  return [human.family, ...(human.given || [])].filter(Boolean).join(', ');
}
function getPatientAge(birthDate) {
  if (!birthDate) return '—';
  const today = new Date(), dob = new Date(birthDate);
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}
function formatObsValue(o) {
  if (o.valueQuantity) return `${o.valueQuantity.value} ${o.valueQuantity.unit || ''}`.trim();
  if (o.valueString)   return o.valueString;
  return o.valueCodeableConcept?.text || '—';
}
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
function showLoading(show) { elements.loadingOverlay?.classList.toggle('hidden', !show); }
