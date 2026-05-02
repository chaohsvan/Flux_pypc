const api = {
  async request(path, options = {}) {
    const response = await fetch(`/api/v1${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "请求失败");
    return payload.data;
  },
  get(path) { return this.request(path); },
  post(path, body = {}) { return this.request(path, { method: "POST", body: JSON.stringify(body) }); },
  patch(path, body = {}) { return this.request(path, { method: "PATCH", body: JSON.stringify(body) }); },
  delete(path, body) {
    return this.request(path, body === undefined ? { method: "DELETE" } : { method: "DELETE", body: JSON.stringify(body) });
  },
  async upload(path, formData) {
    const response = await fetch(`/api/v1${path}`, { method: "POST", body: formData });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "上传失败");
    return payload.data;
  },
};

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const state = {
  view: "calendar",
  selectedDate: toDateInput(new Date()),
  visibleMonth: new Date(),
  calendarView: "month",
  calendarLayers: { event: true, holiday: true, todo: false, diary: false, trash: false },
  holidayMarkMode: false,
  todoFilter: {},
  todoGroup: "",
  todoSelectionMode: false,
  todoTrashMode: false,
  selectedTodoId: null,
  selectedTodoIds: new Set(),
  currentTodos: [],
  draggingTodoId: null,
  touchStart: null,
  diaryFilter: {},
  diaryFilterTab: "all",
  diarySelectionMode: false,
  selectedDiaryIds: new Set(),
  currentDiaries: [],
  diaryArchives: { months: [], years: [] },
  attachments: null,
  attachmentKindFilter: "",
  projects: [],
  tags: [],
  toastTimer: null,
  theme: localStorage.getItem("flux-theme") || "system",
  markdownPreview: false,
  editingSubtasks: [],
};

const moodLabels = { happy: "开心", calm: "平和", neutral: "平静", anxious: "焦虑", sad: "难过" };
const priorityLabels = { normal: "正常", high: "高优先级" };
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

function $(selector) { return document.querySelector(selector); }
function $all(selector) { return [...document.querySelectorAll(selector)]; }

function toDateInput(value) {
  const d = new Date(value);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function timeInput(value) {
  if (!value) return "09:00";
  const d = new Date(value);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(11, 16);
}

function dateTime(dateValue, timeValue = "09:00") {
  return `${dateValue}T${timeValue || "09:00"}:00`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function keywordTerms(keyword) {
  const value = String(keyword || "").trim();
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

function findKeywordMatch(value, keyword) {
  const text = String(value || "");
  const lower = text.toLowerCase();
  let best = null;
  keywordTerms(keyword).forEach((term) => {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0 && (!best || index < best.index)) best = { index, length: term.length };
  });
  return best;
}

function highlightKeyword(value, keyword) {
  const text = String(value || "");
  const terms = keywordTerms(keyword).sort((a, b) => b.length - a.length);
  if (!text || !terms.length) return escapeHtml(text);
  const lower = text.toLowerCase();
  let cursor = 0;
  let output = "";
  while (cursor < text.length) {
    let next = null;
    terms.forEach((term) => {
      const index = lower.indexOf(term.toLowerCase(), cursor);
      if (index >= 0 && (!next || index < next.index || (index === next.index && term.length > next.length))) {
        next = { index, length: term.length };
      }
    });
    if (!next) break;
    output += escapeHtml(text.slice(cursor, next.index));
    output += `<mark>${escapeHtml(text.slice(next.index, next.index + next.length))}</mark>`;
    cursor = next.index + next.length;
  }
  output += escapeHtml(text.slice(cursor));
  return output;
}

function keywordExcerpt(value, keyword, maxLength = 170) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = findKeywordMatch(text, keyword);
  if (!match || text.length <= maxLength) return text.slice(0, maxLength);
  const start = Math.max(0, match.index - 54);
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "long", day: "numeric", weekday: "long",
  }).format(new Date(`${value}T00:00:00`));
}

function diaryDateParts(value) {
  if (!value) return { year: "--", monthDay: "--.--", weekday: "" };
  const dateValue = new Date(`${value}T00:00:00`);
  return {
    year: String(dateValue.getFullYear()),
    monthDay: `${String(dateValue.getMonth() + 1).padStart(2, "0")}.${String(dateValue.getDate()).padStart(2, "0")}`,
    weekday: new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(dateValue),
  };
}

function formatMonth(value) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(value);
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", weekday: "short" }).format(new Date(`${value}T00:00:00`));
}

function addDays(value, amount) {
  const next = new Date(`${value}T00:00:00`);
  next.setDate(next.getDate() + amount);
  return toDateInput(next);
}

function addMonths(value, amount) {
  const current = new Date(`${value}T00:00:00`);
  const day = current.getDate();
  const next = new Date(current.getFullYear(), current.getMonth() + amount, 1);
  next.setDate(Math.min(day, daysInMonth(next.getFullYear(), next.getMonth())));
  return toDateInput(next);
}

function startOfWeek(value) {
  const start = new Date(`${value}T00:00:00`);
  start.setDate(start.getDate() - start.getDay());
  return toDateInput(start);
}

function quarterStart(value) {
  const dateValue = value instanceof Date ? value : new Date(`${value}T00:00:00`);
  const month = Math.floor(dateValue.getMonth() / 3) * 3;
  return new Date(dateValue.getFullYear(), month, 1);
}

function quarterLabel(value) {
  const start = quarterStart(value);
  return `${start.getFullYear()} 年第 ${Math.floor(start.getMonth() / 3) + 1} 季度`;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false,
  }).format(new Date(value)).replaceAll("/", "-");
}

function normalizeDiarySystemText(value) {
  return String(value || "").replace(
    /(合并自回收站：)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/g,
    (_, label, rawTime) => `${label}${formatDateTime(rawTime)}`,
  );
}

function reminderLabel(value) {
  if (value === null || value === undefined || value === "") return "";
  const minutes = Number(value);
  if (minutes === 1440) return "提前 1 天";
  if (minutes === 60) return "提前 1 小时";
  return `提前 ${minutes} 分钟`;
}

function reminderOptions(selected) {
  const options = [
    ["", "不提醒"],
    ["5", "提前 5 分钟"],
    ["15", "提前 15 分钟"],
    ["30", "提前 30 分钟"],
    ["60", "提前 1 小时"],
    ["1440", "提前 1 天"],
  ];
  const value = selected === null || selected === undefined ? "" : String(selected);
  return options.map(([optionValue, label]) => `<option value="${optionValue}" ${value === optionValue ? "selected" : ""}>${label}</option>`).join("");
}

function setView(view) {
  state.view = view;
  $all(".rail-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $all(".view").forEach((panel) => panel.classList.remove("active"));
  $(`#${view}-view`).classList.add("active");
  $("#view-title").textContent = { calendar: "日历", todo: "待办", diary: "日记", settings: "设置" }[view];
  render();
}

async function bootstrap() {
  applyTheme();
  await loadProjects();
  await loadTags();
  await loadDiaryDateFilters();
  bindEvents();
  render();
}

function applyTheme() {
  const actualTheme = state.theme === "system" ? (systemTheme.matches ? "dark" : "light") : state.theme;
  document.documentElement.dataset.theme = actualTheme;
  const select = $("#theme-select");
  if (select) select.value = state.theme;
}

async function loadProjects() {
  state.projects = await api.get("/todo-projects");
  $("#entry-project").innerHTML = [
    `<option value="">无标签</option>`,
    ...state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`),
  ].join("");
  renderProjectFilters();
}

async function loadTags() {
  state.tags = await api.get("/diary-tags");
  renderTagFilters();
}

async function loadDiaryDateFilters() {
  const diaries = await api.get("/diaries");
  const months = new Map();
  const years = new Map();
  diaries.forEach((diary) => {
    if (!diary.entry_date) return;
    const month = diary.entry_date.slice(0, 7);
    const year = diary.entry_date.slice(0, 4);
    months.set(month, (months.get(month) || 0) + 1);
    years.set(year, (years.get(year) || 0) + 1);
  });
  state.diaryArchives = {
    months: [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([value, count]) => ({ value, count })),
    years: [...years.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([value, count]) => ({ value, count })),
  };
  renderDiaryDateFilters();
}

function renderProjectFilters() {
  $("#project-filter-list").innerHTML = state.projects.length
    ? state.projects.map((project) => `
        <div class="side-row">
          <button class="filter todo-drop-target" data-project-filter="${project.id}" data-drop-update='${escapeHtml(JSON.stringify({ project_id: project.id }))}'>${escapeHtml(project.name)}</button>
          <input class="project-color" type="color" value="${escapeHtml(project.color || "#4dabf7")}" data-project-color="${project.id}" title="标签颜色" />
          <button class="mini-action" data-delete-project="${project.id}" title="删除标签">×</button>
        </div>
      `).join("")
    : `<p class="eyebrow">暂无标签</p>`;
}

function renderTagFilters() {
  if (!$("#tag-filter-list")) return;
  $("#tag-filter-list").innerHTML = state.tags.length
    ? state.tags.map((tag) => `
        <button class="filter diary-filter-control diary-tag-filter ${state.diaryFilter.tag_id === tag.id ? "active" : ""}" data-tag-filter="${tag.id}">
          <span># ${escapeHtml(tag.name)}</span>
          <span class="tag-count">${tag.diary_count || 0}</span>
        </button>
      `).join("")
    : `<p class="eyebrow">写日记时添加标签后会显示在这里。</p>`;
}

function renderDiaryDateFilters() {
  const monthList = $("#diary-month-filter-list");
  const yearList = $("#diary-year-filter-list");
  if (monthList) {
    monthList.innerHTML = state.diaryArchives.months.length
      ? state.diaryArchives.months.map((item) => `<button class="filter diary-filter-control" data-diary-month="${item.value}">${item.value} (${item.count})</button>`).join("")
      : `<p class="eyebrow">暂无月份</p>`;
  }
  if (yearList) {
    yearList.innerHTML = state.diaryArchives.years.length
      ? state.diaryArchives.years.map((item) => `<button class="filter diary-filter-control" data-diary-year="${item.value}">${item.value} (${item.count})</button>`).join("")
      : `<p class="eyebrow">暂无年份</p>`;
  }
  setDiaryFilterTab(state.diaryFilterTab);
}

async function render() {
  try {
    if (state.view === "calendar") await renderCalendar();
    if (state.view === "todo") await renderTodos();
    if (state.view === "diary") await renderDiaries();
    if (state.view === "settings") await renderSettings();
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
}

async function renderSettings() {
  $("#theme-select").value = state.theme;
  await loadAttachments();
}

async function loadAttachments() {
  const stats = $("#attachment-stats");
  const list = $("#attachment-list");
  if (!stats || !list) return;
  stats.innerHTML = `<div class="attachment-loading">正在读取附件...</div>`;
  try {
    state.attachments = await api.get("/attachments");
    renderAttachmentPanel();
  } catch (error) {
    console.error(error);
    stats.innerHTML = `<div class="attachment-loading">附件信息读取失败</div>`;
    list.innerHTML = "";
  }
}

function formatFileSize(bytes = 0) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function formatAttachmentTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function renderAttachmentPanel() {
  const data = state.attachments || {
    total_count: 0, used_count: 0, unused_count: 0, total_bytes: 0, used_bytes: 0, unused_bytes: 0, items: [],
  };
  const items = data.items || [];
  const kindStats = {
    image: attachmentKindSummary(items, "image"),
    audio: attachmentKindSummary(items, "audio"),
    file: attachmentKindSummary(items, "file"),
  };
  const filteredItems = state.attachmentKindFilter
    ? items.filter((item) => item.kind === state.attachmentKindFilter)
    : items;
  $("#attachment-stats").innerHTML = [
    ["全部附件", data.total_count, formatFileSize(data.total_bytes)],
    ["已引用", data.used_count, formatFileSize(data.used_bytes)],
    ["未引用", data.unused_count, formatFileSize(data.unused_bytes)],
    ["图片", kindStats.image.count, formatFileSize(kindStats.image.bytes)],
    ["音频", kindStats.audio.count, formatFileSize(kindStats.audio.bytes)],
    ["其他", kindStats.file.count, formatFileSize(kindStats.file.bytes)],
  ].map(([label, count, size]) => `
    <div class="attachment-stat-card">
      <span>${label}</span>
      <strong>${count}</strong>
      <small>${size}</small>
    </div>
  `).join("");
  syncAttachmentKindButtons();
  $("#attachment-list").innerHTML = filteredItems.length
    ? filteredItems.map((item) => {
        const url = localAttachmentUrl(item.url);
        const isImage = item.kind === "image" && url;
        const references = item.references || [];
        const kindLabel = attachmentKindLabel(item.kind);
        return `
          <article class="attachment-item ${item.used ? "is-used" : "is-unused"}">
            <div class="attachment-thumb">
              ${isImage ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" />` : `<span>${kindLabel}</span>`}
            </div>
            <div class="attachment-info">
              <strong>${escapeHtml(item.name)}</strong>
              <span>${kindLabel} · ${escapeHtml(item.mime)} · ${formatFileSize(item.size)} · ${formatAttachmentTime(item.updated_at)}</span>
              <code>${escapeHtml(item.url)}</code>
              <div class="attachment-references">
                ${references.length
                  ? references.map((reference) => `
                      <button type="button" data-attachment-diary="${reference.diary_id}">
                        ${escapeHtml(reference.entry_date)}${reference.entry_time ? ` ${escapeHtml(reference.entry_time)}` : ""} · 第 ${reference.line} 行 · ${escapeHtml(reference.excerpt)}
                      </button>
                    `).join("")
                  : `<span>未被任何日记引用</span>`}
              </div>
            </div>
            <div class="attachment-actions">
              <span class="attachment-state">${item.used ? "已引用" : "未引用"}</span>
              <button class="danger-action" type="button" data-delete-attachment="${escapeHtml(item.url)}">删除</button>
            </div>
          </article>
        `;
      }).join("")
    : `<p class="attachment-empty">${items.length ? "当前类型下暂无附件" : "暂无附件"}</p>`;
  bindAttachmentReferenceButtons();
  bindAttachmentDeleteButtons();
}

function bindAttachmentReferenceButtons() {
  $all("[data-attachment-diary]").forEach((button) => {
    button.addEventListener("click", () => editItem("diary", button.dataset.attachmentDiary));
  });
}

function bindAttachmentDeleteButtons() {
  $all("[data-delete-attachment]").forEach((button) => {
    button.addEventListener("click", () => deleteAttachment(button.dataset.deleteAttachment));
  });
}

function attachmentKindSummary(items, kind) {
  const matched = items.filter((item) => item.kind === kind);
  return {
    count: matched.length,
    bytes: matched.reduce((total, item) => total + (Number(item.size) || 0), 0),
  };
}

function attachmentKindLabel(kind) {
  return { image: "图片", audio: "音频", file: "其他" }[kind] || "其他";
}

function syncAttachmentKindButtons() {
  $all("[data-attachment-kind]").forEach((button) => {
    button.classList.toggle("active", button.dataset.attachmentKind === state.attachmentKindFilter);
  });
}

function showHoliday(data) {
  return Boolean(state.calendarLayers.holiday && data?.is_holiday);
}

function showSummaryHoliday(summary) {
  return Boolean(state.calendarLayers.holiday && summary?.is_holiday);
}

async function renderCalendar() {
  $("#selected-date-label").textContent = formatDate(state.selectedDate);
  syncCalendarLayerButtons();
  const renderers = {
    day: renderDayCalendar,
    week: renderWeekCalendar,
    month: renderMonthCalendar,
    quarter: renderQuarterCalendar,
    "history-day": renderHistoryDayCalendar,
    "history-month": renderHistoryMonthCalendar,
  };
  await renderers[state.calendarView]();
  await renderDayAggregate();
}

async function renderMonthCalendar() {
  $(".weekday-grid").style.display = "grid";
  $("#calendar-grid").className = "calendar-grid";
  $("#month-label").textContent = formatMonth(state.visibleMonth);
  const year = state.visibleMonth.getFullYear();
  const month = state.visibleMonth.getMonth() + 1;
  const summary = await api.get(`/calendar/month?year=${year}&month=${month}`);
  const byDate = new Map(summary.map((item) => [item.date, item]));
  const first = new Date(year, month - 1, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const current = new Date(start);
    current.setDate(start.getDate() + index);
    const value = toDateInput(current);
    const data = byDate.get(value) || {};
    const muted = current.getMonth() !== month - 1;
    cells.push(calendarDayButton(value, current.getDate(), data, muted));
  }
  $("#calendar-grid").innerHTML = cells.join("");
  bindCalendarDayButtons();
}

async function renderWeekCalendar() {
  $(".weekday-grid").style.display = "none";
  $("#calendar-grid").className = "week-grid";
  const start = startOfWeek(state.selectedDate);
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  $("#month-label").textContent = `${formatShortDate(days[0])} - ${formatShortDate(days[6])}`;
  const aggregates = await Promise.all(days.map((day) => api.get(`/calendar/day/${day}`)));
  $("#calendar-grid").innerHTML = aggregates.map((data) => {
    const selected = data.date === state.selectedDate;
    const holidayVisible = showSummaryHoliday(data.summary);
    const classes = [
      "week-day",
      selected ? "is-selected" : "",
      holidayVisible ? "is-holiday" : "",
      state.holidayMarkMode ? "is-holiday-mode" : "",
    ].filter(Boolean).join(" ");
    const blocks = calendarAggregateBlocks(data, "compact");
    return `
      <section class="${classes}">
      <button class="week-day-head" data-date="${data.date}" title="${escapeHtml(holidayVisible ? data.summary.holiday_name || "" : "")}">
          <span>${formatShortDate(data.date)}</span>
          <span class="markers">${holidayVisible ? `<span class="marker holiday">休</span>` : ""}${state.calendarLayers.event && data.summary.event_count ? `<span class="marker event">事 ${data.summary.event_count}</span>` : ""}</span>
        </button>
        <div class="week-day-body">${blocks.length ? blocks.join("") : `<p class="muted-line">无安排</p>`}</div>
      </section>
    `;
  }).join("");
  bindCalendarDayButtons();
}

async function renderDayCalendar() {
  $(".weekday-grid").style.display = "none";
  $("#calendar-grid").className = "day-timeline";
  $("#month-label").textContent = formatDate(state.selectedDate);
  const data = await api.get(`/calendar/day/${state.selectedDate}`);
  const holidayVisible = showSummaryHoliday(data.summary);
  const allDayBlocks = [
    ...(state.calendarLayers.event ? data.events.filter((item) => item.all_day).map(eventCard) : []),
    ...(state.calendarLayers.todo ? data.todos_due.map(todoCard) : []),
    ...(state.calendarLayers.diary ? data.diaries.map(diaryCard) : []),
    ...(state.calendarLayers.trash ? [...(data.deleted_events || []).map(eventCard), ...(data.deleted_diaries || []).map(diaryCard)] : []),
  ];
  const timedEvents = state.calendarLayers.event ? data.events.filter((item) => !item.all_day) : [];
  const rows = Array.from({ length: 24 }, (_, hour) => {
    const blocks = timedEvents
      .filter((item) => new Date(item.start_at).getHours() === hour)
      .map(eventCard);
    return `
      <div class="timeline-row">
        <time>${String(hour).padStart(2, "0")}:00</time>
        <div class="timeline-slot">${blocks.length ? blocks.join("") : ""}</div>
      </div>
    `;
  });
  $("#calendar-grid").innerHTML = `
    <section class="timeline-all-day ${holidayVisible ? "is-holiday" : ""}">
      <div>
        <strong>${holidayVisible ? (data.summary.holiday_name || "节假日") : "全天"}</strong>
        ${state.calendarLayers.event ? `<span>${data.summary.event_count} 个事件</span>` : ""}
      </div>
      ${state.holidayMarkMode ? `<button class="holiday-inline-toggle" data-date="${state.selectedDate}">${data.summary.is_holiday ? "取消节假日" : "标记节假日"}</button>` : ""}
      <div class="stack">${allDayBlocks.length ? allDayBlocks.join("") : `<p class="muted-line">无全天内容</p>`}</div>
    </section>
    ${rows.join("")}
  `;
  bindCalendarDayButtons();
}

async function renderQuarterCalendar() {
  $(".weekday-grid").style.display = "none";
  $("#calendar-grid").className = "quarter-grid";
  const start = quarterStart(state.visibleMonth);
  $("#month-label").textContent = quarterLabel(start);
  const months = [0, 1, 2].map((offset) => new Date(start.getFullYear(), start.getMonth() + offset, 1));
  const monthSummaries = await Promise.all(months.map((monthDate) => api.get(`/calendar/month?year=${monthDate.getFullYear()}&month=${monthDate.getMonth() + 1}`)));
  $("#calendar-grid").innerHTML = months.map((monthDate, monthIndex) => {
    const summary = monthSummaries[monthIndex];
    const byDate = new Map(summary.map((item) => [item.date, item]));
    const firstOffset = monthDate.getDay();
    const totalDays = daysInMonth(monthDate.getFullYear(), monthDate.getMonth());
    const cells = [];
    for (let index = 0; index < firstOffset; index += 1) cells.push(`<span class="quarter-empty"></span>`);
    for (let day = 1; day <= totalDays; day += 1) {
      const value = toDateInput(new Date(monthDate.getFullYear(), monthDate.getMonth(), day));
      const data = byDate.get(value) || {};
      cells.push(calendarDayButton(value, day, data, false, "quarter-day"));
    }
    return `
      <section class="quarter-month">
        <h3>${formatMonth(monthDate)}</h3>
        <div class="quarter-weekdays"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
        <div class="quarter-days">${cells.join("")}</div>
      </section>
    `;
  }).join("");
  bindCalendarDayButtons();
}

async function renderHistoryDayCalendar() {
  await renderHistoryCalendar("day");
}

async function renderHistoryMonthCalendar() {
  await renderHistoryCalendar("month");
}

async function renderHistoryCalendar(mode) {
  $(".weekday-grid").style.display = "none";
  $("#calendar-grid").className = "calendar-history";
  const data = await api.get(`/calendar/history?mode=${mode}&date=${state.selectedDate}`);
  const dateValue = new Date(`${state.selectedDate}T00:00:00`);
  $("#month-label").textContent = mode === "day"
    ? `那年今日 · ${dateValue.getMonth() + 1}月${dateValue.getDate()}日`
    : `那年这月 · ${dateValue.getMonth() + 1}月`;
  const items = historyItems(data);
  $("#calendar-grid").innerHTML = `
    <section class="history-overview">
      <div class="metric"><span>全部</span><strong>${items.length}</strong></div>
      ${state.calendarLayers.event ? `<div class="metric"><span>事件</span><strong>${data.summary.event_count}</strong></div>` : ""}
      ${state.calendarLayers.todo ? `<div class="metric"><span>待办</span><strong>${data.summary.todo_count}</strong></div>` : ""}
      ${state.calendarLayers.diary ? `<div class="metric"><span>日记</span><strong>${data.summary.diary_count}</strong></div>` : ""}
    </section>
    ${renderHistoryGroups(items)}
  `;
  bindCardActions();
}

function historyItems(data) {
  return [
    ...(state.calendarLayers.event ? data.events.map((item) => ({ date: item.start_at.slice(0, 10), type: "event", card: eventCard(item) })) : []),
    ...(state.calendarLayers.todo ? data.todos_due.map((item) => ({ date: item.due_at.slice(0, 10), type: "todo", card: todoCard(item) })) : []),
    ...(state.calendarLayers.diary ? data.diaries.map((item) => ({ date: item.entry_date, type: "diary", card: diaryCard(item) })) : []),
  ].sort((a, b) => b.date.localeCompare(a.date));
}

function renderHistoryGroups(items) {
  if (!items.length) return `<p class="aggregate-empty">没有匹配的历史内容。选中日历事件、待办或日记后会在这里展示。</p>`;
  const groups = new Map();
  items.forEach((item) => {
    const year = item.date.slice(0, 4);
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(item);
  });
  return [...groups.entries()].map(([year, groupItems]) => `
    <section class="history-year-section">
      <div class="history-year-head">
        <h3>${year}</h3>
        <span>${groupItems.length} 项</span>
      </div>
      <div class="stack">
        ${groupItems.map((item) => `
          <div class="history-item-row">
            <time>${item.date}</time>
            ${item.card.replace('class="card ', 'class="card compact-card ')}
          </div>
        `).join("")}
      </div>
    </section>
  `).join("");
}

function calendarDayButton(value, label, data, muted = false, extraClass = "") {
  const today = toDateInput(new Date());
  const holidayVisible = showHoliday(data);
  const title = state.holidayMarkMode ? "点击切换节假日标记" : (holidayVisible ? data.holiday_name || "" : "");
  const classes = [
    extraClass || "day-cell",
    value === today ? "is-today" : "",
    value === state.selectedDate ? "is-selected" : "",
    muted ? "is-muted" : "",
    holidayVisible ? "is-holiday" : "",
    state.holidayMarkMode ? "is-holiday-mode" : "",
  ].filter(Boolean).join(" ");
  return `
    <button class="${classes}" data-date="${value}" title="${escapeHtml(title)}">
      <span class="day-number">${label}</span>
      <span class="markers">${calendarMarkers(data)}</span>
    </button>
  `;
}

function calendarMarkers(data) {
  const deletedCount = (data.deleted_diary_count || 0) + (data.deleted_event_count || 0);
  return [
    showHoliday(data) ? `<span class="marker holiday">休</span>` : "",
    state.calendarLayers.diary && data.diary_count ? `<span class="marker diary">记 ${data.diary_count}</span>` : "",
    state.calendarLayers.todo && data.todo_due_count ? `<span class="marker todo">待 ${data.todo_due_count}</span>` : "",
    state.calendarLayers.event && data.event_count ? `<span class="marker event">事 ${data.event_count}</span>` : "",
    state.calendarLayers.trash && deletedCount ? `<span class="marker trash">删 ${deletedCount}</span>` : "",
  ].join("");
}

function calendarAggregateBlocks(data, mode = "full") {
  const blocks = [
    ...(state.calendarLayers.event ? data.events.map(eventCard) : []),
    ...(state.calendarLayers.todo ? data.todos_due.map(todoCard) : []),
    ...(state.calendarLayers.diary ? data.diaries.map(diaryCard) : []),
    ...(state.calendarLayers.trash ? [...(data.deleted_events || []).map(eventCard), ...(data.deleted_diaries || []).map(diaryCard)] : []),
  ];
  if (mode !== "compact") return blocks;
  return blocks.map((block) => block.replace('class="card ', 'class="card compact-card '));
}

function dayAggregateSection(type, title, count, items, createKind) {
  return `
    <section class="aggregate-section aggregate-${type}">
      <div class="aggregate-head">
        <div>
          <h3><span class="type-dot"></span>${title}</h3>
          <span>${count} 项</span>
        </div>
        ${createKind ? `<button type="button" data-create="${createKind}" title="新增${title}">+</button>` : ""}
      </div>
      <div class="aggregate-stack">
        ${items.length ? items.join("") : `<p class="aggregate-empty">暂无${title}</p>`}
      </div>
    </section>
  `;
}

function renderDaySections(data) {
  const sections = [];
  if (state.calendarLayers.event) {
    sections.push(dayAggregateSection("event", "事件", data.events.length, data.events.map(eventCard), "event"));
  }
  if (state.calendarLayers.todo) {
    sections.push(dayAggregateSection("todo", "待办", data.todos_due.length, data.todos_due.map(todoCard), "todo"));
  }
  if (state.calendarLayers.diary) {
    sections.push(dayAggregateSection("diary", "日记", data.diaries.length, data.diaries.map(diaryCard), "diary"));
  }
  if (state.calendarLayers.trash) {
    const deletedItems = [...(data.deleted_events || []).map(eventCard), ...(data.deleted_diaries || []).map(diaryCard)];
    sections.push(dayAggregateSection("trash", "回收站", deletedItems.length, deletedItems, ""));
  }
  return sections.join("");
}

function bindCreateButtons(scope = document) {
  scope.querySelectorAll("[data-create]").forEach((button) => {
    button.addEventListener("click", () => createItemForSelectedDate(button.dataset.create));
  });
}

async function createItemForSelectedDate(kind) {
  if (kind === "diary") {
    const diaries = await api.get(`/diaries?date_from=${state.selectedDate}&date_to=${state.selectedDate}`);
    if (diaries.length) {
      await openDialog("diary", diaries[0]);
      return;
    }
  }
  openDialog(kind);
}

function bindCalendarDayButtons() {
  $all("button[data-date]").forEach((cell) => cell.addEventListener("click", async (event) => {
    event.stopPropagation();
    state.selectedDate = cell.dataset.date;
    state.visibleMonth = new Date(`${cell.dataset.date}T00:00:00`);
    if (state.holidayMarkMode) {
      await toggleHoliday(cell.dataset.date);
      return;
    }
    renderCalendar();
  }));
}

async function renderDayAggregate() {
  const data = await api.get(`/calendar/day/${state.selectedDate}`);
  const metrics = [];
  if (showSummaryHoliday(data.summary)) {
    metrics.unshift(`<div class="metric holiday-metric"><span>标记</span><strong>${escapeHtml(data.summary.holiday_name || "节假日")}</strong></div>`);
  }
  if (state.calendarLayers.event) {
    metrics.push(`<div class="metric"><span>事件</span><strong>${data.summary.event_count}</strong></div>`);
  }
  if (state.calendarLayers.todo) {
    metrics.push(`<div class="metric"><span>待办</span><strong>${data.summary.open_todo_count}</strong></div>`);
  }
  if (state.calendarLayers.diary) {
    metrics.push(`<div class="metric"><span>日记</span><strong>${data.summary.diary_count}</strong></div>`);
  }
  if (state.calendarLayers.trash) {
    metrics.push(`<div class="metric"><span>回收站</span><strong>${(data.summary.deleted_diary_count || 0) + (data.summary.deleted_event_count || 0)}</strong></div>`);
  }
  $("#day-summary").innerHTML = `
    ${metrics.join("")}
  `;
  $("#day-aggregate").innerHTML = renderDaySections(data);
  bindCardActions();
  bindCreateButtons($("#day-aggregate"));
}

function syncCalendarLayerButtons() {
  $all("[data-calendar-view]").forEach((button) => {
    const active = button.dataset.calendarView === state.calendarView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  $all("[data-calendar-layer]").forEach((button) => {
    const layer = button.dataset.calendarLayer;
    const active = Boolean(state.calendarLayers[layer]);
    button.classList.toggle("is-active", active);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  $all("[data-holiday-mode]").forEach((button) => {
    button.classList.toggle("is-active", state.holidayMarkMode);
    button.classList.toggle("active", state.holidayMarkMode);
    button.setAttribute("aria-pressed", state.holidayMarkMode ? "true" : "false");
  });
}

async function toggleHoliday(dateValue) {
  const result = await api.post(`/calendar/holidays/${dateValue}/toggle`);
  await renderCalendar();
  showToast(result.is_holiday ? "已标记为节假日" : "已取消节假日标记");
}

function navigateCalendar(direction) {
  if (state.calendarView === "day" || state.calendarView === "history-day") {
    state.selectedDate = addDays(state.selectedDate, direction);
    state.visibleMonth = new Date(`${state.selectedDate}T00:00:00`);
    return;
  }
  if (state.calendarView === "week") {
    state.selectedDate = addDays(state.selectedDate, direction * 7);
    state.visibleMonth = new Date(`${state.selectedDate}T00:00:00`);
    return;
  }
  if (state.calendarView === "history-month") {
    state.selectedDate = addMonths(state.selectedDate, direction);
    state.visibleMonth = new Date(`${state.selectedDate}T00:00:00`);
    return;
  }
  const step = state.calendarView === "quarter" ? 3 : 1;
  state.visibleMonth = new Date(state.visibleMonth.getFullYear(), state.visibleMonth.getMonth() + direction * step, 1);
  if (state.calendarView === "quarter") state.selectedDate = toDateInput(state.visibleMonth);
}

async function renderTodos() {
  await renderTodoSummary();
  await renderTodoStats();
  const params = new URLSearchParams();
  const keyword = $("#todo-search").value.trim();
  if (keyword) params.set("keyword", keyword);
  params.set("sort", $("#todo-sort").value || "smart");
  if (state.todoTrashMode) params.set("deleted", "true");
  Object.entries(state.todoFilter).forEach(([key, value]) => { if (value) params.set(key, value); });
  const todos = await api.get(`/todos?${params}`);
  state.currentTodos = todos;
  const visibleIds = new Set(todos.map((todo) => todo.id));
  state.selectedTodoIds = new Set([...state.selectedTodoIds].filter((id) => visibleIds.has(id)));
  $("#todo-list").innerHTML = todos.length ? renderTodoCollection(todos) : emptyCard(state.todoTrashMode ? "回收站是空的。" : "没有符合条件的任务。");
  bindCardActions();
  updateBatchBar();
}

function renderTodoCollection(todos) {
  if (!state.todoGroup) return todos.map(todoCard).join("");
  const groups = new Map();
  todos.forEach((todo) => {
    const key = todoGroupKey(todo);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(todo);
  });
  return `<div class="todo-group">${
    [...groups.entries()].map(([label, items]) => `
      <section class="todo-group-section">
        <h3 class="todo-group-title">${escapeHtml(label)} (${items.length})</h3>
        ${items.map(todoCard).join("")}
      </section>
    `).join("")
  }</div>`;
}

function todoGroupKey(todo) {
  if (state.todoGroup === "project") return todo.project_name || "无标签";
  if (state.todoGroup === "priority") return priorityLabels[todo.priority] || "正常";
  if (state.todoGroup === "status") return todoStatusLabel(todo.status);
  if (state.todoGroup === "due") {
    if (!todo.due_at) return "无日期";
    const due = toDateInput(todo.due_at);
    const today = toDateInput(new Date());
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = toDateInput(tomorrowDate);
    if (due === today) return "今天";
    if (due === tomorrow) return "明天";
    return due;
  }
  return "全部";
}

function todoStatusLabel(status) {
  return { pending: "待完成", in_progress: "进行中", completed: "已完成" }[status] || status;
}

async function renderTodoSummary() {
  const summary = await api.get("/todos/summary");
  $("#todo-summary-important").textContent = summary.important;
  $("#todo-summary-planned").textContent = summary.planned;
}

async function renderTodoStats() {
  const stats = await api.get("/todos/stats");
  $("#todo-stats").innerHTML = `
    <div class="todo-stat-card"><span>总任务</span><strong>${stats.total}</strong></div>
    <div class="todo-stat-card"><span>未完成</span><strong>${stats.open}</strong></div>
    <div class="todo-stat-card"><span>已完成</span><strong>${stats.completed}</strong></div>
    <div class="todo-stat-card"><span>完成率</span><strong>${Math.round(stats.completion_rate * 100)}%</strong></div>
  `;
}

function updateBatchBar() {
  const count = state.selectedTodoIds.size;
  $("#todo-selected-count").textContent = `已选 ${count} 项`;
  $("#todo-batch-bar").classList.toggle("active", !state.todoTrashMode && (state.todoSelectionMode || count > 0));
  $("#todo-export-toggle").textContent = state.todoSelectionMode ? "退出多选" : "多选";
  $("#todo-export-toggle").disabled = state.todoTrashMode;
  $all("[data-select-todo]").forEach((checkbox) => {
    checkbox.checked = state.selectedTodoIds.has(checkbox.dataset.selectTodo);
    checkbox.classList.toggle("is-hidden", !state.todoSelectionMode);
  });
}

function clearTodoDetail() {
  $("#todo-detail-title").textContent = "选择任务";
  $("#todo-detail-content").className = "detail-empty";
  $("#todo-detail-content").innerHTML = "从列表中打开一条任务，查看标签、截止时间、提醒和子任务。";
}

async function openTodoDetail(id) {
  state.selectedTodoId = id;
  if (state.view !== "todo") {
    setView("todo");
    setTimeout(() => renderTodoDetail(id), 0);
    return;
  }
  await renderTodoDetail(id);
  $all("[data-kind='todo']").forEach((card) => card.classList.toggle("is-selected", card.dataset.id === id));
}

async function renderTodoDetail(id) {
  if (!id) {
    clearTodoDetail();
    return;
  }
  let item;
  try {
    item = await api.get(`/todos/${id}`);
  } catch (error) {
    state.selectedTodoId = null;
    clearTodoDetail();
    return;
  }
  $("#todo-detail-title").textContent = item.title;
  const dueDate = item.due_at ? toDateInput(item.due_at) : "";
  const dueTime = item.due_at ? timeInput(item.due_at) : "09:00";
  const subtasks = item.subtasks || [];
  const history = await api.get(`/todos/${id}/history`);
  $("#todo-detail-content").className = "detail-content";
  $("#todo-detail-content").innerHTML = `
    <div class="detail-form" data-detail-todo="${item.id}">
      <label>标题 <input id="detail-todo-title-input" value="${escapeHtml(item.title)}" /></label>
      <label>描述 <textarea id="detail-todo-description" rows="4">${escapeHtml(item.description || "")}</textarea></label>
      <div class="detail-grid">
        <label>状态
          <select id="detail-todo-status">
            <option value="pending" ${item.status === "pending" ? "selected" : ""}>待完成</option>
            <option value="in_progress" ${item.status === "in_progress" ? "selected" : ""}>进行中</option>
            <option value="completed" ${item.status === "completed" ? "selected" : ""}>已完成</option>
          </select>
        </label>
        <label>优先级
          <select id="detail-todo-priority">
            <option value="normal" ${item.priority !== "high" ? "selected" : ""}>正常</option>
            <option value="high" ${item.priority === "high" ? "selected" : ""}>高优先级</option>
          </select>
        </label>
      </div>
      <div class="detail-grid">
        <label>日期 <input id="detail-todo-date" type="date" value="${dueDate}" /></label>
        <label>时间 <input id="detail-todo-time" type="time" value="${dueTime}" /></label>
      </div>
      <label>标签
        <select id="detail-todo-project">
          <option value="">无标签</option>
          ${state.projects.map((project) => `<option value="${project.id}" ${project.id === item.project_id ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}
        </select>
      </label>
      <label>提醒
        <select id="detail-todo-reminder">${reminderOptions(item.reminder_minutes)}</select>
      </label>
      <div class="detail-meta">
        ${item.project_name ? `<span class="chip">${escapeHtml(item.project_name)}</span>` : ""}
        ${item.due_at ? `<span class="chip">${formatTime(item.due_at)}</span>` : ""}
        ${item.reminder_minutes !== null && item.reminder_minutes !== undefined ? `<span class="chip">${reminderLabel(item.reminder_minutes)}</span>` : ""}
        ${subtasks.length ? `<span class="chip">子任务 ${subtasks.filter((x) => x.is_completed).length}/${subtasks.length}</span>` : ""}
      </div>
      <div class="detail-actions">
        <button class="primary" type="button" data-detail-save="${item.id}">保存详情</button>
        <button class="ghost" type="button" data-detail-edit="${item.id}">完整编辑</button>
      </div>
      <div class="history-list">
        <p class="eyebrow">历史</p>
        ${history.length ? history.map(historyItem).join("") : `<div class="history-item"><strong>暂无历史</strong></div>`}
      </div>
    </div>
  `;
}

function historyItem(item) {
  return `
    <div class="history-item">
      <strong>${escapeHtml(item.summary)}</strong>
      <span>${formatTime(item.created_at)}</span>
    </div>
  `;
}

async function saveTodoDetail(id) {
  const title = $("#detail-todo-title-input").value.trim();
  if (!title) return;
  const dueDate = $("#detail-todo-date").value;
  const dueTime = $("#detail-todo-time").value || "09:00";
  const reminder = $("#detail-todo-reminder").value;
  await api.patch(`/todos/${id}`, {
    title,
    description: $("#detail-todo-description").value.trim(),
    status: $("#detail-todo-status").value,
    priority: $("#detail-todo-priority").value,
    due_at: dueDate ? dateTime(dueDate, dueTime) : null,
    project_id: $("#detail-todo-project").value || null,
    reminder_minutes: reminder === "" ? null : Number(reminder),
  });
  await renderTodos();
  await renderTodoDetail(id);
  showToast("任务详情已保存");
}

async function renderDiaries() {
  const params = diaryQueryParams();
  const keyword = $("#diary-search").value.trim();
  const diaries = await api.get(`/diaries?${params}`);
  state.currentDiaries = diaries;
  if (!state.diarySelectionMode) {
    state.selectedDiaryIds.clear();
  } else {
    state.selectedDiaryIds = new Set([...state.selectedDiaryIds].filter((id) => diaries.some((item) => item.id === id)));
  }
  const status = $("#diary-search-status");
  if (status) {
    status.hidden = !keyword;
    status.textContent = keyword ? `定位到 ${diaries.length} 篇包含“${keyword}”的日记` : "";
  }
  $("#diary-list").innerHTML = diaries.length ? diaries.map((item) => diaryCard(item, keyword)).join("") : emptyCard(keyword ? "没有定位到匹配的日记。" : "还没有日记。");
  updateDiaryBatchBar();
  bindCardActions();
}

function diaryQueryParams() {
  const params = new URLSearchParams();
  const keyword = $("#diary-search").value.trim();
  if (keyword) params.set("keyword", keyword);
  Object.entries(state.diaryFilter).forEach(([key, value]) => { if (value) params.set(key, value); });
  return params;
}

function updateDiaryBatchBar() {
  const bar = $("#diary-batch-bar");
  if (!bar) return;
  const count = state.selectedDiaryIds.size;
  bar.classList.toggle("active", state.diarySelectionMode);
  $(".diary-layout")?.classList.toggle("export-active", state.diarySelectionMode);
  $("#diary-selected-count").textContent = `已选 ${count} 篇`;
  $("#diary-export-toggle").textContent = state.diarySelectionMode ? "退出导出" : "导出";
}

function selectedDiariesForExport() {
  return state.currentDiaries.filter((diary) => state.selectedDiaryIds.has(diary.id));
}

function monthRange(value) {
  const [year, month] = value.split("-").map(Number);
  const first = `${value}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  return { date_from: first, date_to: `${value}-${String(lastDay).padStart(2, "0")}` };
}

function yearRange(value) {
  return { date_from: `${value}-01-01`, date_to: `${value}-12-31` };
}

function setDiaryFilterTab(tab) {
  state.diaryFilterTab = tab;
  $all("[data-diary-tab]").forEach((button) => button.classList.toggle("active", button.dataset.diaryTab === tab));
  $all("[data-diary-filter-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.diaryFilterPanel === tab));
}

function diaryTabForButton(button) {
  if (button.dataset.diaryTab === "trash" || button.dataset.diaryTrash) return "trash";
  if (button.dataset.diaryFavorite) return "favorite";
  if (button.dataset.diaryMood) return "mood";
  if (button.dataset.diaryMonth) return "month";
  if (button.dataset.diaryYear) return "year";
  if (button.dataset.tagFilter) return "all";
  return "all";
}

function applyDiaryFilter(button) {
  $all(".diary-filter-control").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  setDiaryFilterTab(diaryTabForButton(button));
  state.diaryFilter = {};
  if (button.dataset.diaryMood) state.diaryFilter.mood = button.dataset.diaryMood;
  if (button.dataset.diaryFavorite) state.diaryFilter.is_favorite = "true";
  if (button.dataset.diaryTab === "trash" || button.dataset.diaryTrash) state.diaryFilter.deleted = "true";
  if (button.dataset.diaryMonth) Object.assign(state.diaryFilter, monthRange(button.dataset.diaryMonth));
  if (button.dataset.diaryYear) Object.assign(state.diaryFilter, yearRange(button.dataset.diaryYear));
  if (button.dataset.tagFilter) state.diaryFilter.tag_id = button.dataset.tagFilter;
  state.diarySelectionMode = false;
  state.selectedDiaryIds.clear();
  renderTagFilters();
  renderDiaries();
}

function diaryCard(item, keyword = "") {
  const content = normalizeDiarySystemText(item.content_md || "");
  const preview = keywordExcerpt(content, keyword) || "还没有正文。";
  const isDeleted = Boolean(item.deleted_at);
  const dateParts = diaryDateParts(item.entry_date);
  const tags = item.tags || [];
  const selectBox = state.diarySelectionMode && !isDeleted
    ? `<input class="todo-select" type="checkbox" data-select-diary="${item.id}" ${state.selectedDiaryIds.has(item.id) ? "checked" : ""} aria-label="选择日记" />`
    : "";
  return `
    <article class="card type-diary ${isDeleted ? "is-deleted" : ""}" data-kind="diary" data-id="${item.id}">
      <div class="diary-card-body">
        <div class="diary-date-badge" aria-label="${escapeHtml(item.entry_date || "")}">
          <span>${highlightKeyword(dateParts.year, keyword)}</span>
          <strong>${highlightKeyword(dateParts.monthDay, keyword)}</strong>
          <small>${escapeHtml(dateParts.weekday)}</small>
        </div>
        <div class="diary-card-main">
          <div class="card-head">
            <div class="card-title-row">
              <p class="diary-preview">${highlightKeyword(preview, keyword)}</p>
            </div>
            <div class="card-actions">
              ${isDeleted ? `<button class="complete-action" data-restore-diary="${item.id}">恢复</button>` : `
                <button class="edit-action" data-edit="diary" data-id="${item.id}">编辑</button>
                <button class="danger-action" data-delete="diary" data-id="${item.id}">删除</button>
                ${selectBox}
              `}
            </div>
          </div>
          ${tags.length ? `
            <div class="diary-tag-row">
              ${tags.map((tag) => `<button type="button" class="diary-tag-pill" data-card-tag-filter="${tag.id}"># ${highlightKeyword(tag.name, keyword)}</button>`).join("")}
            </div>
          ` : ""}
          <div class="meta diary-meta">
            ${isDeleted ? `<span class="chip">删除于 ${formatTime(item.deleted_at)}</span>` : ""}
            ${item.entry_time ? `<span class="chip time-chip">${highlightKeyword(item.entry_time, keyword)}</span>` : ""}
            ${item.mood ? `<span class="chip">${highlightKeyword(moodLabels[item.mood] || item.mood, keyword)}</span>` : ""}
            ${item.weather ? `<span class="chip">${highlightKeyword(item.weather, keyword)}</span>` : ""}
            ${item.location_name ? `<span class="chip">${highlightKeyword(item.location_name, keyword)}</span>` : ""}
            ${item.is_favorite ? `<span class="chip favorite-chip">收藏</span>` : ""}
            <span class="chip">${item.word_count || 0} 字</span>
          </div>
        </div>
      </div>
    </article>
  `;
}

function todoCard(item) {
  const subtasks = item.subtasks || [];
  const isCompleted = item.status === "completed";
  const isDeleted = Boolean(item.deleted_at);
  const statusChip = item.status === "completed" ? `<span class="chip">已完成</span>` : "";
  const deletedChip = isDeleted ? `<span class="chip">删除时状态：${todoStatusLabel(item.status)}</span><span class="chip">删除于 ${formatTime(item.deleted_at)}</span>` : "";
  const statusButton = isCompleted
    ? `<button class="complete-check-button done" type="button" data-toggle-complete-todo="${item.id}" data-status="completed" title="标记为未完成">✓</button>`
    : `<button class="complete-check-button" type="button" data-toggle-complete-todo="${item.id}" data-status="${item.status}" title="标记为已完成"></button>`;
  return `
    <article class="card type-todo ${item.id === state.selectedTodoId ? "is-selected" : ""} ${isCompleted ? "is-completed" : ""} ${isDeleted ? "is-deleted" : ""}" data-kind="todo" data-id="${item.id}" draggable="${isDeleted ? "false" : "true"}">
      <div class="card-head">
        <div class="card-title-row">
          ${isDeleted ? "" : `<span class="drag-handle" title="拖拽排序">↕</span>${statusButton}`}
          <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description || "")}</p></div>
        </div>
        <div class="card-actions">
          ${isDeleted ? `<button class="complete-action" data-restore-todo="${item.id}">恢复</button>` : `
            <button class="edit-action" data-edit="todo" data-id="${item.id}">编辑</button>
            <button class="danger-action" data-delete="todo" data-id="${item.id}">删除</button>
            <input class="todo-select ${state.todoSelectionMode ? "" : "is-hidden"}" type="checkbox" data-select-todo="${item.id}" title="选择任务" ${state.selectedTodoIds.has(item.id) ? "checked" : ""} />
          `}
        </div>
      </div>
      <div class="meta">
        <span class="chip ${item.priority}">${priorityLabels[item.priority] || item.priority}</span>
        ${statusChip}
        ${deletedChip}
        ${item.due_at ? `<span class="chip">${formatTime(item.due_at)}</span>` : ""}
        ${item.reminder_minutes !== null && item.reminder_minutes !== undefined ? `<span class="chip">${reminderLabel(item.reminder_minutes)}</span>` : ""}
        ${item.project_name ? `<span class="chip">${escapeHtml(item.project_name)}</span>` : ""}
        ${subtasks.length ? `<span class="chip">子任务 ${subtasks.filter((x) => x.is_completed).length}/${subtasks.length}</span>` : ""}
      </div>
      ${subtasks.length ? `
        <div class="subtasks-list">
          ${subtasks.map((subtask) => {
            const subtaskButton = subtask.is_completed
              ? `<button class="complete-check-button done" type="button" data-toggle-subtask="${subtask.id}" data-completed="true" title="标记子任务为未完成">✓</button>`
              : `<button class="complete-check-button" type="button" data-toggle-subtask="${subtask.id}" data-completed="false" title="标记子任务为已完成"></button>`;
            return `
            <div class="subtask-row ${subtask.is_completed ? "is-completed" : ""}">
              ${subtaskButton}
              <input type="text" value="${escapeHtml(subtask.title)}" data-subtask-title="${subtask.id}" />
              <button type="button" data-subtask-delete="${subtask.id}">删除</button>
            </div>
          `;
          }).join("")}
        </div>
      ` : ""}
      <div class="swipe-hint">移动端右滑完成，左滑删除</div>
    </article>
  `;
}

function eventCard(item) {
  const isDeleted = Boolean(item.deleted_at);
  return `
    <article class="card type-event ${isDeleted ? "is-deleted" : ""}" data-kind="event" data-id="${item.id}">
      <div class="card-head">
        <div>
          <h3><span class="color-dot" style="background:${escapeHtml(item.color || "#4dabf7")}"></span>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.description || "")}</p>
        </div>
        <div class="card-actions">
          ${isDeleted ? `<button class="complete-action" data-restore-event="${item.id}">恢复</button>` : `
            <button class="edit-action" data-edit="event" data-id="${item.id}">编辑</button>
            <button class="danger-action" data-delete="event" data-id="${item.id}">删除</button>
          `}
        </div>
      </div>
      <div class="meta">
        ${isDeleted ? `<span class="chip">删除于 ${formatTime(item.deleted_at)}</span>` : ""}
        <span class="chip">${item.all_day ? "全天" : `${formatTime(item.start_at)} - ${formatTime(item.end_at)}`}</span>
        ${item.location_name ? `<span class="chip">${escapeHtml(item.location_name)}</span>` : ""}
        ${item.reminder_minutes !== null && item.reminder_minutes !== undefined ? `<span class="chip">${reminderLabel(item.reminder_minutes)}</span>` : ""}
      </div>
    </article>
  `;
}

function emptyCard(text) {
  return `<div class="card"><p>${escapeHtml(text)}</p></div>`;
}

async function openDialog(kind, item = null) {
  state.markdownPreview = false;
  const dialog = $("#entry-dialog");
  const entryBody = kind === "diary" ? normalizeDiarySystemText(item?.content_md || "") : item?.description || "";
  dialog.classList.toggle("diary-writing", kind === "diary");
  $("#entry-title").closest("label").style.display = kind === "diary" ? "none" : "grid";
  $("#entry-kind").value = kind;
  $("#entry-id").value = item?.id || "";
  $("#entry-title").value = kind === "diary" ? "" : item?.title || "";
  $("#entry-body").value = entryBody;
  $("#entry-title").placeholder = "";
  $("#entry-body").placeholder = kind === "diary" ? "从今天发生的事、想法或感受写起..." : "";
  $("#entry-body").rows = kind === "diary" ? 18 : 6;
  $("#entry-date").value = item ? getItemDate(kind, item) : state.selectedDate;
  $("#entry-time").value = kind === "diary" ? item?.entry_time || "" : item ? getItemTime(kind, item) : "09:00";
  $("#entry-project").value = item?.project_id || "";
  $("#entry-priority").value = item?.priority || "normal";
  $("#entry-todo-reminder").value = item?.reminder_minutes ?? "";
  $("#entry-mood").value = item?.mood || "";
  $("#entry-weather").value = item?.weather || "";
  $("#entry-location").value = kind === "diary" ? item?.location_name || "" : "";
  $("#entry-favorite").checked = Boolean(item?.is_favorite);
  $("#entry-tags").value = (item?.tags || []).map((tag) => tag.name).join(", ");
  state.editingSubtasks = (item?.subtasks || []).map((subtask) => ({ ...subtask }));
  renderSubtaskEditor();
  $("#entry-event-color").value = item?.color || "#4dabf7";
  $("#entry-event-location").value = item?.location_name || "";
  $("#entry-event-reminder").value = item?.reminder_minutes ?? "";
  $("#entry-event-all-day").checked = Boolean(item?.all_day);
  $("#dialog-title").textContent = `${item ? "编辑" : "新建"}${{ diary: "日记", todo: "待办", event: "事件" }[kind]}`;
  $("#project-field").style.display = kind === "todo" ? "grid" : "none";
  $("#priority-field").style.display = kind === "todo" ? "grid" : "none";
  $("#todo-reminder-field").style.display = kind === "todo" ? "grid" : "none";
  $("#subtasks-field").style.display = kind === "todo" ? "grid" : "none";
  $("#mood-field").style.display = kind === "diary" ? "grid" : "none";
  $("#diary-weather-field").style.display = kind === "diary" ? "grid" : "none";
  $("#diary-location-field").style.display = kind === "diary" ? "grid" : "none";
  $("#favorite-field").style.display = kind === "diary" ? "flex" : "none";
  $("#tags-field").style.display = kind === "diary" ? "grid" : "none";
  $("#time-field").style.display = kind === "event" || kind === "todo" || kind === "diary" ? "grid" : "none";
  $("#event-color-field").style.display = kind === "event" ? "grid" : "none";
  $("#event-location-field").style.display = kind === "event" ? "grid" : "none";
  $("#event-reminder-field").style.display = kind === "event" ? "grid" : "none";
  $("#event-all-day-field").style.display = kind === "event" ? "flex" : "none";
  $("#markdown-tools").style.display = kind === "diary" ? "flex" : "none";
  $("#body-field").style.display = "grid";
  $("#markdown-preview").classList.remove("active");
  $("#markdown-preview").innerHTML = "";
  $("#markdown-preview-toggle").textContent = "预览";
  dialog.showModal();
  focusDiaryKeyword(item);
}

function focusDiaryKeyword(item) {
  const keyword = $("#diary-search")?.value.trim();
  if (!keyword || !item?.content_md) return;
  const match = findKeywordMatch(normalizeDiarySystemText(item.content_md), keyword);
  if (!match) return;
  requestAnimationFrame(() => {
    const textarea = $("#entry-body");
    textarea.focus();
    textarea.setSelectionRange(match.index, match.index + match.length);
    const linesBefore = textarea.value.slice(0, match.index).split("\n").length - 1;
    textarea.scrollTop = Math.max(0, linesBefore * 30 - textarea.clientHeight / 3);
  });
}

function getItemDate(kind, item) {
  if (kind === "diary") return item.entry_date;
  if (kind === "todo") return item.due_at ? toDateInput(item.due_at) : state.selectedDate;
  return item.start_at ? toDateInput(item.start_at) : state.selectedDate;
}

function getItemTime(kind, item) {
  if (kind === "todo") return timeInput(item.due_at);
  if (kind === "event") return timeInput(item.start_at);
  return "09:00";
}

function parseSubtasks(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      title: line.replace(/^\[(x|X)\]\s*/, ""),
      is_completed: /^\[(x|X)\]\s*/.test(line),
    }));
}

function renderSubtaskEditor() {
  $("#subtask-editor").innerHTML = state.editingSubtasks.length
    ? `
      <div class="subtasks-list">
        ${state.editingSubtasks.map((subtask, index) => {
          const subtaskButton = subtask.is_completed
            ? `<button class="complete-check-button done" type="button" data-edit-subtask-toggle="${index}" title="标记子任务为未完成">✓</button>`
            : `<button class="complete-check-button" type="button" data-edit-subtask-toggle="${index}" title="标记子任务为已完成"></button>`;
          return `
          <div class="subtask-row ${subtask.is_completed ? "is-completed" : ""}">
            ${subtaskButton}
            <input type="text" value="${escapeHtml(subtask.title)}" data-edit-subtask-title="${index}" />
            <button type="button" data-edit-subtask-delete="${index}">删除</button>
          </div>
        `;
        }).join("")}
      </div>
    `
    : `<p class="eyebrow">还没有子任务。</p>`;
}

function parseTags(value) {
  return value
    .split(/[，,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function markdownToHtml(source) {
  const lines = source.split("\n");
  const html = [];
  let inList = false;
  for (const line of lines) {
    const media = mediaMarkdownToHtml(line.trim());
    if (media) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(media);
      continue;
    }
    const escaped = inlineMarkdown(escapeHtml(line.trim()));
    if (!line.trim()) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      continue;
    }
    if (line.startsWith("## ")) {
      if (inList) { html.push("</ul>"); inList = false; }
      html.push(`<h2>${inlineMarkdown(escapeHtml(line.slice(3).trim()))}</h2>`);
    } else if (line.startsWith("# ")) {
      if (inList) { html.push("</ul>"); inList = false; }
      html.push(`<h1>${inlineMarkdown(escapeHtml(line.slice(2).trim()))}</h1>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(escapeHtml(line.slice(2).trim()))}</li>`);
    } else {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<p>${escaped}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("");
}

function localAttachmentUrl(value) {
  const url = String(value || "").trim();
  return url.startsWith("/attachments/") && !url.includes("..") ? url : "";
}

function mediaMarkdownToHtml(line) {
  const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (image) {
    const url = localAttachmentUrl(image[2]);
    if (!url) return "";
    return `<figure class="markdown-media"><img src="${escapeHtml(url)}" alt="${escapeHtml(image[1])}" loading="lazy" /></figure>`;
  }
  const audio = line.match(/^!?\[audio:([^\]]*)\]\(([^)]+)\)$/);
  if (audio) {
    const url = localAttachmentUrl(audio[2]);
    if (!url) return "";
    const title = audio[1] || "音频";
    return `<figure class="markdown-media"><figcaption>${escapeHtml(title)}</figcaption><audio controls src="${escapeHtml(url)}"></audio></figure>`;
  }
  const file = line.match(/^\[file:([^\]]*)\]\(([^)]+)\)$/);
  if (file) {
    const url = localAttachmentUrl(file[2]);
    if (!url) return "";
    const title = file[1] || "附件";
    return `
      <figure class="markdown-media markdown-file">
        <figcaption>${escapeHtml(title)}</figcaption>
        <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url.split("/").pop() || title)}</a>
      </figure>
    `;
  }
  return "";
}

function inlineMarkdown(value) {
  return value
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[file:([^\]]+)\]\((\/attachments\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\[(.+?)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function insertIntoEntryBody(text) {
  const textarea = $("#entry-body");
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n" : "";
  const insert = `${prefix}${text}${suffix}`;
  textarea.value = `${before}${insert}${after}`;
  textarea.focus();
  const cursor = start + insert.length;
  textarea.setSelectionRange(cursor, cursor);
  if (state.markdownPreview) updateMarkdownPreview();
}

function insertMarkdown(type) {
  const textarea = $("#entry-body");
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);
  const snippets = {
    heading: `# ${selected || "标题"}`,
    bold: `**${selected || "加粗文本"}**`,
    italic: `*${selected || "斜体文本"}*`,
    list: `- ${selected || "列表项"}`,
    link: `[${selected || "链接文本"}](https://example.com)`,
  };
  const insert = snippets[type] || "";
  textarea.value = `${textarea.value.slice(0, start)}${insert}${textarea.value.slice(end)}`;
  textarea.focus();
  textarea.setSelectionRange(start + insert.length, start + insert.length);
  if (state.markdownPreview) updateMarkdownPreview();
}

async function uploadDiaryAttachment(kind, file) {
  if (!file) return;
  if (file.size >= MAX_ATTACHMENT_BYTES) {
    showToast("附件必须小于 100MB");
    return;
  }
  try {
    const formData = new FormData();
    formData.append("file", file);
    const attachment = await api.upload("/attachments", formData);
    const markdown = kind === "image"
      ? `![${file.name}](${attachment.url})`
      : kind === "audio"
        ? `[audio:${file.name}](${attachment.url})`
        : `[file:${file.name}](${attachment.url})`;
    insertIntoEntryBody(markdown);
    showToast(kind === "image" ? "图片已插入" : kind === "audio" ? "音频已插入" : "附件已插入");
  } catch (error) {
    showToast(error.message || "附件上传失败");
  }
}

async function cleanupAttachments() {
  if (!confirm("确认清除没有被任何日记引用的本地图片和音频吗？")) return;
  const result = await api.post("/attachments/cleanup", {});
  await loadAttachments();
  const size = formatFileSize(result.deleted_bytes);
  showToast(`已清除 ${result.deleted_count} 个未使用资源，释放 ${size}`);
}

async function deleteAttachment(url) {
  const item = (state.attachments?.items || []).find((attachment) => attachment.url === url);
  const referenceCount = item?.references?.length || 0;
  const message = referenceCount
    ? `这个附件仍被 ${referenceCount} 处日记引用。确认删除后，日记里的附件链接会失效。继续删除吗？`
    : "确认删除这个附件吗？";
  if (!confirm(message)) return;
  const result = await api.delete("/attachments/delete", { url });
  await loadAttachments();
  showToast(`已删除附件，释放 ${formatFileSize(result.deleted_bytes)}`);
}

function updateMarkdownPreview() {
  $("#markdown-preview").innerHTML = markdownToHtml($("#entry-body").value);
}

function toggleMarkdownPreview() {
  state.markdownPreview = !state.markdownPreview;
  $("#body-field").style.display = state.markdownPreview ? "none" : "grid";
  $("#markdown-preview").classList.toggle("active", state.markdownPreview);
  $("#markdown-preview-toggle").textContent = state.markdownPreview ? "编辑" : "预览";
  if (state.markdownPreview) updateMarkdownPreview();
}

async function saveEntry(event) {
  event.preventDefault();
  const kind = $("#entry-kind").value;
  const id = $("#entry-id").value;
  const title = kind === "diary" ? "" : $("#entry-title").value.trim();
  const selectedDate = $("#entry-date").value || state.selectedDate;
  const rawTime = $("#entry-time").value;
  const time = rawTime || "09:00";
  const body = $("#entry-body").value.trim();
  const todoReminder = $("#entry-todo-reminder").value;
  if (!title && !body) return;

  const payloads = {
    diary: {
      entry_date: selectedDate,
      entry_time: rawTime || null,
      title: body.slice(0, 40) || selectedDate,
      content_md: body,
      mood: $("#entry-mood").value,
      weather: $("#entry-weather").value.trim() || null,
      location_name: $("#entry-location").value.trim() || null,
      is_favorite: $("#entry-favorite").checked,
      tag_names: parseTags($("#entry-tags").value),
    },
    todo: {
      title,
      description: body,
      project_id: $("#entry-project").value || null,
      priority: $("#entry-priority").value,
      due_at: dateTime(selectedDate, time),
      reminder_minutes: todoReminder === "" ? null : Number(todoReminder),
      subtasks: state.editingSubtasks,
    },
    event: eventPayload(title, body, selectedDate, time),
  };

  const paths = { diary: "diaries", todo: "todos", event: "events" };
  if (id) {
    await api.patch(`/${paths[kind]}/${id}`, payloads[kind]);
  } else {
    await api.post(`/${paths[kind]}`, payloads[kind]);
  }
  if (kind === "diary") {
    await loadTags();
    await loadDiaryDateFilters();
  }
  $("#entry-dialog").close();
  await render();
}

async function addQuickTodo() {
  const titleInput = $("#quick-todo-title");
  const title = titleInput.value.trim();
  if (!title) return;
  const dateValue = $("#quick-todo-date").value;
  await api.post("/todos", {
    title,
    priority: $("#quick-todo-priority").value,
    due_at: dateValue ? dateTime(dateValue, "09:00") : null,
    project_id: state.todoFilter.project_id || null,
    ...(state.todoFilter.priority === "high" ? { priority: "high" } : {}),
  });
  titleInput.value = "";
  $("#quick-todo-date").value = "";
  await renderTodos();
  showToast("任务已添加");
}

function addEditingSubtask() {
  const input = $("#new-subtask-title");
  const title = input.value.trim();
  if (!title) return;
  state.editingSubtasks.push({ title, is_completed: false });
  input.value = "";
  renderSubtaskEditor();
}

function eventPayload(title, description, selectedDate, time) {
  const allDay = $("#entry-event-all-day").checked;
  const start = new Date(dateTime(selectedDate, allDay ? "00:00" : time));
  const end = new Date(start);
  if (allDay) {
    end.setHours(23, 59, 0, 0);
  } else {
    end.setHours(start.getHours() + 1);
  }
  const reminder = $("#entry-event-reminder").value;
  return {
    title,
    description,
    start_at: start.toISOString().slice(0, 19),
    end_at: end.toISOString().slice(0, 19),
    all_day: allDay,
    color: $("#entry-event-color").value || "#4dabf7",
    location_name: $("#entry-event-location").value.trim(),
    reminder_minutes: reminder === "" ? null : Number(reminder),
  };
}

function showToast(message, actionLabel, action) {
  const region = $("#toast-region");
  region.innerHTML = `
    <div class="toast">
      <span>${escapeHtml(message)}</span>
      ${action ? `<button type="button">${escapeHtml(actionLabel || "撤销")}</button>` : ""}
    </div>
  `;
  const button = region.querySelector("button");
  if (button && action) {
    button.addEventListener("click", async () => {
      clearTimeout(state.toastTimer);
      region.innerHTML = "";
      await action();
    });
  }
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    region.innerHTML = "";
  }, 5000);
}

async function editItem(kind, id) {
  const paths = { diary: "diaries", todo: "todos", event: "events" };
  const item = await api.get(`/${paths[kind]}/${id}`);
  await openDialog(kind, item);
}

async function bulkTodo(operation, updates = {}) {
  const ids = [...state.selectedTodoIds];
  if (!ids.length) return;
  if (operation === "delete" && !confirm(`确认删除 ${ids.length} 个任务？`)) return;
  await api.patch("/todos/bulk", { ids, operation, updates });
  state.selectedTodoIds.clear();
  await renderTodos();
  showToast("批量操作已完成");
}

async function reorderTodosFromDom() {
  const orderedIds = $all("#todo-list [data-kind='todo']").map((card) => card.dataset.id);
  if (!orderedIds.length) return;
  await api.post("/todos/reorder", { ordered_ids: orderedIds });
  $("#todo-sort").value = "custom";
  await renderTodos();
  showToast("排序已保存");
}

async function applyDropUpdate(id, rawUpdate) {
  if (!id || !rawUpdate) return;
  const updates = JSON.parse(rawUpdate);
  await api.patch(`/todos/${id}`, updates);
  await renderTodos();
  showToast("任务已移动");
}

function selectedTodosForExport() {
  return state.currentTodos.filter((todo) => state.selectedTodoIds.has(todo.id));
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildTodoExport(todos, format) {
  if (format === "json") {
    return {
      content: JSON.stringify(todos, null, 2),
      filename: "flux-selected-todos.json",
      mime: "application/json",
    };
  }
  if (format === "csv") {
    const fields = ["id", "title", "status", "priority", "due_at", "tag_name"];
    const rows = todos.map((todo) => fields.map((field) => csvValue(field === "tag_name" ? todo.project_name : todo[field])).join(","));
    return {
      content: `${fields.join(",")}\n${rows.join("\n")}\n`,
      filename: "flux-selected-todos.csv",
      mime: "text/csv",
    };
  }
  const lines = ["# Flux Todo Export", ""];
  todos.forEach((todo) => {
    const marker = todo.status === "completed" ? "x" : " ";
    const due = todo.due_at ? ` @ ${todo.due_at}` : "";
    const tag = todo.project_name ? ` #${todo.project_name}` : "";
    lines.push(`- [${marker}] ${todo.title}${due}${tag}`);
    (todo.subtasks || []).forEach((subtask) => {
      lines.push(`  - [${subtask.is_completed ? "x" : " "}] ${subtask.title}`);
    });
  });
  return {
    content: `${lines.join("\n")}\n`,
    filename: "flux-selected-todos.md",
    mime: "text/markdown",
  };
}

function buildDiaryExport(diaries, format) {
  if (format === "json") {
    return {
      content: JSON.stringify(diaries, null, 2),
      filename: "flux-selected-diaries.json",
      mime: "application/json",
    };
  }
  if (format === "csv") {
    const fields = ["id", "entry_date", "entry_time", "mood", "weather", "location_name", "is_favorite", "word_count", "tags", "content_md", "created_at", "updated_at"];
    const rows = diaries.map((diary) => fields.map((field) => {
      if (field === "tags") return csvValue((diary.tags || []).map((tag) => tag.name).join(", "));
      return csvValue(diary[field]);
    }).join(","));
    return {
      content: `${fields.join(",")}\n${rows.join("\n")}\n`,
      filename: "flux-selected-diaries.csv",
      mime: "text/csv",
    };
  }
  const lines = ["# Flux Diary Export", ""];
  diaries.forEach((diary) => {
    const heading = `${diary.entry_date || "未命名日期"}${diary.entry_time ? ` ${diary.entry_time}` : ""}`;
    const meta = [];
    if (diary.mood) meta.push(`心情：${diary.mood}`);
    if (diary.weather) meta.push(`天气：${diary.weather}`);
    if (diary.location_name) meta.push(`位置：${diary.location_name}`);
    if (diary.is_favorite) meta.push("收藏");
    const tags = (diary.tags || []).map((tag) => tag.name).join(", ");
    if (tags) meta.push(`标签：${tags}`);
    lines.push(`## ${heading}`);
    if (meta.length) {
      lines.push("");
      lines.push(`> ${meta.join(" | ")}`);
    }
    lines.push("");
    lines.push(diary.content_md || "");
    lines.push("");
  });
  return {
    content: `${lines.join("\n").trimEnd()}\n`,
    filename: "flux-selected-diaries.md",
    mime: "text/markdown",
  };
}

async function exportTodos(format) {
  let payload;
  if (state.todoSelectionMode) {
    const todos = selectedTodosForExport();
    if (!todos.length) {
      showToast("请选择要导出的任务");
      return;
    }
    payload = buildTodoExport(todos, format);
  } else {
    payload = await api.get(`/todos/export?format=${format}`);
  }
  downloadExport(payload);
  showToast("Todo 已导出");
}

async function exportDiaries(format) {
  let payload;
  if (state.diarySelectionMode) {
    const diaries = selectedDiariesForExport();
    if (!diaries.length) {
      showToast("请选择要导出的日记");
      return;
    }
    payload = buildDiaryExport(diaries, format);
  } else {
    const params = diaryQueryParams();
    params.set("format", format);
    payload = await api.get(`/diaries/export?${params}`);
  }
  downloadExport(payload);
  showToast("日记已导出");
}

function downloadExport(payload) {
  const blob = new Blob([payload.content], { type: `${payload.mime};charset=utf-8` });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = payload.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function showTodoContextMenu(event, id) {
  event.preventDefault();
  const menu = $("#todo-context-menu");
  menu.dataset.todoId = id;
  menu.innerHTML = `
    <button data-context-action="complete">完成/重开</button>
    <button data-context-action="important">切换高优先级</button>
    <button data-context-action="today">设为今天</button>
    <button data-context-action="tomorrow">设为明天</button>
    <button data-context-action="edit">编辑</button>
    <button data-context-action="delete">删除</button>
  `;
  const left = Math.min(event.clientX, window.innerWidth - 200);
  const top = Math.min(event.clientY, window.innerHeight - 260);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.hidden = false;
}

function hideTodoContextMenu() {
  $("#todo-context-menu").hidden = true;
}

async function runTodoContextAction(action, id) {
  const item = await api.get(`/todos/${id}`);
  if (action === "complete") {
    await api.post(`/todos/${id}/${item.status === "completed" ? "reopen" : "complete"}`);
  }
  if (action === "important") {
    await api.patch(`/todos/${id}`, { priority: item.priority === "high" ? "normal" : "high" });
  }
  if (action === "today" || action === "tomorrow") {
    const day = new Date();
    if (action === "tomorrow") day.setDate(day.getDate() + 1);
    await api.patch(`/todos/${id}`, { due_at: dateTime(toDateInput(day), timeInput(item.due_at)) });
  }
  if (action === "edit") await editItem("todo", id);
  if (action === "delete") await api.delete(`/todos/${id}`);
  hideTodoContextMenu();
  await renderTodos();
}

function handleGlobalShortcut(event) {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;
  if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    const kind = ["todo", "diary", "event"].includes(state.view) ? state.view : "todo";
    openDialog(kind);
  }
  if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    const search = state.view === "diary" ? $("#diary-search") : $("#todo-search");
    if (search) search.focus();
  }
  if (event.key.toLowerCase() === "s" && $("#entry-dialog").open) {
    event.preventDefault();
    $("#entry-form").requestSubmit();
  }
  const viewMap = { "1": "calendar", "2": "todo", "3": "diary", "4": "settings" };
  if (viewMap[event.key]) {
    event.preventDefault();
    setView(viewMap[event.key]);
  }
}

function bindCardActions() {
  $all(".todo-drop-target").forEach((target) => {
    target.addEventListener("dragover", (event) => {
      if (!state.draggingTodoId || !target.dataset.dropUpdate) return;
      event.preventDefault();
      target.classList.add("is-drop-ready");
    });
    target.addEventListener("dragleave", () => target.classList.remove("is-drop-ready"));
    target.addEventListener("drop", async (event) => {
      target.classList.remove("is-drop-ready");
      if (!state.draggingTodoId || !target.dataset.dropUpdate) return;
      event.preventDefault();
      await applyDropUpdate(state.draggingTodoId, target.dataset.dropUpdate);
      state.draggingTodoId = null;
    });
  });
  $all("[data-select-todo]").forEach((checkbox) => {
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selectedTodoIds.add(checkbox.dataset.selectTodo);
      } else {
        state.selectedTodoIds.delete(checkbox.dataset.selectTodo);
      }
      updateBatchBar();
    });
  });
  $all("[data-restore-todo]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await api.post(`/todos/${button.dataset.restoreTodo}/restore`);
      await renderTodos();
      showToast("任务已恢复");
    });
  });
  $all("[data-restore-diary]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const result = await api.post(`/diaries/${button.dataset.restoreDiary}/restore`);
      await loadTags();
      await loadDiaryDateFilters();
      await render();
      showToast(result.restore_mode === "merged" ? "日记已合并到当天原日记" : "日记已恢复");
    });
  });
  $all("[data-restore-event]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await api.post(`/events/${button.dataset.restoreEvent}/restore`);
      await render();
      showToast("事件已恢复");
    });
  });
  $all("[data-card-tag-filter]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.diaryFilter = { tag_id: button.dataset.cardTagFilter };
      state.diarySelectionMode = false;
      state.selectedDiaryIds.clear();
      setDiaryFilterTab("all");
      renderTagFilters();
      setView("diary");
    });
  });
  $all("[data-open-todo]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openTodoDetail(button.dataset.openTodo);
    });
  });
  $all("[data-kind='todo']").forEach((card) => {
    if (state.todoTrashMode) return;
    card.addEventListener("contextmenu", (event) => showTodoContextMenu(event, card.dataset.id));
    card.addEventListener("dragstart", (event) => {
      state.draggingTodoId = card.dataset.id;
      card.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.dataset.id);
    });
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      const dragging = document.querySelector(`[data-id="${state.draggingTodoId}"]`);
      if (!dragging || dragging === card) return;
      const rect = card.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      card.parentElement.insertBefore(dragging, after ? card.nextSibling : card);
    });
    card.addEventListener("dragend", async () => {
      card.classList.remove("is-dragging");
      state.draggingTodoId = null;
      await reorderTodosFromDom();
    });
    card.addEventListener("touchstart", (event) => {
      const touch = event.changedTouches[0];
      state.touchStart = { id: card.dataset.id, x: touch.clientX, y: touch.clientY };
    }, { passive: true });
    card.addEventListener("touchend", async (event) => {
      if (!state.touchStart || state.touchStart.id !== card.dataset.id) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - state.touchStart.x;
      const dy = Math.abs(touch.clientY - state.touchStart.y);
      state.touchStart = null;
      if (Math.abs(dx) < 80 || dy > 60) return;
      if (dx > 0) {
        await api.post(`/todos/${card.dataset.id}/complete`);
        showToast("已完成");
      } else if (confirm("确认删除这条任务？")) {
        await api.delete(`/todos/${card.dataset.id}`);
        showToast("已删除");
      }
      await renderTodos();
    });
    card.addEventListener("click", (event) => {
      if (event.target.closest("button, input, select, textarea, a")) return;
      openTodoDetail(card.dataset.id);
    });
  });
  $all("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => editItem(button.dataset.edit, button.dataset.id));
  });
  $all("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const path = { diary: "diaries", todo: "todos", event: "events" }[button.dataset.delete];
      const id = button.dataset.id;
      const item = await api.get(`/${path}/${id}`);
      await api.delete(`/${path}/${button.dataset.id}`);
      if (button.dataset.delete === "diary") {
        await loadTags();
        await loadDiaryDateFilters();
      }
      await render();
      showToast("已删除", "撤销", async () => {
        await api.post(`/${path}/${item.id}/restore`);
        if (button.dataset.delete === "diary") {
          await loadTags();
          await loadDiaryDateFilters();
        }
        await render();
        showToast("已恢复");
      });
    });
  });
  $all("[data-toggle-complete-todo]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const action = button.dataset.status === "completed" ? "reopen" : "complete";
      await api.post(`/todos/${button.dataset.toggleCompleteTodo}/${action}`);
      await render();
      showToast(action === "complete" ? "已完成" : "已重新打开");
    });
  });
  $all("[data-toggle-subtask]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const nextCompleted = button.dataset.completed !== "true";
      await api.patch(`/subtasks/${button.dataset.toggleSubtask}`, { is_completed: nextCompleted });
      await render();
      showToast(nextCompleted ? "子任务已完成" : "子任务已重新打开");
    });
  });
  $all("[data-subtask-toggle]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      await api.patch(`/subtasks/${checkbox.dataset.subtaskToggle}`, { is_completed: checkbox.checked });
      await render();
    });
  });
  $all("[data-subtask-title]").forEach((input) => {
    input.addEventListener("change", async () => {
      const title = input.value.trim();
      if (!title) return;
      await api.patch(`/subtasks/${input.dataset.subtaskTitle}`, { title });
      await render();
    });
  });
  $all("[data-subtask-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.delete(`/subtasks/${button.dataset.subtaskDelete}`);
      await render();
      showToast("子任务已删除");
    });
  });
}

function bindEvents() {
  $all(".rail-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#today-button").addEventListener("click", () => {
    state.selectedDate = toDateInput(new Date());
    state.visibleMonth = new Date();
    setView("calendar");
  });
  $("#quick-add-button").addEventListener("click", () => {
    const kind = ["diary", "todo", "event"].includes(state.view) ? state.view : "todo";
    openDialog(state.view === "calendar" ? "todo" : kind);
  });
  $("#prev-month").addEventListener("click", () => {
    navigateCalendar(-1);
    renderCalendar();
  });
  $("#next-month").addEventListener("click", () => {
    navigateCalendar(1);
    renderCalendar();
  });
  $all("[data-calendar-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.calendarView = button.dataset.calendarView;
      state.visibleMonth = state.calendarView === "quarter" ? quarterStart(state.selectedDate) : new Date(`${state.selectedDate}T00:00:00`);
      renderCalendar();
    });
  });
  $all("[data-calendar-layer]").forEach((button) => {
    button.addEventListener("click", () => {
      const layer = button.dataset.calendarLayer;
      state.calendarLayers[layer] = !state.calendarLayers[layer];
      if (layer === "holiday" && !state.calendarLayers.holiday) state.holidayMarkMode = false;
      syncCalendarLayerButtons();
      renderCalendar();
    });
  });
  $all("[data-holiday-mode]").forEach((holidayModeButton) => {
    holidayModeButton.addEventListener("click", () => {
      state.holidayMarkMode = !state.holidayMarkMode;
      if (state.holidayMarkMode) state.calendarLayers.holiday = true;
      syncCalendarLayerButtons();
      renderCalendar();
      showToast(state.holidayMarkMode ? "已进入节假日标记模式" : "已退出节假日标记模式");
    });
  });
  bindCreateButtons();
  $("#dialog-close").addEventListener("click", () => $("#entry-dialog").close());
  $("#dialog-cancel").addEventListener("click", () => $("#entry-dialog").close());
  $("#entry-form").addEventListener("submit", saveEntry);
  $("#theme-select").addEventListener("change", () => {
    state.theme = $("#theme-select").value;
    localStorage.setItem("flux-theme", state.theme);
    applyTheme();
    showToast("主题已更新");
  });
  $("#refresh-attachments-button").addEventListener("click", async () => {
    await loadAttachments();
    showToast("附件列表已刷新");
  });
  $("#cleanup-attachments-button").addEventListener("click", cleanupAttachments);
  $all("[data-attachment-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      state.attachmentKindFilter = button.dataset.attachmentKind || "";
      renderAttachmentPanel();
    });
  });
  systemTheme.addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });
  $all("[data-md]").forEach((button) => {
    button.addEventListener("click", () => insertMarkdown(button.dataset.md));
  });
  $all("[data-attachment]").forEach((button) => {
    button.addEventListener("click", () => {
      const inputs = {
        image: $("#diary-image-input"),
        audio: $("#diary-audio-input"),
        file: $("#diary-file-input"),
      };
      const input = inputs[button.dataset.attachment];
      if (!input) return;
      input.click();
    });
  });
  $("#diary-image-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    await uploadDiaryAttachment("image", file);
    event.target.value = "";
  });
  $("#diary-audio-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    await uploadDiaryAttachment("audio", file);
    event.target.value = "";
  });
  $("#diary-file-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    await uploadDiaryAttachment("file", file);
    event.target.value = "";
  });
  $("#markdown-preview-toggle").addEventListener("click", toggleMarkdownPreview);
  $("#entry-body").addEventListener("input", () => {
    if (state.markdownPreview) updateMarkdownPreview();
  });
  document.addEventListener("keydown", handleGlobalShortcut);
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#todo-context-menu")) hideTodoContextMenu();
  });
  $("#todo-search").addEventListener("input", () => renderTodos());
  $("#diary-search").addEventListener("input", async () => {
    if (state.diarySelectionMode) {
      state.diarySelectionMode = false;
      state.selectedDiaryIds.clear();
    }
    await renderDiaries();
  });
  $("#diary-export-toggle").addEventListener("click", async () => {
    state.diarySelectionMode = !state.diarySelectionMode;
    if (state.diarySelectionMode) {
      state.selectedDiaryIds = new Set(state.currentDiaries.map((diary) => diary.id));
    } else {
      state.selectedDiaryIds.clear();
    }
    await renderDiaries();
  });
  $("#diary-batch-bar").addEventListener("click", async (event) => {
    const allButton = event.target.closest("[data-select-all-diaries]");
    const invertButton = event.target.closest("[data-invert-diary-selection]");
    const clearButton = event.target.closest("[data-clear-diary-selection]");
    const cancelButton = event.target.closest("[data-cancel-diary-export]");
    const exportButton = event.target.closest("[data-export-diaries]");
    if (allButton) {
      state.currentDiaries.forEach((diary) => state.selectedDiaryIds.add(diary.id));
      renderDiaries();
    }
    if (invertButton) {
      state.currentDiaries.forEach((diary) => {
        if (state.selectedDiaryIds.has(diary.id)) state.selectedDiaryIds.delete(diary.id);
        else state.selectedDiaryIds.add(diary.id);
      });
      renderDiaries();
    }
    if (clearButton) {
      state.selectedDiaryIds.clear();
      renderDiaries();
    }
    if (cancelButton) {
      state.diarySelectionMode = false;
      state.selectedDiaryIds.clear();
      renderDiaries();
    }
    if (exportButton) {
      await exportDiaries(exportButton.dataset.exportDiaries);
    }
  });
  $("#diary-list").addEventListener("change", (event) => {
    const input = event.target.closest("[data-select-diary]");
    if (!input) return;
    if (input.checked) state.selectedDiaryIds.add(input.dataset.selectDiary);
    else state.selectedDiaryIds.delete(input.dataset.selectDiary);
    updateDiaryBatchBar();
  });

  $all("[data-todo-filter], [data-todo-priority], [data-todo-due], [data-todo-smart], [data-todo-trash]").forEach((button) => {
    button.addEventListener("click", () => {
      $all("[data-todo-filter], [data-todo-priority], [data-todo-due], [data-todo-smart], [data-todo-trash], [data-project-filter]").forEach((x) => x.classList.remove("active"));
      button.classList.add("active");
      state.todoFilter = {};
      state.todoTrashMode = button.dataset.todoTrash === "true";
      if (state.todoTrashMode) {
        state.todoSelectionMode = false;
        state.selectedTodoIds.clear();
      }
      if (button.dataset.todoFilter !== undefined && button.dataset.todoFilter !== "") state.todoFilter.status = button.dataset.todoFilter;
      if (button.dataset.todoPriority) state.todoFilter.priority = button.dataset.todoPriority;
      if (button.dataset.todoDue) state.todoFilter.due_preset = button.dataset.todoDue;
      if (button.dataset.todoSmart === "important") state.todoFilter.priority = "high";
      renderTodos();
    });
  });
  $("#todo-sort").addEventListener("change", renderTodos);
  $("#todo-group").addEventListener("change", () => {
    state.todoGroup = $("#todo-group").value;
    renderTodos();
  });

  $("#todo-export-toggle").addEventListener("click", () => {
    if (state.todoTrashMode) return;
    state.todoSelectionMode = !state.todoSelectionMode;
    if (!state.todoSelectionMode) state.selectedTodoIds.clear();
    renderTodos();
  });

  $("#todo-batch-bar").addEventListener("click", async (event) => {
    const allButton = event.target.closest("[data-select-all-todos]");
    const invertButton = event.target.closest("[data-invert-todo-selection]");
    const clearButton = event.target.closest("[data-clear-todo-selection]");
    const exportButton = event.target.closest("[data-export-selected]");
    const bulkButton = event.target.closest("[data-bulk-todo]");
    if (allButton) {
      state.currentTodos.forEach((todo) => state.selectedTodoIds.add(todo.id));
      updateBatchBar();
    }
    if (invertButton) {
      state.currentTodos.forEach((todo) => {
        if (state.selectedTodoIds.has(todo.id)) state.selectedTodoIds.delete(todo.id);
        else state.selectedTodoIds.add(todo.id);
      });
      updateBatchBar();
    }
    if (clearButton) {
      state.selectedTodoIds.clear();
      updateBatchBar();
    }
    if (exportButton) {
      await exportTodos(exportButton.dataset.exportSelected);
    }
    if (bulkButton) {
      const action = bulkButton.dataset.bulkTodo;
      if (action === "important") await bulkTodo("", { priority: "high" });
      else if (action === "normal_priority") await bulkTodo("", { priority: "normal" });
      else await bulkTodo(action);
    }
  });

  $("#todo-context-menu").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-context-action]");
    if (!button) return;
    await runTodoContextAction(button.dataset.contextAction, $("#todo-context-menu").dataset.todoId);
  });

  $("#quick-todo-add").addEventListener("click", addQuickTodo);
  $("#quick-todo-title").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addQuickTodo();
  });

  $("#todo-detail-panel").addEventListener("click", async (event) => {
    const saveButton = event.target.closest("[data-detail-save]");
    const editButton = event.target.closest("[data-detail-edit]");
    if (saveButton) await saveTodoDetail(saveButton.dataset.detailSave);
    if (editButton) await editItem("todo", editButton.dataset.detailEdit);
  });

  $("#project-filter-list").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.projectFilter) {
      $all("[data-todo-filter], [data-todo-priority], [data-todo-due], [data-todo-smart], [data-todo-trash], [data-project-filter]").forEach((x) => x.classList.remove("active"));
      button.classList.add("active");
      state.todoTrashMode = false;
      state.todoFilter = { project_id: button.dataset.projectFilter };
      renderTodos();
    }
    if (button.dataset.deleteProject) {
      if (!confirm("删除标签后，该标签下的任务会变为无标签。确认删除？")) return;
      await api.delete(`/todo-projects/${button.dataset.deleteProject}`);
      await loadProjects();
      state.todoFilter = {};
      renderTodos();
    }
  });

  $("#project-filter-list").addEventListener("dblclick", async (event) => {
    const button = event.target.closest("[data-project-filter]");
    if (!button) return;
    const project = state.projects.find((item) => item.id === button.dataset.projectFilter);
    const name = prompt("标签名称", project?.name || "");
    if (!name?.trim()) return;
    await api.patch(`/todo-projects/${project.id}`, { name: name.trim(), color: project.color });
    await loadProjects();
    await renderTodos();
  });

  $("#project-filter-list").addEventListener("change", async (event) => {
    const input = event.target.closest("[data-project-color]");
    if (!input) return;
    const project = state.projects.find((item) => item.id === input.dataset.projectColor);
    await api.patch(`/todo-projects/${project.id}`, { name: project.name, color: input.value });
    await loadProjects();
    await renderTodos();
  });

  $("#create-project-button").addEventListener("click", async () => {
    const input = $("#new-project-name");
    const name = input.value.trim();
    if (!name) return;
    await api.post("/todo-projects", { name });
    input.value = "";
    await loadProjects();
    renderTodos();
  });

  $("#add-subtask-button").addEventListener("click", addEditingSubtask);
  $("#new-subtask-title").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addEditingSubtask();
    }
  });
  $("#subtask-editor").addEventListener("change", (event) => {
    const title = event.target.closest("[data-edit-subtask-title]");
    if (title) state.editingSubtasks[Number(title.dataset.editSubtaskTitle)].title = title.value.trim();
  });
  $("#subtask-editor").addEventListener("click", (event) => {
    const completeButton = event.target.closest("[data-edit-subtask-toggle]");
    const deleteButton = event.target.closest("[data-edit-subtask-delete]");
    if (completeButton) {
      const index = Number(completeButton.dataset.editSubtaskToggle);
      state.editingSubtasks[index].is_completed = !state.editingSubtasks[index].is_completed;
      renderSubtaskEditor();
      return;
    }
    if (!deleteButton) return;
    state.editingSubtasks.splice(Number(deleteButton.dataset.editSubtaskDelete), 1);
    renderSubtaskEditor();
  });

  $("#diary-view .side-list").addEventListener("click", (event) => {
    const tabButton = event.target.closest("[data-diary-tab]");
    if (tabButton) {
      if (tabButton.dataset.diaryTab === "all" || tabButton.dataset.diaryTab === "trash") {
        applyDiaryFilter(tabButton);
      } else {
        setDiaryFilterTab(tabButton.dataset.diaryTab);
      }
      return;
    }
    const button = event.target.closest(".diary-filter-control");
    if (!button) return;
    applyDiaryFilter(button);
  });
}

bootstrap();
