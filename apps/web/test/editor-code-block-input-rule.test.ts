import { describe, expect, test } from 'bun:test';
import { createChainableState, getSchema, type InputRule } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import {
  CODE_BLOCK_OPTIONS,
  CodeBlockTail,
  InstantCodeBlock,
  codeBlockShortcutFromLine,
} from '../src/lib/editor-code-block';
import { MarkdownLink } from '../src/lib/editor-markdown-link';

const schema = getSchema([StarterKit, MarkdownLink]);

function applyInput(rule: InputRule, text: string, lastCharacter: string) {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
  const state = EditorState.create({ doc });
  const match = (rule.find as RegExp).exec(text + lastCharacter);
  if (!match) return null;

  const transaction = state.tr;
  const params = {
    state: createChainableState({ state, transaction }),
    range: { from: match.index + 1, to: text.length + 1 },
    match,
  } as Parameters<InputRule['handler']>[0];
  if (rule.handler(params) === null || !transaction.docChanged) return null;
  return transaction.doc.firstChild;
}

test('the third backtick starts a code block at the beginning of the line', () => {
  const [rule] = InstantCodeBlock.config.addInputRules!.call({ editor: { schema } } as never);
  expect(applyInput(rule, '``', '`')?.type.name).toBe('codeBlock');
  expect(applyInput(rule, 'plain ``', '`')).toBeNull();
});

test('Markdown links convert on the closing parenthesis while keeping unsafe or escaped syntax literal', () => {
  const [rule] = MarkdownLink.config.addInputRules!.call({ type: schema.marks.link } as never);
  const node = applyInput(rule, 'See [documentation](/docs/name_(detail)', ')');
  expect(node?.textContent).toBe('See documentation');
  expect(node?.lastChild?.marks[0].attrs.href).toBe('/docs/name_(detail)');
  for (const text of ['[bad](javascript:alert(1)', '![image](https://example.com/a.png', '\\[literal](/docs']) {
    expect(applyInput(rule, text, ')')).toBeNull();
  }
});

describe('#32 行首 ``` + Enter 生成代码块', () => {
  test('空行只输入 ``` 时命中，内容为空', () => {
    expect(codeBlockShortcutFromLine('```')).toEqual({ content: '' });
  });

  test('带语言标识时保留语言，内容为空', () => {
    expect(codeBlockShortcutFromLine('```ts')).toEqual({
      language: 'ts',
      content: '',
    });
  });

  test('行首后面还有原有内容时仍命中，且原内容完整保留（不吞字）', () => {
    expect(codeBlockShortcutFromLine('```原有正文')).toEqual({
      content: '原有正文',
    });
    expect(codeBlockShortcutFromLine('```js const x = 1;')).toEqual({
      language: 'js',
      content: 'const x = 1;',
    });
  });

  test('``` 后的分隔空格不进入代码块内容', () => {
    expect(codeBlockShortcutFromLine('```   hello world')).toEqual({
      content: 'hello world',
    });
  });

  test('不以行首 ``` 开头的普通文本不命中', () => {
    for (const line of ['', '普通文本', ' ```', 'x```', '``', '~~~']) {
      expect({ line, hit: codeBlockShortcutFromLine(line) }).toEqual({
        line,
        hit: null,
      });
    }
  });
});

describe('#32 现有代码块行为不被破坏', () => {
  test('exitOnTripleEnter 保持关闭，避免三次回车误退出', () => {
    expect(CODE_BLOCK_OPTIONS.exitOnTripleEnter).toBe(false);
  });

  test('CodeBlockTail 仍注册 ProseMirror 插件（尾部段落/光标落点）', () => {
    expect(CodeBlockTail.config.addProseMirrorPlugins).toBeTypeOf('function');
    expect(CodeBlockTail.config.addProseMirrorPlugins).not.toBeUndefined();
  });
});
