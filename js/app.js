'use strict';

const STORAGE_KEY = 'bizEnglishApp_v1';
const INTERVALS_DAYS = [1, 3, 7, 14, 30, 60, 120]; // 망각곡선 기반 복습 주기 (박스 인덱스별)
const DAILY_BATCH_SIZE = 20; // "N일차 학습"에서 하루에 도입하는 신규 단어 수

let state = null;

/* ---------------- 유틸 ---------------- */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function stripParenthetical(s) {
  return (s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}
function normalizeAnswer(s) {
  return stripParenthetical(s).toLowerCase().trim().replace(/[^a-z0-9\- ]/g, '').trim();
}
function blankTerm(sentence, term) {
  const bare = stripParenthetical(term);
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'i');
  return re.test(sentence) ? sentence.replace(re, '_____') : sentence;
}

/* ---------------- 저장/불러오기 ---------------- */
function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  let loaded = null;
  if (raw) {
    try {
      loaded = JSON.parse(raw);
    } catch (e) {
      console.warn('상태 파싱 실패, 초기화합니다.', e);
    }
  }
  if (!loaded) return createInitialState();

  loaded.settings = loaded.settings || { reviewMode: 'mixed' };
  loaded.studyDayLog = loaded.studyDayLog || [];
  if (loaded.learnSession === undefined) loaded.learnSession = null;

  if (loaded.dataVersion !== SEED_VERSION) {
    syncSeedContent(loaded);
    loaded.dataVersion = SEED_VERSION;
  }
  return loaded;
}

function makeSeedWord(w) {
  return {
    id: uid('w'),
    ...w,
    synonyms: w.synonyms || [],
    antonyms: w.antonyms || [],
    collocations: w.collocations || [],
    isSeed: true,
    studyDay: null,
    firstStudiedDate: null,
    srs: { box: 0, dueDate: todayISO(), reps: 0, lastReviewed: null },
  };
}

function createInitialState() {
  return {
    dataVersion: SEED_VERSION,
    categories: DEFAULT_CATEGORIES.map(c => ({ ...c })),
    words: SEED_WORDS.map(makeSeedWord),
    reviewLog: [], // { date: 'YYYY-MM-DD', count: n }
    studyDayLog: [], // { day: number, date: 'YYYY-MM-DD', wordIds: [] }  (day 0 = 즉시 학습된 단어)
    settings: { reviewMode: 'mixed' },
    learnSession: null, // { day, index } — 진행 중인 "새단어 학습" 세션 위치 (중단 후 재개용)
  };
}

// SEED_WORDS와 저장된 단어 목록을 category+term 기준으로 비교(diff)하여:
//  - 이미 있는 시드 단어(isSeed: true)는 뜻/예문/팁/유의어 등 콘텐츠만 최신화 (SRS 진행상황·학습일차는 보존)
//  - 더 이상 SEED_WORDS에 없는 시드 단어는 제거
//  - 새로 추가된 시드 단어는 신규 생성 (학습일차 미배정 상태로, "새단어 학습"에서 등장)
// 사용자가 직접 추가한 단어(isSeed: false)는 전혀 건드리지 않습니다.
function syncSeedContent(loaded) {
  DEFAULT_CATEGORIES.forEach(defCat => {
    const existing = loaded.categories.find(c => c.key === defCat.key);
    if (existing) {
      existing.label = defCat.label;
      existing.core = defCat.core;
    } else {
      loaded.categories.push({ ...defCat });
    }
  });

  const seedMap = new Map(SEED_WORDS.map(w => [w.category + '::' + w.term, w]));
  const matchedKeys = new Set();
  const CONTENT_FIELDS = ['ipa', 'pos', 'type', 'meaningKo', 'examples', 'tip', 'synonyms', 'antonyms', 'collocations'];

  loaded.words = loaded.words.filter(w => {
    if (!w.isSeed) return true;
    const key = w.category + '::' + w.term;
    const def = seedMap.get(key);
    if (!def) return false;
    matchedKeys.add(key);
    CONTENT_FIELDS.forEach(f => { w[f] = def[f] !== undefined ? def[f] : w[f]; });
    return true;
  });

  SEED_WORDS.forEach(def => {
    const key = def.category + '::' + def.term;
    if (!matchedKeys.has(key)) loaded.words.push(makeSeedWord(def));
  });

  // 학습일차 기능 도입 이전에 만들어진 단어들을 위한 1회성 하위호환 처리
  const backfilledDay0Ids = [];
  loaded.words.forEach(w => {
    w.synonyms = w.synonyms || [];
    w.antonyms = w.antonyms || [];
    w.collocations = w.collocations || [];
    if ('studyDay' in w) return;
    if (!w.isSeed) {
      w.studyDay = 0; // 사용자가 직접 추가한 단어는 즉시 학습 대상
      w.firstStudiedDate = w.firstStudiedDate || todayISO();
      backfilledDay0Ids.push(w.id);
    } else if (w.srs.reps > 0) {
      w.studyDay = 0; // 이미 복습을 진행해온 단어는 "즉시 학습됨" 취급
      w.firstStudiedDate = w.srs.lastReviewed || todayISO();
      backfilledDay0Ids.push(w.id);
    } else {
      w.studyDay = null; // 한 번도 학습한 적 없는 단어는 "새단어 학습"에서 도입 대기
      w.firstStudiedDate = null;
    }
  });
  if (backfilledDay0Ids.length) {
    let day0 = loaded.studyDayLog.find(e => e.day === 0);
    if (!day0) { day0 = { day: 0, date: todayISO(), wordIds: [] }; loaded.studyDayLog.push(day0); }
    const existingIds = new Set(day0.wordIds);
    backfilledDay0Ids.forEach(id => { if (!existingIds.has(id)) day0.wordIds.push(id); });
  }
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (typeof scheduleCloudPush === 'function') scheduleCloudPush();
}

/* ---------------- SRS 스케줄러 ---------------- */
function scheduleReview(word, rating) {
  let box = word.srs.box;
  let days;
  if (rating === 'again') {
    box = 0;
    days = 1;
  } else if (rating === 'hard') {
    days = Math.max(1, Math.round((INTERVALS_DAYS[box] || 1) * 0.6));
  } else if (rating === 'good') {
    box = Math.min(box + 1, INTERVALS_DAYS.length - 1);
    days = INTERVALS_DAYS[box];
  } else { // easy
    box = Math.min(box + 2, INTERVALS_DAYS.length - 1);
    days = INTERVALS_DAYS[box];
  }
  word.srs.box = box;
  word.srs.dueDate = addDaysISO(days);
  word.srs.reps += 1;
  word.srs.lastReviewed = todayISO();
}

function dueWords() {
  const today = todayISO();
  return state.words.filter(w => w.studyDay !== null && w.srs.dueDate <= today);
}

function unintroducedWords() {
  return state.words.filter(w => w.studyDay === null);
}

function nextStudyDayNumber() {
  const days = state.studyDayLog.map(e => e.day).filter(d => d > 0);
  return days.length ? Math.max(...days) + 1 : 1;
}

// 아직 학습하지 않은 단어들을 카테고리별로 라운드로빈 방식으로 섞어, 하루 배치가
// 한 카테고리에 몰리지 않고 다양하게 구성되도록 합니다.
function pickNextBatch(size) {
  const pool = unintroducedWords();
  const byCat = {};
  pool.forEach(w => { (byCat[w.category] = byCat[w.category] || []).push(w); });
  const cats = Object.keys(byCat);
  const batch = [];
  let i = 0;
  while (batch.length < size) {
    let addedAny = false;
    for (const c of cats) {
      if (byCat[c].length > i) {
        batch.push(byCat[c][i]);
        addedAny = true;
        if (batch.length >= size) break;
      }
    }
    if (!addedAny) break;
    i++;
  }
  return batch;
}

function logReviewCompletion(count) {
  const today = todayISO();
  let entry = state.reviewLog.find(e => e.date === today);
  if (!entry) {
    entry = { date: today, count: 0 };
    state.reviewLog.push(entry);
  }
  entry.count += count;
}

/* ---------------- TTS 발음 ---------------- */
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'en-US';
  utter.rate = 0.92;
  window.speechSynthesis.speak(utter);
}

/* ---------------- 공용 카드 렌더 조각 ---------------- */
function categoryLabel(key) {
  const c = state.categories.find(c => c.key === key);
  return c ? c.label : key;
}
function renderExamples(word) {
  if (!word.examples || !word.examples.length) return '';
  return word.examples.map(ex => `
    <div class="example">
      <div class="ex-en">"${escapeHtml(ex.en)}"</div>
      <div class="ex-ko">${escapeHtml(ex.ko)}</div>
    </div>`).join('');
}
function renderTip(word) {
  return word.tip ? `<div class="tip"><strong>활용 팁</strong> ${escapeHtml(word.tip)}</div>` : '';
}
function renderWordRelations(word) {
  const parts = [];
  if (word.synonyms && word.synonyms.length) {
    parts.push(`<div class="relation-row"><span class="relation-label syn">유의어</span> ${word.synonyms.map(escapeHtml).join(', ')}</div>`);
  }
  if (word.antonyms && word.antonyms.length) {
    parts.push(`<div class="relation-row"><span class="relation-label ant">반의어</span> ${word.antonyms.map(escapeHtml).join(', ')}</div>`);
  }
  if (word.collocations && word.collocations.length) {
    parts.push(`<div class="relation-row"><span class="relation-label col">함께 쓰이는 표현</span> ${word.collocations.map(escapeHtml).join(', ')}</div>`);
  }
  return parts.length ? `<div class="relations">${parts.join('')}</div>` : '';
}

/* ---------------- 탭 전환 ---------------- */
function switchTab(tabName) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + tabName).classList.add('active');
  document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');

  if (tabName === 'dashboard') renderDashboard();
  if (tabName === 'daylearn') renderDayLearn();
  if (tabName === 'review') renderReview();
  if (tabName === 'browse') renderBrowse();
  if (tabName === 'add') renderAddForm();
  if (tabName === 'categories') renderCategories();
  if (tabName === 'stats') renderStats();
  if (tabName === 'sync' && typeof renderSyncTab === 'function') renderSyncTab();
}

/* ---------------- 대시보드 ---------------- */
function renderDashboard() {
  const due = dueWords();
  const unintroduced = unintroducedWords();
  const el = document.getElementById('panel-dashboard');

  const perCategory = state.categories.map(cat => {
    const total = state.words.filter(w => w.category === cat.key).length;
    const dueCount = due.filter(w => w.category === cat.key).length;
    const newCount = unintroduced.filter(w => w.category === cat.key).length;
    return { cat, total, dueCount, newCount };
  });

  el.innerHTML = `
    <div class="card-grid">
      <div class="stat-card">
        <div class="stat-num">${state.words.length}</div>
        <div class="stat-label">전체 단어/표현</div>
      </div>
      <div class="stat-card highlight">
        <div class="stat-num">${due.length}</div>
        <div class="stat-label">오늘 복습할 항목</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${unintroduced.length}</div>
        <div class="stat-label">아직 학습 전 단어</div>
      </div>
    </div>

    <div class="section-title">카테고리별 현황</div>
    <div class="cat-list">
      ${perCategory.map(p => `
        <div class="cat-row">
          <span class="cat-badge" data-cat="${p.cat.key}">${escapeHtml(p.cat.label)}</span>
          <span class="cat-count">${p.total}개 보유 · <strong>${p.dueCount}개 복습 대기</strong> · 신규 ${p.newCount}개</span>
        </div>
      `).join('')}
    </div>

    <div class="action-row">
      <button class="btn primary" id="btn-goto-daylearn">${
        state.learnSession
          ? `이어서 학습하기 (${state.learnSession.index}/${(state.studyDayLog.find(e => e.day === state.learnSession.day) || { wordIds: [] }).wordIds.length})`
          : `${nextStudyDayNumber()}일차 새단어 학습`
      }</button>
      <button class="btn" id="btn-start-review" ${due.length === 0 ? 'disabled' : ''}>
        복습 시작하기 (${due.length})
      </button>
      <button class="btn" id="btn-goto-add">새 단어/표현 추가</button>
    </div>
    ${due.length === 0 && unintroduced.length > 0 ? '<p class="muted">아직 복습할 항목이 없어요. 먼저 위 버튼으로 오늘의 새단어 학습을 시작해보세요.</p>' : ''}
    ${due.length === 0 && unintroduced.length === 0 ? '<p class="muted">모든 단어를 학습했어요! 새 단어를 추가해보세요.</p>' : ''}
  `;

  document.getElementById('btn-goto-daylearn').addEventListener('click', () => switchTab('daylearn'));
  document.getElementById('btn-start-review').addEventListener('click', () => switchTab('review'));
  document.getElementById('btn-goto-add').addEventListener('click', () => switchTab('add'));
}

/* ---------------- 새단어 학습 (일차별) ---------------- */
let learnQueue = [];
let learnIndex = 0;
let learnMode = 'new'; // 'new' = 오늘의 신규 학습(진행상황 저장됨) | 'revisit' = 지난 일자 다시보기
let learnRevisitLabel = '';
let learnViewMode = 'card'; // 'card' = 한 장씩 넘기기 | 'list' = 전체 목록 한눈에 보기
let calendarMonthOffset = 0;

function renderDayLearn() {
  // 중단된 "새단어 학습" 세션이 있으면 처음부터가 아니라 중단 지점부터 이어서 보여줍니다.
  if (state.learnSession) {
    const entry = state.studyDayLog.find(e => e.day === state.learnSession.day);
    if (entry) {
      learnQueue = entry.wordIds.map(id => state.words.find(w => w.id === id)).filter(Boolean);
      learnIndex = Math.min(state.learnSession.index, learnQueue.length);
      learnMode = 'new';
      renderLearnCard();
      return;
    }
    state.learnSession = null; // 참조가 깨졌으면(단어 삭제 등) 정리하고 아래 일반 화면으로
  }

  const el = document.getElementById('panel-daylearn');
  const remaining = unintroducedWords().length;
  const nextDay = nextStudyDayNumber();
  const batchPreview = Math.min(DAILY_BATCH_SIZE, remaining);

  const dayChips = [...state.studyDayLog]
    .filter(e => e.wordIds.length > 0)
    .sort((a, b) => a.day - b.day)
    .map(e => {
      const label = e.day === 0 ? '직접 추가' : `Day ${e.day}`;
      return `<button class="btn day-chip" data-day="${e.day}" data-date="${e.date}">
        ${label}<small>${e.wordIds.length}개</small>
      </button>`;
    }).join('');

  el.innerHTML = `
    <div class="card-grid">
      <div class="stat-card highlight">
        <div class="stat-num">${nextDay}일차</div>
        <div class="stat-label">다음 학습</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${remaining}</div>
        <div class="stat-label">아직 학습 전인 단어</div>
      </div>
    </div>
    <div class="action-row">
      <button class="btn primary" id="btn-start-day" ${remaining === 0 ? 'disabled' : ''}>
        ${nextDay}일차 학습 시작 (${batchPreview}개)
      </button>
    </div>
    ${remaining === 0 ? '<p class="muted">모든 단어를 학습했어요! 새 단어를 추가하면 계속할 수 있습니다.</p>' : ''}

    <div class="section-title">지난 학습 다시보기 (퀴즈 없이 카드로만 훑어봅니다)</div>
    ${dayChips ? `<div class="day-chip-row">${dayChips}</div>` : '<p class="muted">아직 학습 기록이 없습니다.</p>'}

    <div class="section-title">학습 캘린더</div>
    <div id="calendar-container"></div>
  `;

  const startBtn = document.getElementById('btn-start-day');
  if (startBtn) startBtn.addEventListener('click', startStudyDay);

  el.querySelectorAll('.day-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = Number(btn.dataset.day);
      const entry = state.studyDayLog.find(e => e.day === day && e.date === btn.dataset.date);
      if (!entry) return;
      const words = entry.wordIds.map(id => state.words.find(w => w.id === id)).filter(Boolean);
      startRevisitSession(words, day === 0 ? '직접 추가한 단어' : `Day ${day}`);
    });
  });

  calendarMonthOffset = 0;
  renderCalendar();
}

function renderCalendar() {
  const container = document.getElementById('calendar-container');
  if (!container) return;

  const base = new Date();
  const viewDate = new Date(base.getFullYear(), base.getMonth() + calendarMonthOffset, 1);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const entriesByDate = {};
  state.studyDayLog.forEach(e => {
    if (!e.wordIds || !e.wordIds.length) return;
    (entriesByDate[e.date] = entriesByDate[e.date] || []).push(e);
  });

  const todayStr = todayISO();
  const weekLabels = ['일', '월', '화', '수', '목', '금', '토'];
  let cells = weekLabels.map(w => `<div class="cal-weekday">${w}</div>`).join('');
  for (let i = 0; i < firstDayOfWeek; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayEntries = entriesByDate[dateStr];
    const totalWords = dayEntries ? dayEntries.reduce((sum, e) => sum + e.wordIds.length, 0) : 0;
    const dayNumbers = dayEntries ? dayEntries.filter(e => e.day > 0).map(e => e.day) : [];
    const isToday = dateStr === todayStr;
    cells += `
      <button class="cal-cell ${dayEntries ? 'has-entry' : ''} ${isToday ? 'is-today' : ''}"
        ${dayEntries ? `data-date="${dateStr}"` : 'disabled'}>
        <span class="cal-daynum">${d}</span>
        ${dayEntries ? `<span class="cal-count">${totalWords}개${dayNumbers.length ? ` · ${dayNumbers.join(',')}일차` : ''}</span>` : ''}
      </button>`;
  }

  container.innerHTML = `
    <div class="cal-header">
      <button class="btn nav-btn" id="cal-prev" title="이전 달">◀</button>
      <span class="cal-month-label">${year}년 ${month + 1}월</span>
      <button class="btn nav-btn" id="cal-next" title="다음 달">▶</button>
    </div>
    <div class="cal-grid">${cells}</div>
  `;

  document.getElementById('cal-prev').addEventListener('click', () => { calendarMonthOffset--; renderCalendar(); });
  document.getElementById('cal-next').addEventListener('click', () => { calendarMonthOffset++; renderCalendar(); });

  container.querySelectorAll('.cal-cell.has-entry').forEach(btn => {
    btn.addEventListener('click', () => {
      const dateStr = btn.dataset.date;
      const words = entriesByDate[dateStr]
        .flatMap(e => e.wordIds)
        .map(id => state.words.find(w => w.id === id))
        .filter(Boolean);
      startRevisitSession(words, dateStr);
    });
  });
}

function startStudyDay() {
  const day = nextStudyDayNumber();
  const batch = pickNextBatch(DAILY_BATCH_SIZE);
  if (batch.length === 0) return;
  const today = todayISO();
  batch.forEach(w => {
    w.studyDay = day;
    w.firstStudiedDate = today;
    w.srs.dueDate = addDaysISO(1); // 오늘 처음 학습했으니 첫 복습 체크포인트는 내일로
  });
  state.studyDayLog.push({ day, date: today, wordIds: batch.map(w => w.id) });
  // 배치를 기록하는 시점에 바로 진행 위치를 저장해둡니다 — 앱을 도중에 꺼도
  // 다음에 열었을 때 처음(1/20)이 아니라 중단했던 카드부터 이어서 볼 수 있습니다.
  state.learnSession = { day, index: 0 };
  saveState();

  learnQueue = batch;
  learnIndex = 0;
  learnMode = 'new';
  renderLearnCard();
}

function startRevisitSession(words, dateLabel) {
  learnQueue = words;
  learnIndex = 0;
  learnMode = 'revisit';
  learnRevisitLabel = dateLabel;
  renderLearnCard();
}

function learnSessionTitle() {
  return learnMode === 'new' ? '오늘의 새 단어' : learnRevisitLabel;
}

function renderLearnCard() {
  const el = document.getElementById('panel-daylearn');
  if (learnViewMode === 'list') { renderLearnList(); return; }

  if (learnIndex >= learnQueue.length) {
    if (learnMode === 'new') {
      state.learnSession = null;
      saveState();
      el.innerHTML = `<div class="empty-state">
        <p class="celebrate">오늘의 새 단어 학습을 마쳤어요! 🎉</p>
        <p class="muted">이 단어들은 내일부터 '복습' 탭에 자동으로 등장합니다.</p>
        <button class="btn primary" id="btn-learn-done">학습 기록으로</button>
        <button class="btn" id="btn-learn-review-now">지금 바로 복습하기</button>
      </div>`;
      document.getElementById('btn-learn-done').addEventListener('click', renderDayLearn);
      document.getElementById('btn-learn-review-now').addEventListener('click', () => switchTab('review'));
    } else {
      el.innerHTML = `<div class="empty-state">
        <p class="celebrate">${escapeHtml(learnRevisitLabel)} 단어를 다시 훑어봤어요!</p>
        <button class="btn primary" id="btn-revisit-done">학습 기록으로</button>
      </div>`;
      document.getElementById('btn-revisit-done').addEventListener('click', renderDayLearn);
    }
    return;
  }

  el.innerHTML = `
    <div class="learn-toolbar">
      <span class="muted">${escapeHtml(learnSessionTitle())}</span>
      <button class="btn" id="btn-learn-listview">전체 목록으로 보기</button>
    </div>

    <div class="progress-slider-wrap">
      <input type="range" class="progress-slider" id="learn-slider"
             min="1" max="${learnQueue.length}" value="${learnIndex + 1}"
             aria-label="학습 진도" />
      <div class="slider-label" id="learn-slider-label">${learnIndex + 1} / ${learnQueue.length}</div>
    </div>

    <div id="learn-card-host">${learnCardBodyHtml(learnQueue[learnIndex])}</div>

    <p class="muted key-hint">좌우로 밀거나 위 바를 드래그해서 이동할 수 있어요 · 키보드 ← →</p>
    <div class="nav-spacer"></div>

    <div class="card-nav big fixed-bottom">
      <button class="btn nav-btn" id="btn-learn-prev" ${learnIndex === 0 ? 'disabled' : ''} title="이전 카드">◀ 이전</button>
      <button class="btn nav-btn primary" id="btn-learn-next" title="다음 카드">다음 ▶</button>
    </div>
  `;

  document.getElementById('btn-learn-prev').addEventListener('click', () => moveLearnCard(-1));
  document.getElementById('btn-learn-next').addEventListener('click', () => moveLearnCard(1));
  document.getElementById('btn-learn-listview').addEventListener('click', () => {
    learnViewMode = 'list';
    renderLearnList();
  });

  const slider = document.getElementById('learn-slider');
  paintSlider(slider);
  // 드래그 중(input)에는 화면만 갱신하고, 손을 뗄 때(change) 진행 위치를 저장합니다.
  slider.addEventListener('input', () => {
    learnIndex = Number(slider.value) - 1;
    updateLearnCardBody();
  });
  slider.addEventListener('change', () => {
    learnIndex = Number(slider.value) - 1;
    onLearnIndexChanged();
    updateLearnCardBody();
  });

  bindLearnCardBody();
}

function learnCardBodyHtml(word) {
  return `
    <div class="review-meta">
      <span class="cat-badge">${escapeHtml(categoryLabel(word.category))}</span>
      <span class="type-badge">${word.type === 'phrase' ? '관용구/표현' : '단어'}</span>
    </div>
    <div class="swipe-area" id="learn-swipe-area">
      <div class="flashcard">
        <div class="term-row">
          <div class="term">${escapeHtml(word.term)}</div>
          <button class="speak-btn" id="btn-learn-speak" title="발음 듣기">🔊</button>
        </div>
        ${word.ipa ? `<div class="ipa">${escapeHtml(word.ipa)}</div>` : ''}
        <div class="reveal">
          <div class="meaning">${escapeHtml(word.meaningKo)} <span class="pos">${escapeHtml(word.pos || '')}</span></div>
          ${renderExamples(word)}
          ${renderTip(word)}
          ${renderWordRelations(word)}
        </div>
      </div>
    </div>`;
}

function bindLearnCardBody() {
  const word = learnQueue[learnIndex];
  const speakBtn = document.getElementById('btn-learn-speak');
  if (speakBtn) speakBtn.addEventListener('click', () => speak(word.term));
  attachSwipe(document.getElementById('learn-swipe-area'), moveLearnCard);
}

// 슬라이더 자체는 그대로 두고 카드 내용만 교체합니다 (드래그 도중에도 끊기지 않도록).
function updateLearnCardBody() {
  const host = document.getElementById('learn-card-host');
  if (!host) return;
  host.innerHTML = learnCardBodyHtml(learnQueue[learnIndex]);
  bindLearnCardBody();

  const slider = document.getElementById('learn-slider');
  if (slider) {
    if (Number(slider.value) !== learnIndex + 1) slider.value = learnIndex + 1;
    paintSlider(slider);
  }
  const label = document.getElementById('learn-slider-label');
  if (label) label.textContent = `${learnIndex + 1} / ${learnQueue.length}`;

  const prevBtn = document.getElementById('btn-learn-prev');
  if (prevBtn) prevBtn.disabled = learnIndex === 0;
}

// 채워진 구간을 색으로 표시 (브라우저별 range 스타일 차이를 피하기 위해 배경 그라디언트 사용)
function paintSlider(slider) {
  if (!slider) return;
  const min = Number(slider.min), max = Number(slider.max), val = Number(slider.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 100;
  slider.style.background =
    `linear-gradient(to right, var(--primary) 0%, var(--primary) ${pct}%, var(--border) ${pct}%, var(--border) 100%)`;
}

// 20개를 한 장씩 넘기지 않고 한 화면에서 스크롤로 훑어보는 목록 모드
function renderLearnList() {
  const el = document.getElementById('panel-daylearn');
  el.innerHTML = `
    <div class="learn-toolbar">
      <span class="muted">${escapeHtml(learnSessionTitle())} · ${learnQueue.length}개</span>
      <button class="btn" id="btn-learn-cardview">카드로 보기</button>
    </div>
    <div class="learn-list">
      ${learnQueue.map((word, i) => `
        <div class="learn-list-item">
          <div class="lli-head">
            <span class="lli-index">${i + 1}</span>
            <span class="term-sm">${escapeHtml(word.term)}</span>
            ${word.ipa ? `<span class="ipa lli-ipa">${escapeHtml(word.ipa)}</span>` : ''}
            <button class="icon-btn" data-speak-index="${i}" title="발음">🔊</button>
          </div>
          <div class="meaning lli-meaning">${escapeHtml(word.meaningKo)} <span class="pos">${escapeHtml(word.pos || '')}</span></div>
          ${renderExamples(word)}
          ${renderTip(word)}
          ${renderWordRelations(word)}
        </div>
      `).join('')}
    </div>
    <div class="action-row">
      ${learnMode === 'new'
        ? '<button class="btn primary" id="btn-list-complete">학습 완료</button>'
        : '<button class="btn primary" id="btn-list-back">학습 기록으로</button>'}
    </div>
  `;

  el.querySelectorAll('[data-speak-index]').forEach(btn => {
    btn.addEventListener('click', () => speak(learnQueue[Number(btn.dataset.speakIndex)].term));
  });

  const completeBtn = document.getElementById('btn-list-complete');
  if (completeBtn) completeBtn.addEventListener('click', () => {
    learnIndex = learnQueue.length;
    learnViewMode = 'card';
    renderLearnCard();
  });
  const backBtn = document.getElementById('btn-list-back');
  if (backBtn) backBtn.addEventListener('click', () => {
    learnViewMode = 'card';
    renderDayLearn();
  });

  const cardBtn = document.getElementById('btn-learn-cardview');
  if (cardBtn) cardBtn.addEventListener('click', () => {
    learnViewMode = 'card';
    renderLearnCard();
  });
}

function moveLearnCard(delta) {
  const next = learnIndex + delta;
  if (next < 0) return;
  learnIndex = Math.min(next, learnQueue.length);
  onLearnIndexChanged();
  // 마지막 카드를 넘겨 완료 화면으로 갈 때만 전체를 다시 그립니다.
  if (learnIndex >= learnQueue.length) renderLearnCard();
  else updateLearnCardBody();
}

function onLearnIndexChanged() {
  if (learnMode === 'new' && state.learnSession) {
    state.learnSession.index = learnIndex;
    saveState();
  }
}

// 좌우 스와이프로 카드를 넘깁니다. 세로 스크롤과 충돌하지 않도록
// 가로 이동량이 세로보다 확실히 클 때만 넘김으로 처리합니다.
function attachSwipe(el, onMove) {
  if (!el) return;
  let startX = 0, startY = 0, tracking = false;
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { tracking = false; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      onMove(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
}

/* ---------------- 복습 (플래시카드: 인식/회상 모드) ---------------- */
let reviewQueue = [];
let reviewIndex = 0;
let reviewSessionCount = 0;
let lastRenderedIndex = -1;
let currentDirection = 'recognition';
let reviewRevealed = false;
let recallChecked = false;
let recallCorrect = false;

function renderReview() {
  reviewQueue = shuffle(dueWords());
  reviewIndex = 0;
  reviewSessionCount = 0;
  lastRenderedIndex = -1;
  renderReviewCard();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickDirection() {
  const mode = state.settings.reviewMode;
  if (mode === 'recognition') return 'recognition';
  if (mode === 'recall') return 'recall';
  // 혼합 모드: 회상(한→영) 연습에 조금 더 비중을 둡니다 — 한국어로 떠올린 단어가
  // 영어로 잘 안 나오는 것이 약점이라면, 인식보다 회상 훈련이 더 효과적입니다.
  return Math.random() < 0.65 ? 'recall' : 'recognition';
}

function renderReviewCard() {
  const el = document.getElementById('panel-review');

  if (reviewQueue.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <p>오늘 복습할 항목이 없습니다.</p>
      <button class="btn" id="btn-review-back">대시보드로 돌아가기</button>
    </div>`;
    document.getElementById('btn-review-back').addEventListener('click', () => switchTab('dashboard'));
    return;
  }

  if (reviewIndex >= reviewQueue.length) {
    el.innerHTML = `<div class="empty-state">
      <p class="celebrate">오늘의 복습을 모두 마쳤어요! 🎉</p>
      <p class="muted">이번 세션에서 ${reviewSessionCount}개 항목을 복습했습니다.</p>
      <button class="btn primary" id="btn-review-done">대시보드로</button>
    </div>`;
    document.getElementById('btn-review-done').addEventListener('click', () => switchTab('dashboard'));
    return;
  }

  if (reviewIndex !== lastRenderedIndex) {
    lastRenderedIndex = reviewIndex;
    currentDirection = pickDirection();
    reviewRevealed = false;
    recallChecked = false;
    recallCorrect = false;
  }

  const word = reviewQueue[reviewIndex];
  const progress = `${reviewIndex + 1} / ${reviewQueue.length}`;

  const modeSelectorHtml = `
    <div class="mode-row">
      <label class="muted">학습 방식
        <select id="review-mode-select">
          <option value="mixed" ${state.settings.reviewMode === 'mixed' ? 'selected' : ''}>혼합 (추천)</option>
          <option value="recall" ${state.settings.reviewMode === 'recall' ? 'selected' : ''}>회상 연습 (한→영)</option>
          <option value="recognition" ${state.settings.reviewMode === 'recognition' ? 'selected' : ''}>인식 연습 (영→한)</option>
        </select>
      </label>
    </div>`;

  let cardBodyHtml;
  if (currentDirection === 'recall') {
    cardBodyHtml = `
      <div class="recall-badge">회상 연습 · 한→영</div>
      <div class="recall-prompt">${escapeHtml(word.meaningKo)} <span class="pos">${escapeHtml(word.pos || '')}</span></div>
      ${word.examples && word.examples[0] ? `<div class="example recall-context"><div class="ex-en">"${escapeHtml(blankTerm(word.examples[0].en, word.term))}"</div></div>` : ''}
      ${!recallChecked ? `
        <form id="recall-form" class="recall-form">
          <input type="text" id="recall-input" autocomplete="off" placeholder="영어 단어를 입력하세요" />
          <button type="submit" class="btn primary">확인 (Enter)</button>
        </form>
      ` : `
        <div class="recall-result ${recallCorrect ? 'correct' : 'incorrect'}">
          ${recallCorrect ? '정답이에요!' : `아쉬워요. 정답은 <strong>${escapeHtml(word.term)}</strong> 입니다.`}
        </div>
        <div class="term-row">
          <div class="term">${escapeHtml(word.term)}</div>
          <button class="speak-btn" id="btn-speak" title="발음 듣기">🔊</button>
        </div>
        ${word.ipa ? `<div class="ipa">${escapeHtml(word.ipa)}</div>` : ''}
        <div class="reveal">
          <div class="meaning">${escapeHtml(word.meaningKo)} <span class="pos">${escapeHtml(word.pos || '')}</span></div>
          ${renderExamples(word)}
          ${renderTip(word)}
          ${renderWordRelations(word)}
        </div>
      `}
    `;
  } else {
    cardBodyHtml = `
      <div class="term-row">
        <div class="term">${escapeHtml(word.term)}</div>
        <button class="speak-btn" id="btn-speak" title="발음 듣기">🔊</button>
      </div>
      ${word.ipa ? `<div class="ipa">${escapeHtml(word.ipa)}</div>` : ''}
      ${reviewRevealed ? `
        <div class="reveal">
          <div class="meaning">${escapeHtml(word.meaningKo)} <span class="pos">${escapeHtml(word.pos || '')}</span></div>
          ${renderExamples(word)}
          ${renderTip(word)}
          ${renderWordRelations(word)}
        </div>
      ` : `<button class="btn primary reveal-btn" id="btn-reveal">뜻 / 예문 / 팁 보기 (Space)</button>`}
    `;
  }

  const showRating = (currentDirection === 'recall' && recallChecked) || (currentDirection === 'recognition' && reviewRevealed);

  el.innerHTML = `
    <div class="progress-bar"><div class="progress-fill" style="width:${((reviewIndex) / reviewQueue.length) * 100}%"></div></div>
    <div class="review-meta">
      <span class="cat-badge">${escapeHtml(categoryLabel(word.category))}</span>
      <span class="type-badge">${word.type === 'phrase' ? '관용구/표현' : '단어'}</span>
      <span class="progress-text">${progress}</span>
    </div>
    ${modeSelectorHtml}
    <div class="swipe-area" id="review-swipe-area">
      <div class="flashcard">
        ${cardBodyHtml}
      </div>
    </div>

    ${showRating ? `
      <div class="rating-row">
        <button class="btn rate again" data-rating="again">다시<br><small>1일 후</small></button>
        <button class="btn rate hard" data-rating="hard">어려움<br><small>짧게</small></button>
        <button class="btn rate good" data-rating="good">좋음<br><small>표준 주기</small></button>
        <button class="btn rate easy" data-rating="easy">쉬움<br><small>길게</small></button>
      </div>
      <p class="muted key-hint">키보드: ← → 카드 이동 · 1~4 평가</p>
    ` : `<p class="muted key-hint">키보드: ← → 카드 이동${currentDirection === 'recognition' ? ' · Space/Enter 뜻 보기' : ''}</p>`}

    <div class="nav-spacer"></div>
    <div class="card-nav big fixed-bottom">
      <button class="btn nav-btn" id="btn-prev-card" ${reviewIndex === 0 ? 'disabled' : ''} title="이전 카드">◀ 이전</button>
      <button class="btn nav-btn" id="btn-next-card" title="다음 카드 (평가 없이 건너뛰기)">건너뛰기 ▶</button>
    </div>
  `;

  document.getElementById('review-mode-select').addEventListener('change', e => {
    state.settings.reviewMode = e.target.value;
    saveState();
    currentDirection = pickDirection();
    reviewRevealed = false;
    recallChecked = false;
    recallCorrect = false;
    renderReviewCard();
  });

  document.getElementById('btn-prev-card').addEventListener('click', () => navigateCard(-1));
  document.getElementById('btn-next-card').addEventListener('click', () => navigateCard(1));
  // 회상 모드에서 답을 입력하는 중에는 스와이프로 카드가 넘어가지 않도록 합니다.
  if (!(currentDirection === 'recall' && !recallChecked)) {
    attachSwipe(document.getElementById('review-swipe-area'), navigateCard);
  }

  if (currentDirection === 'recall' && !recallChecked) {
    const form = document.getElementById('recall-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const input = document.getElementById('recall-input');
      recallCorrect = normalizeAnswer(input.value) === normalizeAnswer(word.term);
      recallChecked = true;
      renderReviewCard();
    });
    document.getElementById('recall-input').focus();
  } else {
    const speakBtn = document.getElementById('btn-speak');
    if (speakBtn) speakBtn.addEventListener('click', () => speak(word.term));
    const revealBtn = document.getElementById('btn-reveal');
    if (revealBtn) revealBtn.addEventListener('click', revealCurrentCard);
  }

  el.querySelectorAll('.rate').forEach(btn => {
    btn.addEventListener('click', () => rateCurrentCard(btn.dataset.rating));
  });
}

function revealCurrentCard() {
  reviewRevealed = true;
  renderReviewCard();
}

// 평가 없이 카드만 이동 (진짜 "카드 넘기기"). SRS 일정에는 영향을 주지 않으므로,
// 넘긴 카드는 다음에 복습을 시작할 때 다시 대기 목록에 남아 있습니다.
function navigateCard(delta) {
  const next = reviewIndex + delta;
  if (next < 0) return;
  reviewIndex = Math.min(next, reviewQueue.length);
  renderReviewCard();
}

function rateCurrentCard(rating) {
  const word = reviewQueue[reviewIndex];
  if (!word) return;
  scheduleReview(word, rating);
  reviewSessionCount++;
  logReviewCompletion(1);
  saveState();
  reviewIndex++;
  renderReviewCard();
}

document.addEventListener('keydown', e => {
  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

  const learnPanel = document.getElementById('panel-daylearn');
  if (learnPanel && learnPanel.classList.contains('active') && learnViewMode === 'card' && learnQueue.length) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveLearnCard(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); moveLearnCard(1); return; }
  }

  const reviewPanel = document.getElementById('panel-review');
  if (!reviewPanel || !reviewPanel.classList.contains('active')) return;
  if (reviewIndex >= reviewQueue.length || reviewQueue.length === 0) return;

  if (e.key === 'ArrowLeft') { e.preventDefault(); navigateCard(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navigateCard(1); }
  else if ((e.key === ' ' || e.key === 'Enter') && currentDirection === 'recognition' && !reviewRevealed) { e.preventDefault(); revealCurrentCard(); }
  else if (['1', '2', '3', '4'].includes(e.key)) {
    const showRating = (currentDirection === 'recall' && recallChecked) || (currentDirection === 'recognition' && reviewRevealed);
    if (showRating) { e.preventDefault(); rateCurrentCard(['again', 'hard', 'good', 'easy'][Number(e.key) - 1]); }
  }
});

/* ---------------- 단어장 (Browse) ---------------- */
function renderBrowse() {
  const el = document.getElementById('panel-browse');
  el.innerHTML = `
    <div class="filter-row">
      <input type="text" id="browse-search" placeholder="단어 또는 뜻 검색..." />
      <select id="browse-cat-filter">
        <option value="all">전체 카테고리</option>
        ${state.categories.map(c => `<option value="${c.key}">${escapeHtml(c.label)}</option>`).join('')}
      </select>
      <select id="browse-type-filter">
        <option value="all">전체 유형</option>
        <option value="word">단어</option>
        <option value="phrase">관용구/표현</option>
      </select>
    </div>
    <div id="browse-list" class="browse-list"></div>
  `;

  const search = document.getElementById('browse-search');
  const catFilter = document.getElementById('browse-cat-filter');
  const typeFilter = document.getElementById('browse-type-filter');

  function refresh() {
    const q = search.value.trim().toLowerCase();
    const cat = catFilter.value;
    const type = typeFilter.value;
    const filtered = state.words.filter(w => {
      if (cat !== 'all' && w.category !== cat) return false;
      if (type !== 'all' && w.type !== type) return false;
      if (q && !(w.term.toLowerCase().includes(q) || w.meaningKo.includes(q))) return false;
      return true;
    });
    renderBrowseList(filtered);
  }

  search.addEventListener('input', refresh);
  catFilter.addEventListener('change', refresh);
  typeFilter.addEventListener('change', refresh);
  refresh();
}

function renderBrowseList(list) {
  const el = document.getElementById('browse-list');
  if (list.length === 0) {
    el.innerHTML = '<p class="muted">일치하는 항목이 없습니다.</p>';
    return;
  }
  el.innerHTML = list.map(w => `
    <div class="browse-item">
      <div class="browse-item-head">
        <span class="term-sm">${escapeHtml(w.term)}</span>
        <span class="cat-badge">${escapeHtml(categoryLabel(w.category))}</span>
        <span class="type-badge">${w.type === 'phrase' ? '표현' : '단어'}</span>
        <button class="icon-btn" data-action="speak" data-id="${w.id}" title="발음">🔊</button>
        <button class="icon-btn danger" data-action="delete" data-id="${w.id}" title="삭제">🗑</button>
      </div>
      <div class="browse-item-body">
        <span class="meaning-sm">${escapeHtml(w.meaningKo)}</span>
        <span class="due-sm">${w.studyDay === null ? '학습 전' : `다음 복습: ${w.srs.dueDate}${w.srs.dueDate <= todayISO() ? ' (대기중)' : ''}`}</span>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('[data-action="speak"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = state.words.find(w => w.id === btn.dataset.id);
      if (w) speak(w.term);
    });
  });
  el.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('이 항목을 삭제할까요?')) return;
      state.words = state.words.filter(w => w.id !== btn.dataset.id);
      saveState();
      renderBrowse();
    });
  });
}

/* ---------------- 추가 (Add) ---------------- */
function renderAddForm() {
  const el = document.getElementById('panel-add');
  el.innerHTML = `
    <form id="add-form" class="add-form">
      <label>단어 / 표현 <span class="req">*</span>
        <input type="text" id="f-term" required placeholder="예: lease" />
      </label>
      <label>발음기호 (IPA, 선택)
        <input type="text" id="f-ipa" placeholder="예: /liːs/" />
      </label>
      <label>품사 (선택)
        <input type="text" id="f-pos" placeholder="예: 명사/동사" />
      </label>
      <label>유형
        <select id="f-type">
          <option value="word">단어</option>
          <option value="phrase">관용구/표현</option>
        </select>
      </label>
      <label>카테고리
        <select id="f-category">
          ${state.categories.map(c => `<option value="${c.key}">${escapeHtml(c.label)}</option>`).join('')}
        </select>
      </label>
      <label>뜻 (한국어) <span class="req">*</span>
        <input type="text" id="f-meaning" required placeholder="예: 임대차 계약; 임대하다" />
      </label>
      <label>예문 (영어) <span class="req">*</span>
        <textarea id="f-ex-en" required placeholder="예: The company signed a 5-year lease."></textarea>
      </label>
      <label>예문 해석 (한국어)
        <textarea id="f-ex-ko" placeholder="예: 그 회사는 5년 임대차 계약을 체결했다."></textarea>
      </label>
      <label>활용 팁 (선택)
        <textarea id="f-tip" placeholder="뉘앙스, 자주 쓰이는 형태, 헷갈리는 단어와의 구분 등"></textarea>
      </label>
      <label>유의어 (쉼표로 구분, 선택)
        <input type="text" id="f-synonyms" placeholder="예: valuation, assessment" />
      </label>
      <label>반의어 (쉼표로 구분, 선택)
        <input type="text" id="f-antonyms" placeholder="예: theoretical" />
      </label>
      <label>함께 쓰이는 표현 (쉼표로 구분, 선택)
        <input type="text" id="f-collocations" placeholder="예: conduct an appraisal" />
      </label>
      <button type="submit" class="btn primary">단어 추가하기</button>
      <p id="add-success" class="muted" style="display:none;">추가되었습니다. 바로 학습 목록에 반영됩니다.</p>
    </form>
  `;

  function parseCommaList(value) {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }

  document.getElementById('add-form').addEventListener('submit', e => {
    e.preventDefault();
    const term = document.getElementById('f-term').value.trim();
    const meaning = document.getElementById('f-meaning').value.trim();
    const exEn = document.getElementById('f-ex-en').value.trim();
    if (!term || !meaning || !exEn) return;

    const today = todayISO();
    const newWord = {
      id: uid('w'),
      term,
      ipa: document.getElementById('f-ipa').value.trim(),
      pos: document.getElementById('f-pos').value.trim(),
      type: document.getElementById('f-type').value,
      category: document.getElementById('f-category').value,
      meaningKo: meaning,
      examples: [{ en: exEn, ko: document.getElementById('f-ex-ko').value.trim() }],
      tip: document.getElementById('f-tip').value.trim(),
      synonyms: parseCommaList(document.getElementById('f-synonyms').value),
      antonyms: parseCommaList(document.getElementById('f-antonyms').value),
      collocations: parseCommaList(document.getElementById('f-collocations').value),
      isSeed: false,
      studyDay: 0, // 직접 추가한 단어는 학습일차 배치를 기다리지 않고 즉시 학습 목록에 반영
      firstStudiedDate: today,
      srs: { box: 0, dueDate: today, reps: 0, lastReviewed: null },
    };
    state.words.push(newWord);

    let day0 = state.studyDayLog.find(e => e.day === 0 && e.date === today);
    if (!day0) { day0 = { day: 0, date: today, wordIds: [] }; state.studyDayLog.push(day0); }
    day0.wordIds.push(newWord.id);

    saveState();

    document.getElementById('add-form').reset();
    const successMsg = document.getElementById('add-success');
    successMsg.style.display = 'block';
    setTimeout(() => { successMsg.style.display = 'none'; }, 2500);
  });
}

/* ---------------- 카테고리 관리 ---------------- */
function renderCategories() {
  const el = document.getElementById('panel-categories');
  el.innerHTML = `
    <div class="section-title">카테고리 목록</div>
    <div class="cat-manage-list">
      ${state.categories.map(c => {
        const count = state.words.filter(w => w.category === c.key).length;
        return `
          <div class="cat-manage-row">
            <span class="cat-badge">${escapeHtml(c.label)}</span>
            <span class="muted">${count}개 단어</span>
            ${c.core ? '<span class="core-tag">기본 카테고리</span>' : `<button class="icon-btn danger" data-key="${c.key}">삭제</button>`}
          </div>`;
      }).join('')}
    </div>

    <div class="section-title">새 카테고리 추가</div>
    <form id="cat-form" class="cat-form">
      <input type="text" id="f-cat-label" placeholder="예: 물류, 제조업, 헬스케어 ..." required />
      <button type="submit" class="btn primary">추가</button>
    </form>
  `;

  el.querySelectorAll('[data-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const count = state.words.filter(w => w.category === key).length;
      if (count > 0 && !confirm(`이 카테고리에 속한 단어 ${count}개도 함께 삭제됩니다. 계속할까요?`)) return;
      state.categories = state.categories.filter(c => c.key !== key);
      state.words = state.words.filter(w => w.category !== key);
      saveState();
      renderCategories();
    });
  });

  document.getElementById('cat-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('f-cat-label');
    const label = input.value.trim();
    if (!label) return;
    const key = 'c-' + label.toLowerCase().replace(/\s+/g, '-') + '-' + Math.random().toString(36).slice(2, 5);
    state.categories.push({ key, label, core: false });
    saveState();
    renderCategories();
  });
}

/* ---------------- 통계 ---------------- */
function renderStats() {
  const el = document.getElementById('panel-stats');
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const entry = state.reviewLog.find(e => e.date === iso);
    last7.push({ date: iso, count: entry ? entry.count : 0 });
  }
  const maxCount = Math.max(1, ...last7.map(d => d.count));
  const totalReviewed = state.reviewLog.reduce((sum, e) => sum + e.count, 0);
  const mastered = state.words.filter(w => w.srs.box >= INTERVALS_DAYS.length - 1).length;
  const daysStudied = state.studyDayLog.filter(e => e.day > 0).length;

  el.innerHTML = `
    <div class="card-grid">
      <div class="stat-card">
        <div class="stat-num">${totalReviewed}</div>
        <div class="stat-label">누적 복습 횟수</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${daysStudied}</div>
        <div class="stat-label">완료한 학습 일차</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${mastered}</div>
        <div class="stat-label">장기 기억 정착 단어</div>
      </div>
    </div>
    <div class="section-title">최근 7일 복습량</div>
    <div class="bar-chart">
      ${last7.map(d => `
        <div class="bar-col">
          <div class="bar" style="height:${(d.count / maxCount) * 100}px" title="${d.count}개"></div>
          <div class="bar-label">${d.date.slice(5)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

/* ---------------- 초기화 ---------------- */
function init() {
  state = loadState();
  saveState();

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  switchTab('dashboard');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  if (typeof initSync === 'function') initSync();
}

document.addEventListener('DOMContentLoaded', init);
