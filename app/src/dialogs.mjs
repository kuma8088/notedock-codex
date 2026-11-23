import { childFolders, searchFolders } from './files.mjs'

// ブラウザパネルでは標準の入力ダイアログが使えない場合があるので、自前の小さな画面で聞く。

function open(build) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'note-ask'
    const finish = (value) => {
      dialog.close()
      dialog.remove()
      resolve(value)
    }
    build(dialog, finish)
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      finish(null)
    })
    document.body.append(dialog)
    dialog.showModal()
  })
}

function button(label, run, primary = false) {
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = label
  if (primary) node.className = 'primary'
  node.addEventListener('click', run)
  return node
}

function actions(...buttons) {
  const box = document.createElement('div')
  box.className = 'dialog-actions'
  box.append(...buttons)
  return box
}

export function askText(message, initial = '') {
  return open((dialog, finish) => {
    const label = document.createElement('p')
    label.textContent = message
    const input = document.createElement('input')
    input.type = 'text'
    input.value = initial
    setTimeout(() => {
      input.focus()
      input.select()
    }, 0)
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        finish(input.value)
      }
    })
    dialog.append(label, input, actions(button('やめる', () => finish(null)), button('決定', () => finish(input.value), true)))
  })
}

export function askConfirm(message, yes = 'はい') {
  return open((dialog, finish) => {
    const label = document.createElement('p')
    label.textContent = message
    dialog.append(label, actions(button('やめる', () => finish(false)), button(yes, () => finish(true), true)))
  }).then(Boolean)
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// 場所選び。今いる場所のパンくず、1つ下のフォルダー、名前で探す欄、最近の場所を出す。
// 新しいノートの画面と、ファイル欄の「移動」で使う。value() で選んだフォルダー（'' は一番上）を返す。
export function placePicker({ folders, selected, topLabel, recent = [], onChange = () => {} }) {
  let current = folders.includes(selected) ? selected : ''
  const box = el('div', 'place-picker')
  const search = el('input', 'place-search')
  search.type = 'search'
  search.autocomplete = 'off'
  search.placeholder = 'フォルダーの名前で探す'
  search.setAttribute('aria-label', 'フォルダーの名前で探す')
  const crumbs = el('div', 'place-crumbs')
  const recentBox = el('div', 'place-recent')
  const list = el('ul', 'place-list')
  list.setAttribute('role', 'list')
  const label = (folder) => (folder ? folder.split('/').pop() : topLabel)
  const go = (folder) => {
    current = folder
    search.value = ''
    render()
    onChange(current)
  }
  const folderButton = (folder, text, className) => {
    const item = el('button', className, text)
    item.type = 'button'
    item.title = folder ? `${folder}/` : `${topLabel}（一番上）`
    item.addEventListener('click', () => go(folder))
    return item
  }
  const render = () => {
    const parts = current ? current.split('/') : []
    const trail = [folderButton('', topLabel, 'place-crumb')]
    parts.forEach((part, index) => {
      trail.push(el('span', 'place-sep', '›'))
      trail.push(folderButton(parts.slice(0, index + 1).join('/'), part, 'place-crumb'))
    })
    crumbs.replaceChildren(...trail)
    const shownRecent = recent.filter((dir) => folders.includes(dir) && dir !== current)
    recentBox.hidden = shownRecent.length === 0 || search.value.trim() !== ''
    recentBox.replaceChildren(el('span', 'place-recent-label', '最近：'), ...shownRecent.map((dir) => folderButton(dir, dir ? `${dir}/` : `${topLabel}（一番上）`, 'place-chip')))
    const query = search.value
    const rows = query.trim()
      ? searchFolders(folders, query).map((folder) => folderButton(folder, `${folder}/`, 'place-row'))
      : childFolders(folders, current).map((folder) => folderButton(folder, `${label(folder)} ›`, 'place-row'))
    if (rows.length === 0) {
      const empty = el('li', 'place-empty', query.trim() ? 'その名前のフォルダーはありません' : 'この下にフォルダーはありません')
      list.replaceChildren(empty)
      return
    }
    list.replaceChildren(...rows.map((row) => {
      const item = el('li')
      item.append(row)
      return item
    }))
  }
  search.addEventListener('input', render)
  search.addEventListener('keydown', (event) => {
    event.stopPropagation()
    // Enterでは作らない。探した結果の最初のフォルダーへ進むだけ。
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      const first = list.querySelector('.place-row')
      if (first) first.click()
    }
  })
  box.addEventListener('keydown', (event) => event.stopPropagation())
  box.append(crumbs, search, recentBox, list)
  render()
  return { element: box, value: () => current, focusSearch: () => search.focus() }
}

// 新しいノートの名前と場所を聞く。作るノートのパスか、やめたら null を返す。
// check(name, dir) は { path } か { error } を返す。作れないときは画面を閉じずに理由を出す。
export function askNewNote({ folders, selected, topLabel, recent, check }) {
  return open((dialog, finish) => {
    dialog.classList.add('note-ask-wide')
    const title = el('p', 'dialog-title', '新しいノート')
    const nameLabel = el('label', '', '名前')
    const input = el('input')
    input.type = 'text'
    input.autocomplete = 'off'
    nameLabel.append(input)
    const placeTitle = el('p', 'place-title', '場所')
    const target = el('p', 'dialog-target')
    const error = el('p', 'dialog-error')
    error.setAttribute('role', 'alert')
    error.hidden = true
    const showTarget = () => {
      const result = check(input.value.trim() ? input.value : '新しいノート', picker.value())
      target.textContent = result.path ? `作る場所：${result.path}` : `作る場所：${picker.value() ? `${picker.value()}/` : `${topLabel}（一番上）`}`
    }
    const picker = placePicker({
      folders,
      selected,
      topLabel,
      recent,
      onChange: () => {
        error.hidden = true
        showTarget()
      },
    })
    const submit = () => {
      const result = check(input.value, picker.value())
      if (result.path) return finish({ path: result.path, dir: picker.value() })
      error.textContent = result.error
      error.hidden = false
      input.focus()
    }
    // Enterで作るのは名前の欄だけ。日本語入力の変換を確定するEnterでは作らない。
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        submit()
      }
    })
    input.addEventListener('input', () => {
      error.hidden = true
      showTarget()
    })
    dialog.append(title, nameLabel, placeTitle, picker.element, target, error, actions(button('やめる', () => finish(null)), button('作る', submit, true)))
    showTarget()
    setTimeout(() => input.focus(), 0)
  })
}

// いくつかの選び方から1つを選んでもらう。options は { label, value, primary } の並び。やめたら null。
// details は、件数やノートの名前など、判断に要る情報の行。
export function askChoice(message, options, details = []) {
  return open((dialog, finish) => {
    const label = el('p', '', message)
    const list = el('ul', 'dialog-details')
    for (const line of details) list.append(el('li', '', line))
    const buttons = options.map((option) => button(option.label, () => finish(option.value), option.primary))
    dialog.append(label)
    if (details.length) dialog.append(list)
    dialog.append(actions(button('やめる', () => finish(null)), ...buttons))
  })
}

// 保存されていない入力を反映するか聞く。'apply' か 'discard'。選ぶまで閉じない（閉じたあとに打つと、残っていた入力が上書きされるため）。
export function askDraft(message, { onLook }) {
  return open((dialog, finish) => {
    let done = false
    const pick = (value) => {
      done = true
      finish(value)
    }
    // Escでは閉じない。ブラウザによっては一度だけEscで閉じてしまうので、閉じられたら出し直す。
    dialog.setAttribute('closedby', 'none')
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    })
    dialog.addEventListener('close', () => {
      if (!done && dialog.isConnected) dialog.showModal()
    })
    dialog.append(
      el('p', '', message),
      actions(button('内容を見る', () => onLook()), button('反映しない', () => pick('discard')), button('反映する', () => pick('apply'), true)),
    )
  })
}

// 場所だけを選んでもらう（ファイル欄の「移動」）。選んだフォルダー（'' は一番上）か、やめたら null。
export function askPlace({ title, folders, selected, topLabel, recent, describe, confirmLabel = 'ここへ動かす' }) {
  return open((dialog, finish) => {
    dialog.classList.add('note-ask-wide')
    const heading = el('p', 'dialog-title', title)
    const target = el('p', 'dialog-target')
    const picker = placePicker({ folders, selected, topLabel, recent, onChange: (dir) => { target.textContent = describe(dir) } })
    target.textContent = describe(picker.value())
    dialog.append(heading, picker.element, target, actions(button('やめる', () => finish(null)), button(confirmLabel, () => finish(picker.value()), true)))
    setTimeout(() => picker.focusSearch(), 0)
  })
}

const TEMPLATE_KINDS = [
  ['daily', '日のノート'],
  ['weekly', '週のノート'],
  ['monthly', '月のノート'],
  ['quarterly', '四半期のノート'],
  ['yearly', '年のノート'],
]

// フォルダーごとの設定（画像と日付ごとのノートの置き場、ひな形）。保存した設定か、やめたら null を返す。
// current は GET /api/settings の答え。pickFolder(title, selected) は選んだフォルダー（'' は一番上）か null。
// save(value) は { ok: true, data } か { ok: false, message }。保存できないときは画面を閉じずに理由を出す。
export function askSettings({ current, notes, topLabel, pickFolder, save }) {
  return open((dialog, finish) => {
    dialog.classList.add('note-ask-wide', 'settings-ask')
    let attachmentDir = current.attachmentDir
    let periodicRoot = current.periodic?.root ?? null
    const templates = { ...(current.periodic?.templates ?? {}) }
    const title = el('p', 'dialog-title', '設定')
    const scope = el('p', 'dialog-note', `ここで決めたことは、今のフォルダー（${topLabel}）だけに使われます。`)
    const error = el('p', 'dialog-error')
    error.setAttribute('role', 'alert')
    const showError = (message) => {
      error.textContent = message
      error.hidden = !message
    }
    showError(current.errors?.length ? `今の設定に、使えないところがあります：${current.errors.join('。')}` : '')

    const row = (label) => {
      const box = el('div', 'settings-row')
      const value = el('p', 'settings-value')
      const buttons = el('div', 'settings-buttons')
      box.append(el('p', 'settings-label', label), value, buttons)
      return { box, value, buttons }
    }
    const choose = async (heading, selected, apply) => {
      const dir = await pickFolder(heading, selected ?? '')
      if (dir === null) return
      if (dir === '') return showError('一番上のフォルダーは選べません。その下のフォルダーを選んでください。')
      showError('')
      apply(dir)
      render()
    }

    const images = row('画像の置き場（貼ったり選んだりした画像を入れるフォルダー）')
    const periodic = row('日付ごとのノートの置き場（「今日のノート」とカレンダーで作るノート）')
    const templateBox = el('div', 'settings-templates')
    const listId = `settings-notes-${Date.now()}`
    const datalist = el('datalist')
    datalist.id = listId
    for (const note of notes) {
      const option = el('option')
      option.value = note
      datalist.append(option)
    }
    const inputs = TEMPLATE_KINDS.map(([kind, label]) => {
      const field = el('label', 'settings-template', label)
      const input = el('input')
      input.type = 'text'
      input.autocomplete = 'off'
      input.placeholder = 'なし（日付と前後のノートへのリンクだけ）'
      input.setAttribute('list', listId)
      input.value = templates[kind] ?? ''
      input.addEventListener('keydown', (event) => event.stopPropagation())
      field.append(input)
      return [kind, input]
    })
    templateBox.append(el('p', 'settings-label', 'ひな形（新しいノートの元にするノート。名前を入れると候補が出ます）'), ...inputs.map(([, input]) => input.parentElement), datalist)

    function render() {
      images.value.textContent = attachmentDir ? `${attachmentDir}/` : `${current.defaultAttachmentDir}/（決めていないときの場所。なければ作ります）`
      images.buttons.replaceChildren(
        button('選ぶ', () => choose('画像を入れるフォルダー', attachmentDir, (dir) => { attachmentDir = dir })),
        ...(attachmentDir ? [button(`${current.defaultAttachmentDir}/ に戻す`, () => { attachmentDir = null; render() })] : []),
      )
      periodic.value.textContent = periodicRoot ? `${periodicRoot}/` : 'まだ決めていない（「今日のノート」とカレンダーは出ません）'
      periodic.buttons.replaceChildren(
        button('選ぶ', () => choose('日付ごとのノートを入れるフォルダー', periodicRoot, (dir) => { periodicRoot = dir })),
        ...(periodicRoot ? [button('使わない', () => { periodicRoot = null; render() })] : []),
      )
      templateBox.hidden = !periodicRoot
    }

    let saving = false
    // 保存の答えを待つ間は閉じない（閉じると、保存できたのかが分からなくなる）。
    dialog.addEventListener('cancel', (event) => {
      if (!saving) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }, { capture: true })
    const cancel = () => {
      if (!saving) finish(null)
    }
    const submit = async () => {
      if (saving) return
      saving = true
      const value = {
        attachmentDir,
        periodic: periodicRoot
          ? { root: periodicRoot, templates: Object.fromEntries(inputs.map(([kind, input]) => [kind, input.value.trim()]).filter(([, path]) => path)) }
          : null,
      }
      const result = await save(value)
      saving = false
      // 保存を待つ間に、ブラウザーが画面を閉じてしまうことがある（Escを続けて押したとき）。
      // そのときは後始末をして、保存できなかったら理由を別の画面で出す。
      if (!dialog.open) {
        finish(result.ok ? result.data : null)
        if (!result.ok) showMessage(result.message)
        return
      }
      if (result.ok) return finish(result.data)
      showError(result.message)
    }
    render()
    dialog.append(title, scope, images.box, periodic.box, templateBox, error, actions(button('やめる', cancel), button('保存', submit, true)))
  })
}

// コピーできなかった文字を選んだ状態で見せ、Cmd+Cで写してもらう。
export function showCopyable(message, text) {
  return open((dialog, finish) => {
    const label = document.createElement('p')
    label.id = 'copyable-label'
    label.textContent = message
    const input = document.createElement('input')
    input.type = 'text'
    input.readOnly = true
    input.setAttribute('aria-labelledby', label.id)
    input.value = text
    input.addEventListener('keydown', (event) => event.stopPropagation())
    dialog.append(label, input, actions(button('閉じる', () => finish(true), true)))
    setTimeout(() => input.select(), 0)
  })
}

export function showMessage(message) {
  return open((dialog, finish) => {
    const label = document.createElement('p')
    label.textContent = message
    dialog.append(label, actions(button('閉じる', () => finish(true), true)))
  })
}
