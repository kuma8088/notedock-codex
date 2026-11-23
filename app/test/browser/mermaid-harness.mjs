// リンクを書いた Mermaid の図を描く試験用のページ。test/browser/mermaid-link-check.py が組み立てて使う。
import { MermaidWidget } from '../../src/widgets.mjs'

const sources = {
  flowHref: 'flowchart LR\n  A[リンクつきの箱] --> B[ふつうの箱]\n  click A href "https://probe.example.com/flow" _self',
  // 同じ図のリンクなし。箱の位置と大きさが、リンクを取り除いたあとも同じかを比べる。
  flowPlain: 'flowchart LR\n  A[リンクつきの箱] --> B[ふつうの箱]',
  flowShort: 'flowchart LR\n  C[短い書き方の箱] --> D[ふつうの箱]\n  click C "https://probe.example.com/short" "説明"',
  classLink: 'classDiagram\n  class Animal\n  link Animal "https://probe.example.com/class" "説明"',
  jsUrl: 'flowchart LR\n  E[スクリプトの箱]\n  click E href "javascript:alert(1)"',
  seqLink: 'sequenceDiagram\n  participant Alice\n  link Alice: 説明 @ https://probe.example.com/seq\n  Alice->>Alice: こんにちは',
  stateClick: 'stateDiagram-v2\n  [*] --> S1\n  click S1 href "https://probe.example.com/state"',
  // ノートを開いただけで外へ読み込みに行く2つの書き方。
  imgNode: 'flowchart LR\n  P@{ img: "https://probe.example.com/img.png", label: "画像つきの箱", pos: "t", w: 60, h: 60 }',
  themeCss: '%%{init: {"themeCSS": ".node rect { fill: url(https://probe.example.com/theme.png) }"}}%%\nflowchart LR\n  Q[色を変えた箱]',
  // ELK の配置。worker を使わずに、通信の制限の下でも描けるか。
  elk: '---\nconfig:\n  layout: elk\n---\nflowchart LR\n  X[ELKの箱] --> Y[次の箱]',
  kanban: '---\nconfig:\n  kanban:\n    ticketBaseUrl: "https://probe.example.com/ticket/#TICKET#"\n---\nkanban\n  todo[やること]\n    t1[作業]@{ ticket: T-1 }',
}
const view = { requestMeasure() {} }
for (const [name, source] of Object.entries(sources)) {
  const node = new MermaidWidget(source).toDOM(view)
  node.dataset.name = name
  document.getElementById('out').append(node)
}
window.ready = true
