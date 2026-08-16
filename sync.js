'use strict';

// 여러 기기 동기화: 별도 로그인 없이 "동기화 코드" 하나로 기기들을 같은 Firestore 문서에 묶습니다.
// 코드가 곧 접근 권한이므로 비밀번호처럼 취급해야 합니다 (Firestore 보안 규칙 참고).
const SYNC_CODE_KEY = 'bizEnglishApp_syncCode';
const SYNC_CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 헷갈리는 0/O/1/I/L 제외
const SYNC_PUSH_DEBOUNCE_MS = 2500;

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyA8Qv7f7e1IV49zFTb05ct20cG0BltRwLM',
  authDomain: 'biz-english-app-b4296.firebaseapp.com',
  projectId: 'biz-english-app-b4296',
  storageBucket: 'biz-english-app-b4296.firebasestorage.app',
  messagingSenderId: '462067430454',
  appId: '1:462067430454:web:6000d90741945368b5d497',
};

let db = null;
let syncCode = null;
let unsubscribeSnapshot = null;
let pushTimer = null;
let applyingRemote = false;

function ensureFirebase() {
  if (db) return true;
  if (typeof firebase === 'undefined') return false;
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    try { db.enablePersistence({ synchronizeTabs: false }).catch(() => {}); } catch (e) { /* 다른 탭에서 이미 사용 중이면 무시 */ }
    return true;
  } catch (e) {
    console.warn('Firebase 초기화 실패', e);
    return false;
  }
}

function generateSyncCode() {
  const bytes = new Uint32Array(10);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < bytes.length; i++) code += SYNC_CODE_CHARS[bytes[i] % SYNC_CODE_CHARS.length];
  return code;
}

function getStoredSyncCode() {
  return localStorage.getItem(SYNC_CODE_KEY);
}

function syncPayloadFromState() {
  return {
    words: state.words,
    categories: state.categories,
    reviewLog: state.reviewLog,
    studyDayLog: state.studyDayLog,
    settings: state.settings,
    learnSession: state.learnSession || null,
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
}

function pushToCloud() {
  if (!syncCode || !ensureFirebase()) return;
  db.collection('syncStates').doc(syncCode).set(syncPayloadFromState())
    .catch(e => console.warn('클라우드 저장 실패', e));
}

// saveState()가 호출될 때마다 app.js에서 이 함수를 부릅니다. 원격 데이터를 로컬에 적용하는
// 도중에는(applyingRemote) 다시 클라우드로 밀어올리지 않도록 막아 무한 루프를 방지합니다.
function scheduleCloudPush() {
  if (!syncCode || applyingRemote) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushToCloud, SYNC_PUSH_DEBOUNCE_MS);
}

function applyCloudData(data) {
  applyingRemote = true;
  state.words = data.words || state.words;
  state.categories = data.categories || state.categories;
  state.reviewLog = data.reviewLog || state.reviewLog;
  state.studyDayLog = data.studyDayLog || state.studyDayLog;
  state.settings = data.settings || state.settings;
  state.learnSession = data.learnSession !== undefined ? data.learnSession : state.learnSession;
  syncSeedContent(state); // 이 기기의 최신 SEED_WORDS 기준으로 콘텐츠/카테고리 정합성 재보정
  state.dataVersion = SEED_VERSION;
  state.updatedAt = data.updatedAt || new Date().toISOString();
  saveState();
  applyingRemote = false;
}

function localUpdatedAtMs() {
  return state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
}
function cloudUpdatedAtMs(data) {
  return data && data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
}

function subscribeSync() {
  if (!syncCode || !ensureFirebase()) return;
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  unsubscribeSnapshot = db.collection('syncStates').doc(syncCode).onSnapshot(snap => {
    if (!snap.exists || snap.metadata.hasPendingWrites) return;
    const data = snap.data();
    if (cloudUpdatedAtMs(data) > localUpdatedAtMs()) {
      applyCloudData(data);
      const activeTab = document.querySelector('.tab-btn.active');
      if (activeTab) switchTab(activeTab.dataset.tab);
    }
  }, err => console.warn('동기화 구독 오류', err));
}

async function startNewSync() {
  if (!ensureFirebase()) { alert('인터넷 연결을 확인해주세요.'); return null; }
  const code = generateSyncCode();
  await db.collection('syncStates').doc(code).set(syncPayloadFromState());
  syncCode = code;
  localStorage.setItem(SYNC_CODE_KEY, code);
  subscribeSync();
  return code;
}

async function joinExistingSync(rawCode) {
  if (!ensureFirebase()) return { ok: false, reason: 'offline' };
  const code = rawCode.trim().toUpperCase();
  let docSnap;
  try {
    docSnap = await db.collection('syncStates').doc(code).get();
  } catch (e) {
    return { ok: false, reason: 'offline' };
  }
  if (!docSnap.exists) return { ok: false, reason: 'not-found' };
  syncCode = code;
  localStorage.setItem(SYNC_CODE_KEY, code);
  applyCloudData(docSnap.data());
  subscribeSync();
  return { ok: true };
}

function stopSync() {
  if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
  syncCode = null;
  localStorage.removeItem(SYNC_CODE_KEY);
}

function initSync() {
  const stored = getStoredSyncCode();
  if (!stored) return;
  syncCode = stored;
  if (!ensureFirebase()) return;
  db.collection('syncStates').doc(syncCode).get().then(docSnap => {
    if (docSnap.exists) {
      const data = docSnap.data();
      if (cloudUpdatedAtMs(data) > localUpdatedAtMs()) {
        applyCloudData(data);
        const activeTab = document.querySelector('.tab-btn.active');
        if (activeTab) switchTab(activeTab.dataset.tab);
      } else {
        pushToCloud();
      }
    } else {
      pushToCloud();
    }
    subscribeSync();
  }).catch(e => console.warn('초기 동기화 실패(오프라인일 수 있음)', e));
}

/* ---------------- 동기화 탭 UI ---------------- */
function renderSyncTab() {
  const el = document.getElementById('panel-sync');
  if (!el) return;

  if (!syncCode) {
    el.innerHTML = `
      <p class="muted">동기화를 켜면 PC, 아이폰 등 여러 기기에서 같은 학습 기록(복습 주기, 새단어 학습 기록 등)을 공유할 수 있어요.</p>
      <div class="section-title">이 기기가 처음이라면</div>
      <button class="btn primary" id="btn-sync-new">새 동기화 코드 만들기</button>
      <div class="section-title">다른 기기에서 만든 코드가 있다면</div>
      <form id="sync-join-form" class="cat-form">
        <input type="text" id="sync-join-input" placeholder="예: 7F3KQ9XZ2P" style="text-transform:uppercase" />
        <button type="submit" class="btn primary">코드 입력</button>
      </form>
      <p id="sync-error" class="muted sync-error" style="display:none;"></p>
    `;

    document.getElementById('btn-sync-new').addEventListener('click', async () => {
      const btn = document.getElementById('btn-sync-new');
      btn.disabled = true;
      btn.textContent = '생성 중...';
      const code = await startNewSync();
      if (code) {
        renderSyncTab();
      } else {
        btn.disabled = false;
        btn.textContent = '새 동기화 코드 만들기';
      }
    });

    document.getElementById('sync-join-form').addEventListener('submit', async e => {
      e.preventDefault();
      const input = document.getElementById('sync-join-input');
      const code = input.value.trim();
      if (!code) return;
      if (!confirm('이 코드로 동기화하면 이 기기의 현재 학습 기록이 코드에 저장된 내용으로 대체됩니다. 계속할까요?')) return;
      const result = await joinExistingSync(code);
      if (result.ok) {
        renderSyncTab();
        switchTab('dashboard');
      } else {
        const errEl = document.getElementById('sync-error');
        errEl.style.display = 'block';
        errEl.textContent = result.reason === 'not-found'
          ? '해당 코드를 찾을 수 없어요. 코드를 다시 확인해주세요.'
          : '동기화에 실패했습니다. 인터넷 연결을 확인해주세요.';
      }
    });
    return;
  }

  el.innerHTML = `
    <p class="muted">이 코드를 다른 기기의 "동기화" 탭에서 입력하면 학습 기록이 공유됩니다.</p>
    <div class="sync-code-box">
      <span class="sync-code">${escapeHtml(syncCode)}</span>
      <button class="btn" id="btn-copy-code">복사</button>
    </div>
    <p class="muted" id="sync-status-text">동기화 켜짐</p>
    <button class="btn danger-outline" id="btn-stop-sync">이 기기에서 동기화 해제</button>
  `;

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(syncCode).then(() => {
      const s = document.getElementById('sync-status-text');
      s.textContent = '코드가 복사되었습니다!';
      setTimeout(() => { s.textContent = '동기화 켜짐'; }, 1500);
    });
  });

  document.getElementById('btn-stop-sync').addEventListener('click', () => {
    if (!confirm('동기화를 해제할까요? 이 기기의 데이터는 그대로 남지만, 더 이상 다른 기기와 공유되지 않습니다.')) return;
    stopSync();
    renderSyncTab();
  });
}
