import Link from '@tiptap/extension-link';
import { InputRule } from '@tiptap/react';

// Leave image syntax to the Image extension and escaped brackets as text.
const markdownLink = /(?<![!\\])\[([^\[\]\r\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)$/;

export const MarkdownLink = Link.extend({
  addInputRules() {
    return [new InputRule({
      find: markdownLink,
      handler: ({ state, range, match }) => {
        const [, label, href] = match;
        if (!label.trim()) return null;
        let url: URL;
        try {
          url = new URL(href, 'https://assay.invalid');
        } catch {
          return null;
        }
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;

        state.tr
          .insertText(label, range.from, range.to)
          .addMark(range.from, range.from + label.length, this.type.create({ href }))
          .removeStoredMark(this.type);
      },
    })];
  },
});
