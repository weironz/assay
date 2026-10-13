import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useCopQuery } from './api';
import {
  Failure,
  PageHeading,
  ResourceForm,
  button,
  input,
  panel,
  secondary,
} from './ui';
type Department = {
  id: string;
  name: string;
  parentId: string | null;
  active: boolean;
  _count: { users: number; assets: number; warehouses: number };
};
export default function OrganizationPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const departments = useCopQuery<Department[]>('/departments');
  const members = useCopQuery<
    { id: string; name: string; email: string; departmentId: string | null }[]
  >('/departments/members');
  const [editing, setEditing] = useState<Department | null | undefined>(
    undefined,
  );
  const saveMember = useMutation({
    mutationFn: ({ id, departmentId }: { id: string; departmentId: string }) =>
      api.patch('/departments/members/' + id, { departmentId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cop'] }),
  });
  return (
    <>
      <PageHeading
        title={t('cop.organization')}
        hint={t('cop.organizationHint')}
      >
        <button className={button} onClick={() => setEditing(null)}>
          {t('cop.newDepartment')}
        </button>
      </PageHeading>
      {departments.isError && (
        <Failure error={departments.error} retry={departments.refetch} />
      )}
      <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {departments.data?.map((d) => (
          <section className={panel} key={d.id}>
            <div className="flex justify-between">
              <h2 className="font-semibold">{d.name}</h2>
              <button className={secondary} onClick={() => setEditing(d)}>
                {t('cop.edit')}
              </button>
            </div>
            <p className="mt-2 text-sm text-gray-500">
              {t(d.active ? 'cop.active' : 'cop.inactive')} · {d._count.users}{' '}
              {t('cop.members')}
            </p>
            {d.parentId && (
              <p className="mt-2 text-sm">
                {t('cop.parentId')}:{' '}
                {departments.data?.find((x) => x.id === d.parentId)?.name}
              </p>
            )}
          </section>
        ))}
      </div>
      <section className={panel}>
        <h2 className="mb-4 font-semibold">{t('cop.members')}</h2>
        {members.isError && <Failure error={members.error} />}{' '}
        {saveMember.isError && <Failure error={saveMember.error} />}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="pb-2">{t('cop.name')}</th>
                <th className="pb-2">{t('common.email')}</th>
                <th className="pb-2">{t('cop.departmentId')}</th>
              </tr>
            </thead>
            <tbody>
              {members.data?.map((m) => (
                <tr className="border-t dark:border-gray-800" key={m.id}>
                  <td className="py-3">{m.name}</td>
                  <td>{m.email}</td>
                  <td>
                    <select
                      className={input}
                      aria-label={m.name + ' ' + t('cop.departmentId')}
                      value={m.departmentId ?? ''}
                      disabled={saveMember.isPending}
                      onChange={(e) =>
                        saveMember.mutate({
                          id: m.id,
                          departmentId: e.target.value,
                        })
                      }
                    >
                      <option value="">{t('cop.optional')}</option>
                      {departments.data
                        ?.filter((d) => d.active || d.id === m.departmentId)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {editing !== undefined && (
        <ResourceForm
          title={editing ? t('cop.edit') : t('cop.newDepartment')}
          fields={[
            { key: 'name', required: true },
            {
              key: 'parentId',
              type: 'select',
              options: departments.data
                ?.filter((d) => d.active && d.id !== editing?.id)
                .map((d) => ({ value: d.id, label: d.name })),
            },
            { key: 'active', type: 'checkbox' },
          ]}
          initial={editing ? { ...editing } : { active: true }}
          onClose={() => setEditing(undefined)}
          onSave={async (data) => {
            if (editing) await api.put('/departments/' + editing.id, data);
            else await api.post('/departments', data);
            await qc.invalidateQueries({ queryKey: ['cop'] });
          }}
        />
      )}
    </>
  );
}
