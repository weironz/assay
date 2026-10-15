import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../stores/auth';

/** 登录 + 可选权限守卫 */
export default function ProtectedRoute({
  children,
  permission,
  anyPermissions,
}: {
  children: ReactNode;
  permission?: string;
  anyPermissions?: string[];
}) {
  const { t } = useTranslation();
  const { user, loading, has } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400">
        {t('common.loading')}
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (
    (permission && !has(permission)) ||
    (anyPermissions && !anyPermissions.some(has))
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-500">
        {t('nav.noAccess')}
      </div>
    );
  }
  return <>{children}</>;
}
