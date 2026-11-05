import { Extension } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// An actual paragraph after a terminal code block gives both mouse and touch
// users a caret target. Keep it outside the code block, without stealing focus.
export const CodeBlockTail = Extension.create({
  name: 'codeBlockTail',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('codeBlockTail'),
        appendTransaction(_transactions, _oldState, state) {
          if (state.doc.lastChild?.type.name !== 'codeBlock') return null;
          return state.tr
            .insert(
              state.doc.content.size,
              state.schema.nodes.paragraph.create(),
            )
            .setMeta('addToHistory', false);
        },
      }),
    ];
  },
  onCreate() {
    // Existing content must get the same caret target before the first edit.
    if (this.editor.state.doc.lastChild?.type.name === 'codeBlock') {
      this.editor.view.dispatch(
        this.editor.state.tr.setMeta('codeBlockTailInit', true),
      );
    }
  },
});

export const CODE_BLOCK_OPTIONS = { exitOnTripleEnter: false };

export interface CodeBlockShortcut {
  language?: string;
  /** ``` 前缀之后原有的行内容，转换时保留为代码块正文 */
  content: string;
}

/**
 * 判定「行首输入 ```（可带语言）后按 Enter」是否应转成代码块。
 *
 * Tiptap 自带 input rule 的正则是 /^```([a-z]+)?[\s\n]$/，要求整行恰好是
 * ``` 加一个空白字符；光标停在已有内容行的行首时，``` 后面还跟着原文字，
 * 正则不命中，于是「行首不生效、先新建空行才生效」。这里单独做判定，
 * 由 RichEditor 的 Enter 处理兜底，并把原文字作为代码块内容保留下来。
 */
export function codeBlockShortcutFromLine(line: string): CodeBlockShortcut | null {
  const match = /^```([a-z]+)?[ \t]*([\s\S]*)$/.exec(line);
  if (!match) return null;
  return {
    ...(match[1] ? { language: match[1] } : {}),
    content: match[2],
  };
}
