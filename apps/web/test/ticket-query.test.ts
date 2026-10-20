import { expect, test } from 'bun:test';
import {
  ticketQueryFromSearch,
  ticketQuerySearch,
  dateBoundary,
  boundaryDate,
} from '../src/lib/ticket-query';
import { getSchema } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { newlineInCode } from '@tiptap/pm/commands';
import {
  CodeBlockTail,
  CODE_BLOCK_OPTIONS,
} from '../src/lib/editor-code-block';

test('all list filters survive URLs, reloads and saved views without pagination loss', () => {
  const query = {
    datacenterId: 'bkk',
    assigneeId: '__none__',
    requesterId: 'u',
    categoryId: 'c',
    ticketNo: 'WO-42',
    keyword: 'GPU',
    scope: 'open' as const,
    slaState: 'within' as const,
    priority: 'HIGH',
    queueId: 'q',
    createdFrom: dateBoundary('2026-10-20'),
    createdTo: dateBoundary('2026-10-21', true),
    page: 2,
    pageSize: 50,
  };
  expect(ticketQueryFromSearch(ticketQuerySearch(query))).toEqual(query);
  expect(
    ticketQueryFromSearch(
      new URLSearchParams('scope=invalid&slaState=bad&page=-2&pageSize=1000'),
    ),
  ).toEqual({ page: 1, pageSize: 20 });
});

test('local inclusive calendar days round trip through UTC boundaries, including month/year boundaries', () => {
  for (const day of ['2026-10-20', '2026-12-31', '2024-02-29']) {
    expect(boundaryDate(dateBoundary(day))).toBe(day);
    expect(boundaryDate(dateBoundary(day, true), true)).toBe(day);
  }
  expect(dateBoundary('')).toBeUndefined();
  expect(boundaryDate('bad')).toBe('');
});

test('code blocks keep repeated newlines and an outside caret target without moving the selection or appending repeatedly', () => {
  expect(CODE_BLOCK_OPTIONS.exitOnTripleEnter).toBe(false);
  const schema = getSchema([
    StarterKit.configure({ codeBlock: CODE_BLOCK_OPTIONS }),
  ]);
  const plugins = CodeBlockTail.config.addProseMirrorPlugins!.call({} as never);
  const doc = schema.nodes.doc.create(
    null,
    schema.nodes.codeBlock.create(null, schema.text('code')),
  );
  let state = EditorState.create({
    schema,
    doc,
    plugins,
    selection: TextSelection.create(doc, 5),
  });
  state = state.applyTransaction(state.tr.setMeta('initial', true)).state;
  expect(state.doc.childCount).toBe(2);
  expect(state.doc.lastChild!.type.name).toBe('paragraph');
  expect(state.selection.$from.parent.type.name).toBe('codeBlock');
  for (let index = 0; index < 6; index++)
    expect(
      newlineInCode(state, (transaction) => {
        state = state.applyTransaction(transaction).state;
      }),
    ).toBe(true);
  expect(state.doc.firstChild!.textContent).toBe('code\n\n\n\n\n\n');
  expect(state.doc.childCount).toBe(2);
  expect(state.selection.$from.parent.type.name).toBe('codeBlock');
  state = state.applyTransaction(
    state.tr.setSelection(TextSelection.atEnd(state.doc)),
  ).state;
  state = state.applyTransaction(state.tr.insertText('outside')).state;
  expect(state.doc.lastChild!.textContent).toBe('outside');
  expect(state.doc.firstChild!.textContent).toEndWith('\n\n\n');
});
