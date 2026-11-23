import { completionKeymap } from '@codemirror/autocomplete'

// 候補を出すキーから Ctrl+Space を外す。
// Mac では Ctrl+Space が入力ソース（日本語・英字）の切り替えの初期設定で、エディターが押されたキーを使うと
// 切り替えが効かなくなることがあるため。候補は [[ や ]( を打つと出る。Mac では Option+` でも出せる。
export const completionKeys = completionKeymap.filter((binding) => binding.key !== 'Ctrl-Space')
