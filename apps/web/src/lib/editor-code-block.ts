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
