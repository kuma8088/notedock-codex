// カレンダーの見た目を組み立てる。中身（どの日にノートがあるかなど）は calendar.mjs の calendarModel が決める。
// open(period, date)：日・週・月の見出しを押したとき。go(step)：-1 で前の月、1 で次の月、0 で今月。
// Claude用の NoteDock のカレンダーと同じ並び（Obsidianのカレンダーと同じ並び）。
export function buildCalendar(model, { open, go }) {
  const part = (tag, className, text, extra = {}) => {
    const el = document.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    if (tag === 'button') el.type = 'button'
    Object.assign(el, extra)
    return el
  }
  const act = (el, handler) => {
    el.addEventListener('click', handler)
    return el
  }
  const mark = (el, has) => {
    if (has) el.classList.add('cal-has')
    return el
  }
  const head = part('div', 'cal-head')
  // 左に「2026年11月」、右に前後の月への矢印と「今日」を並べる。
  head.append(
    act(mark(part('button', 'cal-title', model.title, { title: `${model.title}のノートを開く` }), model.hasMonth), () => open('monthly', model.monthDate)),
    act(part('button', '', '‹', { title: '前の月' }), () => go(-1)),
    act(part('button', '', '今日', { title: '今月に戻る' }), () => go(0)),
    act(part('button', '', '›', { title: '次の月' }), () => go(1)),
  )
  const grid = part('div', 'cal-grid')
  grid.append(part('span', 'cal-dow', 'W'))
  // 右の列が狭いときは、曜日を1文字にする（どちらを出すかは style.css が決める）。
  for (const dow of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    const label = part('span', 'cal-dow', undefined, { title: dow })
    label.append(part('span', 'cal-dow-long', dow), part('span', 'cal-dow-short', dow[0]))
    grid.append(label)
  }
  for (const week of model.weeks) {
    grid.append(act(mark(part('button', 'cal-week', week.label, { title: `${week.name}のノートを開く` }), week.hasNote), () => open('weekly', week.date)))
    for (const day of week.days) {
      const button = part('button', '', String(day.day))
      if (!day.inMonth) button.classList.add('cal-out')
      if (day.isToday) button.classList.add('cal-today')
      if (day.isOpen) button.classList.add('cal-open')
      mark(button, day.hasNote)
      if (day.isOpen) button.setAttribute('aria-current', 'date')
      button.title = day.date
      grid.append(act(button, () => open('daily', day.date)))
    }
  }
  return [head, grid]
}
