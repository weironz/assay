"""Compare existing records without exporting their plaintext into CI output."""
import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess


def capture(query, baseline=None):
    tables = query("SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public'")
    result = {'tables': {}, 'attachmentBindings': {}}
    for table in tables:
        # Role changes intentionally invalidate sessions. Attachment migration
        # may fill empty associations; every nonempty association is checked too.
        if table == 'sessions':
            continue
        current_columns = query("SELECT json_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='" + table.replace("'", "''") + "'")
        original = (baseline or {}).get('tables', {}).get(table)
        columns = original['columns'] if original else current_columns
        if not set(columns).issubset(current_columns):
            raise RuntimeError('Existing columns missing after upgrade: ' + table)
        ignored = {'users': ['session_epoch', 'updatedAt'],
                   'ticket_attachments': ['ticket_id', 'message_id']}.get(table, [])
        keys = 'ARRAY[' + ','.join("'" + key.replace("'", "''") + "'" for key in columns if key not in ignored) + ']::text[]'
        projected = '(SELECT jsonb_object_agg(entry.key,entry.value) FROM jsonb_each(to_jsonb(t)) entry WHERE entry.key=ANY(' + keys + '))'
        digest = "encode(sha256(convert_to(" + projected + "::text,'UTF8')),'hex')"
        identifier = '"' + table.replace('"', '""') + '"'
        result['tables'][table] = query("SELECT json_build_object('count',count(*),'rows',COALESCE(json_agg(" + digest + ' ORDER BY ' + digest + "),'[]'::json)) FROM " + identifier + ' t')
        result['tables'][table]['columns'] = columns
    if 'ticket_attachments' in tables:
        result['attachmentBindings'] = query("SELECT COALESCE(json_object_agg(id,json_build_object('ticket',ticket_id,'message',message_id)),'{}'::json) FROM ticket_attachments")
    return result


def assert_preserved(before, after):
    for table, snapshot in before['tables'].items():
        if table not in after['tables']:
            raise RuntimeError('Existing table missing after upgrade: ' + table)
        missing = Counter(snapshot['rows']) - Counter(after['tables'][table]['rows'])
        if missing:
            raise RuntimeError('Existing records changed or missing after upgrade: ' + table)
    for attachment, original in before['attachmentBindings'].items():
        current = after['attachmentBindings'].get(attachment)
        if current is None or any(value is not None and current.get(field) != value for field, value in original.items()):
            raise RuntimeError('Existing attachment identity or association changed')
    return {'preserved': True, 'beforeCounts': {k: v['count'] for k, v in before['tables'].items()},
            'afterCounts': {k: v['count'] for k, v in after['tables'].items()}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['capture', 'compare'])
    parser.add_argument('--output')
    parser.add_argument('--before')
    parser.add_argument('--after')
    args = parser.parse_args()
    if args.action == 'compare':
        result = assert_preserved(json.loads(Path(args.before).read_text()), json.loads(Path(args.after).read_text()))
        print(json.dumps(result))
        return
    def run(command):
        return subprocess.check_output(command, text=True).strip()
    pg = run(['docker', 'compose', 'ps', '-q', 'postgres'])
    item = json.loads(run(['docker', 'inspect', pg]))[0]
    env = dict(value.split('=', 1) for value in item['Config']['Env'] if '=' in value)
    def query(sql):
        return json.loads(run(['docker', 'exec', pg, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                               '-U', env['POSTGRES_USER'], '-d', env['POSTGRES_DB'], '-c', sql]))
    output = Path(args.output)
    baseline = json.loads(Path(args.before).read_text()) if args.before else None
    output.write_text(json.dumps(capture(query, baseline)) + '\n')
    output.chmod(0o600)
    print('Database preservation snapshot recorded')


if __name__ == '__main__':
    main()
