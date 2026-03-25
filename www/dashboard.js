/**
 * EpicCare Dashboard — EPIC EHR-style interface
 * Connects to HAPI FHIR R4 server + n8n plugin registry
 *
 * ═══════════════════════════════════════════════════════════════
 *  n8n PLUGIN REGISTRY — HOW IT WORKS
 * ═══════════════════════════════════════════════════════════════
 *
 *  Any n8n workflow can register a new panel in this dashboard.
 *  The dashboard polls GET /webhook/list-panels every 30 seconds
 *  and injects sidebar links + content panels for each plugin.
 *
 *  STEP 1 — In your n8n workflow, add a Webhook node with:
 *    • Path:   register-panel   (GET, no auth)
 *    • Method: GET
 *
 *  STEP 2 — Respond with JSON describing your panel:
 *  {
 *    "panels": [
 *      {
 *        "id":          "my-risk-score",          // unique slug, no spaces
 *        "label":       "Risk Score",             // sidebar link text
 *        "title":       "Sepsis Risk Score",      // panel heading
 *        "description": "ML model via n8n",       // subtitle
 *        "webhook":     "my-risk-score-run",      // POST endpoint slug
 *        "trigger":     "auto" | "button",        // auto=load on patient select, button=on demand
 *        "buttonLabel": "Calculate Risk"          // only used when trigger=button
 *      }
 *    ]
 *  }
 *
 *  STEP 3 — Add a second Webhook node (POST) at path: my-risk-score-run
 *    Receives: { patientId, fhirBase, patientData }
 *    Returns:  { html: "<p>Score: 78%</p>" }
 *             OR { cards: [...CDS cards...] }
 *             OR { text: "Plain text result" }
 *             OR { table: { headers: [...], rows: [[...]] } }
 *
 *  That's it. On next poll (≤30s) your panel appears in the sidebar.
 * ═══════════════════════════════════════════════════════════════
 */

const FHIR_BASE  = `${window.location.origin}/api/fhir`;
const N8N_BASE   = `${window.location.origin}/api/n8n`;
const POLL_MS    = 30000;

let selectedPatient = null;
const patientCache  = new Map();

// Registry of dynamic plugins: Map<id, pluginDescriptor>
const pluginRegistry = new Map();

// ─── DOM REFS ─────────────────────────────────────────────────
const elements = {
  currentDate:          document.getElementById('currentDate'),
  patientSearch:        document.getElementById('patientSearch'),
  searchBtn:            document.getElementById('searchBtn'),
  addPatientBtn:        document.getElementById('addPatientBtn'),
  patientList:          document.getElementById('patientList'),
  patientListSection:   document.getElementById('patientListSection'),
  patientChartSection:  document.getElementById('patientChartSection'),
  patientBanner:        document.getElementById('patientBanner'),
  bannerMRN:            document.getElementById('bannerMRN'),
  bannerName:           document.getElementById('bannerName'),
  bannerDOB:            document.getElementById('bannerDOB'),
  bannerAge:            document.getElementById('bannerAge'),
  bannerSex:            document.getElementById('bannerSex'),
  bannerPhone:          document.getElementById('bannerPhone'),
  editPatientBtn:       document.getElementById('editPatientBtn'),
  deletePatientBtn:     document.getElementById('deletePatientBtn'),
  clearPatientBtn:      document.getElementById('clearPatientBtn'),
  patientModal:         document.getElementById('patientModal'),
  patientModalTitle:    document.getElementById('patientModalTitle'),
  patientForm:          document.getElementById('patientForm'),
  closePatientModal:    document.getElementById('closePatientModal'),
  cancelPatientModal:   document.getElementById('cancelPatientModal'),
  savePatientBtn:       document.getElementById('savePatientBtn'),
  loadingOverlay:       document.getElementById('loadingOverlay'),
  generateDischargeBtn: document.getElementById('generateDischargeBtn'),
  generatePrevisitBtn:  document.getElementById('generatePrevisitBtn'),
  dischargeContent:     document.getElementById('dischargeContent'),
  previsitContent:      document.getElementById('previsitContent'),
  dynamicPluginLinks:   document.getElementById('dynamicPluginLinks'),
  dynamicPanelContainer:document.getElementById('dynamicPanelContainer'),
  refreshPluginsBtn:    document.getElementById('refreshPluginsBtn'),
  pluginStatus:         document.getElementById('pluginStatus'),
};

// ─── BOOT ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setCurrentDate();
  bindEvents();
  loadInitialPatients();
  pollPluginRegistry();
  setInterval(pollPluginRegistry, POLL_MS);
});

function setCurrentDate() {
  const now = new Date();
  if (elements.currentDate) {
    elements.currentDate.textContent = now.toLocaleDateString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    });
  }
}

function bindEvents() {
  elements.searchBtn?.addEventListener('click', handleSearch);
  elements.patientSearch?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSearch();
  });
  elements.clearPatientBtn?.addEventListener('click', clearPatient);
  elements.addPatientBtn?.addEventListener('click', openAddPatientModal);
  elements.editPatientBtn?.addEventListener('click', openEditPatientModal);
  elements.deletePatientBtn?.addEventListener('click', deletePatient);
  elements.closePatientModal?.addEventListener('click', closePatientModal);
  elements.cancelPatientModal?.addEventListener('click', closePatientModal);
  elements.savePatientBtn?.addEventListener('click', savePatient);
  elements.patientModal?.querySelector('.epic-modal-overlay')?.addEventListener('click', closePatientModal);
  elements.generateDischargeBtn?.addEventListener('click', () => generateAISummary('discharge'));
  elements.generatePrevisitBtn?.addEventListener('click', () => generateAISummary('previsit'));
  elements.refreshPluginsBtn?.addEventListener('click', () => pollPluginRegistry(true));

  document.querySelectorAll('.activity-item[data-tab]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(item.dataset.tab);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  PLUGIN REGISTRY
// ═══════════════════════════════════════════════════════════════

async function pollPluginRegistry(manual = false) {
  try {
    const res = await fetch(`${N8N_BASE}/webhook/list-panels`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const panels = Array.isArray(data.panels) ? data.panels : [];
    reconcilePlugins(panels);
    if (manual) setPluginStatus(`${panels.length} plugin(s) loaded`, 'ok');
  } catch (err) {
    // n8n may not have the list-panels workflow — that's fine, silently skip
    if (manual) setPluginStatus('No plugin registry found', 'warn');
  }
}

/**
 * Diff the incoming panel list against the current registry.
 * Add new panels, remove stale ones, leave existing ones alone.
 */
function reconcilePlugins(panels) {
  const incomingIds = new Set(panels.map((p) => p.id));

  // Remove plugins no longer registered
  for (const [id] of pluginRegistry) {
    if (!incomingIds.has(id)) {
      removePlugin(id);
    }
  }

  // Add new plugins
  for (const panel of panels) {
    if (!panel.id || !panel.label || !panel.webhook) continue;
    if (!pluginRegistry.has(panel.id)) {
      registerPlugin(panel);
    }
  }
}

function registerPlugin(plugin) {
  pluginRegistry.set(plugin.id, plugin);
  injectPluginLink(plugin);
  injectPluginPanel(plugin);
}

function removePlugin(id) {
  pluginRegistry.delete(id);
  document.getElementById(`plugin-link-${id}`)?.remove();
  document.getElementById(`${id}Panel`)?.remove();
}

/** Inject a sidebar link for the plugin */
function injectPluginLink(plugin) {
  if (document.getElementById(`plugin-link-${plugin.id}`)) return;
  const a = document.createElement('a');
  a.href = '#';
  a.className = 'activity-item plugin-item';
  a.id = `plugin-link-${plugin.id}`;
  a.dataset.tab = plugin.id;
  a.innerHTML = `${escapeHtml(plugin.label)} <span class="plugin-badge">n8n</span>`;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    switchTab(plugin.id);
  });
  elements.dynamicPluginLinks.appendChild(a);
}

/** Inject a full panel div for the plugin */
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
      <button type="button"
        class="epic-btn epic-btn-primary plugin-run-btn"
        data-plugin-id="${plugin.id}"
        disabled>
        ${escapeHtml(plugin.buttonLabel || `Run ${plugin.label}`)}
      </button>` : ''}
    <div id="${plugin.id}Content" class="epic-data-content epic-plugin-output">
      <p class="no-data">Select a patient to use this feature.</p>
    </div>
  `;

  elements.dynamicPanelContainer.appendChild(panel);

  // Wire up button if present
  panel.querySelector('.plugin-run-btn')?.addEventListener('click', () => {
    runPlugin(plugin.id);
  });
}

/** Enable/disable plugin buttons when a patient is selected/cleared */
function updatePluginButtons(enabled) {
  document.querySelectorAll('.plugin-run-btn').forEach((btn) => {
    btn.disabled = !enabled;
  });
}

/** Called when a patient is selected — auto-run "auto" trigger plugins */
function runAutoPlugins() {
  for (const [id, plugin] of pluginRegistry) {
    if (plugin.trigger === 'auto' || !plugin.trigger) {
      runPlugin(id);
    }
  }
}

/**
 * Call the plugin's n8n webhook with the current patient context.
 * Supports four response formats from n8n:
 *   { html }   → render raw HTML
 *   { text }   → render preformatted text
 *   { cards }  → render CDS-style cards
 *   { table }  → render a data table
 */
async function runPlugin(pluginId) {
  const plugin = pluginRegistry.get(pluginId);
  if (!plugin || !selectedPatient) return;

  const contentEl = document.getElementById(`${pluginId}Content`);
  if (!contentEl) return;

  contentEl.innerHTML = `<p class="no-data plugin-loading">
    <span class="epic-spinner-inline"></span> Running ${escapeHtml(plugin.label)}…
  </p>`;

  try {
    const payload = {
      patientId:   selectedPatient.id,
      fhirBase:    FHIR_BASE,
      patientData: selectedPatient,
    };

    const res = await fetch(`${N8N_BASE}/webhook/${plugin.webhook}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
    const data = await res.json();
    contentEl.innerHTML = renderPluginResponse(data, plugin);

  } catch (err) {
    contentEl.innerHTML = `
      <div class="plugin-error">
        <strong>Plugin failed:</strong> ${escapeHtml(err.message)}<br>
        <small>Check that your n8n workflow at <code>${N8N_BASE}/webhook/${plugin.webhook}</code> is active.</small>
      </div>`;
  }
}

/** Render whatever format the n8n workflow returns */
function renderPluginResponse(data, plugin) {
  // Format 1: { html: "<p>...</p>" }
  if (data.html) {
    return `<div class="plugin-html-output">${data.html}</div>`;
  }

  // Format 2: { cards: [{summary, indicator, detail, source}] }
  if (data.cards && Array.isArray(data.cards)) {
    return data.cards.map((card) => {
      const cls = card.indicator === 'warning' ? 'card-warn'
                : card.indicator === 'critical' ? 'card-crit'
                : 'card-info';
      return `
        <div class="plugin-card ${cls}">
          <div class="plugin-card-summary">${escapeHtml(card.summary || '')}</div>
          ${card.detail ? `<div class="plugin-card-detail">${escapeHtml(card.detail)}</div>` : ''}
          ${card.source?.label ? `<div class="plugin-card-source">◦ ${escapeHtml(card.source.label)}</div>` : ''}
        </div>`;
    }).join('');
  }

  // Format 3: { table: { headers: [...], rows: [[...]] } }
  if (data.table && data.table.headers) {
    const { headers, rows } = data.table;
    return `
      <div class="plugin-table-wrap">
        <table class="plugin-table">
          <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
          <tbody>${(rows || []).map((row) =>
            `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`
          ).join('')}</tbody>
        </table>
      </div>`;
  }

  // Format 4: { text: "..." }
  if (data.text) {
    return `<pre class="plugin-text-output">${escapeHtml(data.text)}</pre>`;
  }

  // Fallback: pretty-print JSON
  return `<pre class="plugin-text-output">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
}

function setPluginStatus(msg, type = 'ok') {
  const el = elements.pluginStatus;
  if (!el) return;
  el.textContent = msg;
  el.className = `plugin-status plugin-status-${type}`;
  setTimeout(() => { el.textContent = ''; el.className = 'plugin-status'; }, 4000);
}

// ═══════════════════════════════════════════════════════════════
//  PATIENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function loadInitialPatients() {
  await fetchAndRenderPatients('');
}

async function handleSearch() {
  const query = elements.patientSearch?.value?.trim() ?? '';
  await fetchAndRenderPatients(query);
}

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
    if (patients.length === 0) {
      elements.patientList.innerHTML = '<div class="empty-message">No patients found.</div>';
    }
  } catch (err) {
    elements.patientList.innerHTML = `<div class="error-msg">Unable to fetch patients. Ensure the FHIR server is running. Error: ${err.message}</div>`;
  } finally {
    showLoading(false);
  }
}

function renderPatientList(patients) {
  if (!elements.patientList) return;
  patientCache.clear();
  patients.forEach((p) => patientCache.set(p.id, p));
  elements.patientList.innerHTML = patients.map((p) => {
    const name = formatPatientName(p);
    return `
      <div class="epic-patient-item" data-id="${p.id}">
        <div>
          <div class="patient-item-name">${escapeHtml(name)}</div>
          <div class="patient-item-meta">DOB: ${p.birthDate || '—'} | ${p.gender || '—'}</div>
        </div>
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

  elements.generateDischargeBtn.disabled = false;
  elements.generatePrevisitBtn.disabled = false;
  updatePluginButtons(true);

  loadAllergies();
  loadOverview();
  loadMedications();
  loadLabs();
  loadProblems();
  loadVitals();
  loadDemographics();
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
  elements.generateDischargeBtn.disabled = true;
  elements.generatePrevisitBtn.disabled = true;
  elements.dischargeContent.textContent = '';
  elements.previsitContent.textContent = '';
  updatePluginButtons(false);

  // Reset plugin outputs
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
  document.querySelectorAll('.activity-item').forEach((i) => i.classList.remove('active'));
  document.querySelectorAll('.epic-tab-panel').forEach((p) => p.classList.remove('active'));
  const item  = document.querySelector(`.activity-item[data-tab="${tabId}"]`);
  const panel = document.getElementById(`${tabId}Panel`);
  item?.classList.add('active');
  panel?.classList.add('active');
}

// ═══════════════════════════════════════════════════════════════
//  FHIR HELPERS
// ═══════════════════════════════════════════════════════════════

async function fhirGet(resource, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const res = await fetch(`${FHIR_BASE}/${resource}${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fhirPost(resource, body) {
  const res = await fetch(`${FHIR_BASE}/${resource}`, {
    method: 'POST', headers: { 'Content-Type': 'application/fhir+json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fhirPut(resource, id, body) {
  const res = await fetch(`${FHIR_BASE}/${resource}/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/fhir+json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fhirDelete(resource, id) {
  const res = await fetch(`${FHIR_BASE}/${resource}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ═══════════════════════════════════════════════════════════════
//  PATIENT CRUD MODAL
// ═══════════════════════════════════════════════════════════════

function openAddPatientModal() {
  elements.patientModalTitle.textContent = 'Add Patient';
  ['patientFormId','patientFamily','patientGiven','patientBirthDate',
   'patientPhone','patientAddress'].forEach((id) => document.getElementById(id).value = '');
  document.getElementById('patientGender').value = '';
  elements.patientModal?.classList.remove('hidden');
}
function openEditPatientModal() {
  if (!selectedPatient) return;
  elements.patientModalTitle.textContent = 'Edit Patient';
  const p    = selectedPatient;
  const name = p.name?.find((n) => n.use === 'official') || p.name?.[0];
  document.getElementById('patientFormId').value    = p.id;
  document.getElementById('patientFamily').value    = name?.family || '';
  document.getElementById('patientGiven').value     = (name?.given || []).join(' ');
  document.getElementById('patientBirthDate').value = p.birthDate || '';
  document.getElementById('patientGender').value    = p.gender || '';
  document.getElementById('patientPhone').value     = p.telecom?.find((t) => t.system === 'phone')?.value || '';
  const addr = p.address?.[0];
  document.getElementById('patientAddress').value   = addr
    ? [addr.line?.join(', '), addr.city, addr.state, addr.postalCode].filter(Boolean).join(', ')
    : '';
  elements.patientModal?.classList.remove('hidden');
}
function closePatientModal() { elements.patientModal?.classList.add('hidden'); }

function buildPatientResource() {
  const id        = document.getElementById('patientFormId').value?.trim();
  const family    = document.getElementById('patientFamily').value?.trim();
  const given     = document.getElementById('patientGiven').value?.trim().split(/\s+/).filter(Boolean);
  const birthDate = document.getElementById('patientBirthDate').value || undefined;
  const gender    = document.getElementById('patientGender').value || undefined;
  const phone     = document.getElementById('patientPhone').value?.trim();
  const addrRaw   = document.getElementById('patientAddress').value?.trim();
  const resource  = {
    resourceType: 'Patient',
    name: [{ use: 'official', family: family || undefined, given: given.length ? given : undefined }]
      .filter((n) => n.family || n.given),
  };
  if (birthDate) resource.birthDate = birthDate;
  if (gender)    resource.gender    = gender;
  if (phone)     resource.telecom   = [{ system: 'phone', value: phone }];
  if (addrRaw) {
    const parts = addrRaw.split(',').map((s) => s.trim());
    const addr  = { line: parts[0] ? [parts[0]] : undefined, city: parts[1], state: parts[2], postalCode: parts[3] };
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
  const isEdit   = !!resource.id;
  showLoading(true);
  elements.savePatientBtn.disabled = true;
  try {
    isEdit ? await fhirPut('Patient', resource.id, resource) : await fhirPost('Patient', resource);
    closePatientModal();
    await fetchAndRenderPatients(isEdit ? (elements.patientSearch?.value?.trim() ?? '') : '');
    if (isEdit && selectedPatient?.id === resource.id) selectPatient(patientCache.get(resource.id) || resource);
  } catch (err) {
    alert(`Failed to save patient: ${err.message}`);
  } finally {
    showLoading(false);
    elements.savePatientBtn.disabled = false;
  }
}

async function deletePatient() {
  if (!selectedPatient) return;
  if (!confirm(`Delete patient ${formatPatientName(selectedPatient)} (MRN: ${selectedPatient.id})? This cannot be undone.`)) return;
  showLoading(true);
  try {
    await fhirDelete('Patient', selectedPatient.id);
    clearPatient();
    await fetchAndRenderPatients(elements.patientSearch?.value?.trim() ?? '');
  } catch (err) {
    alert(`Failed to delete patient: ${err.message}`);
  } finally {
    showLoading(false);
  }
}

// ═══════════════════════════════════════════════════════════════
//  FHIR DATA LOADERS
// ═══════════════════════════════════════════════════════════════

async function loadAllergies() {
  const el = document.getElementById('allergiesContent');
  if (!el || !selectedPatient) return;
  el.innerHTML = '<p class="no-data">Loading allergies...</p>';
  try {
    const bundle   = await fhirGet('AllergyIntolerance', { patient: selectedPatient.id, _count: 20 }).catch(() => ({ entry: [] }));
    const allergies = bundle.entry?.map((e) => e.resource) ?? [];
    el.innerHTML = allergies.length
      ? allergies.map((a) => `
          <div class="allergy-item ${a.criticality === 'high' ? 'severe' : ''}">
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
    const encounters  = encBundle.entry?.map((e) => e.resource) ?? [];
    const conditions  = condBundle.entry?.map((e) => e.resource) ?? [];
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
    const meds   = bundle.entry?.map((e) => e.resource) ?? [];
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
    const obs    = bundle.entry?.map((e) => e.resource) ?? [];
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
    const bundle     = await fhirGet('Condition', { patient: selectedPatient.id, _count: 20 });
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
  const p     = selectedPatient;
  const addr  = p.address?.[0];
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

// ─── Built-in AI Summaries ─────────────────────────────────────
async function generateAISummary(type) {
  const btn     = type === 'discharge' ? elements.generateDischargeBtn : elements.generatePrevisitBtn;
  const content = type === 'discharge' ? elements.dischargeContent     : elements.previsitContent;
  const webhook = type === 'discharge' ? 'discharge-summary'           : 'previsit-summary';

  btn.disabled  = true;
  content.innerHTML = '<p class="no-data plugin-loading"><span class="epic-spinner-inline"></span> Generating…</p>';

  try {
    const res = await fetch(`${N8N_BASE}/webhook/${webhook}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ patientId: selectedPatient.id, fhirBase: FHIR_BASE }),
      signal:  AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    content.innerHTML = renderPluginResponse(data, { label: type });
  } catch (err) {
    content.innerHTML = `<div class="plugin-error">
      <strong>Could not reach n8n workflow.</strong><br>
      <small>Activate the <code>${webhook}</code> workflow at <a href="http://${window.location.hostname}:4014" target="_blank">localhost:4014</a></small>
    </div>`;
  } finally {
    btn.disabled = false;
  }
}

// ─── Utilities ────────────────────────────────────────────────
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
function showLoading(show) {
  elements.loadingOverlay?.classList.toggle('hidden', !show);
}


