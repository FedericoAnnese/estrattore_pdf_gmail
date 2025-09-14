// popup.js

const logEl = document.getElementById('log');
const queryEl = document.getElementById('query');
const nameFilterEl = document.getElementById('nameFilter');
const authBtn = document.getElementById('authBtn');
const searchBtn = document.getElementById('searchBtn');
const downloadBtn = document.getElementById('downloadBtn');

let state = {
  token: null,
  messages: [],
  attachments: []
};

function log(msg, cls = '') {
  const p = document.createElement('div');
  if (cls) p.className = cls;
  p.textContent = msg;
  logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() { logEl.textContent = ''; }

async function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(token);
    });
  });
}

async function gmailFetch(path, params = {}, method = 'GET') {
  if (!state.token) {
    state.token = await getToken(true);
  }
  const url = new URL(`https://www.googleapis.com/gmail/v1/users/me/${path}`);
  if (method === 'GET' && params && Object.keys(params).length) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const resp = await fetch(url.toString(), {
    method,
    headers: { 'Authorization': `Bearer ${state.token}` }
  });
  if (resp.status === 401) {
    await new Promise((res) => chrome.identity.removeCachedAuthToken({ token: state.token }, res));
    state.token = await getToken(true);
    return gmailFetch(path, params, method);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail API ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function listAllMessages(q) {
  let nextPageToken = null;
  const acc = [];
  do {
    const page = await gmailFetch('messages', { q, maxResults: 500, pageToken: nextPageToken });
    if (page.messages) acc.push(...page.messages);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return acc;
}

async function getMessage(id) {
  return gmailFetch(`messages/${id}`, { format: 'full' });
}

function collectPdfAttachments(message) {
  const results = [];
  function walk(part) {
    if (!part) return;
    if (part.filename && part.filename.toLowerCase().endsWith('.pdf') && part.body && part.body.attachmentId) {
      results.push({ attachmentId: part.body.attachmentId, filename: part.filename });
    }
    if (part.parts && Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(message.payload);
  return results;
}

async function getAttachment(messageId, attachmentId) {
  return gmailFetch(`messages/${messageId}/attachments/${attachmentId}`);
}

async function downloadBlob(filename, base64Data) {
  const urlSafe = base64Data.replace(/-/g, '+').replace(/_/g, '/');
  const blobUrl = `data:application/pdf;base64,${urlSafe}`;
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(downloadId);
    });
  });
}

function applyNameFilter(files, pattern) {
  if (!pattern) return files;
  try {
    const re = new RegExp(pattern, 'i');
    return files.filter(f => re.test(f.filename));
  } catch (e) {
    log(`Regex non valida: ${e.message}`, 'warn');
    return files;
  }
}

authBtn.addEventListener('click', async () => {
  clearLog();
  try {
    state.token = await getToken(true);
    log('Autenticazione riuscita.', 'ok');
  } catch (e) {
    log(`Errore autenticazione: ${e.message}`, 'warn');
  }
});

searchBtn.addEventListener('click', async () => {
  clearLog();
  state.messages = [];
  state.attachments = [];
  const q = queryEl.value && queryEl.value.trim() ? queryEl.value.trim() : 'filename:pdf';
  log(`Query: ${q}`);
  try {
    const msgs = await listAllMessages(q);
    state.messages = msgs;
    log(`Email trovate: ${msgs.length}`);
    let totalPdf = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = await getMessage(msgs[i].id);
      const pdfs = collectPdfAttachments(m);
      totalPdf += pdfs.length;
      pdfs.forEach(p => state.attachments.push({ messageId: m.id, ...p }));
      if (i % 25 === 0) log(`Analizzate ${i + 1}/${msgs.length} email…`);
    }
    const filtered = applyNameFilter(state.attachments, nameFilterEl.value.trim());
    state.attachments = filtered;
    log(`Allegati PDF (post-filtro): ${state.attachments.length}`);
    downloadBtn.disabled = state.attachments.length === 0;
  } catch (e) {
    log(`Errore ricerca: ${e.message}`, 'warn');
  }
});

downloadBtn.addEventListener('click', async () => {
  clearLog();
  if (!state.attachments.length) { log('Nessun PDF da scaricare.'); return; }
  log(`Download di ${state.attachments.length} PDF…`);
  let ok = 0, fail = 0;
  for (let i = 0; i < state.attachments.length; i++) {
    const a = state.attachments[i];
    try {
      const data = await getAttachment(a.messageId, a.attachmentId);
      await downloadBlob(a.filename || `allegato_${i + 1}.pdf`, data.data);
      ok++;
      if (i % 5 === 0) log(`Scaricati ${ok}/${state.attachments.length}…`);
    } catch (e) {
      fail++;
      log(`Errore download ${a.filename || a.attachmentId}: ${e.message}`, 'warn');
    }
  }
  log(`Completato. OK: ${ok}, Errori: ${fail}`,'ok');
});
