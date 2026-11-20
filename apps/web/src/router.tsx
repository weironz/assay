import { lazy } from 'react';
import AdministrationPage from './pages/AdministrationPage';
import DirectorySettingsPage from './pages/DirectorySettingsPage';
import { PLATFORM_PERMISSIONS } from './lib/business-navigation';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ProfilePage from './pages/ProfilePage';
import AppLayout from './components/AppLayout';
import ProtectedRoute from './components/ProtectedRoute';
import DashboardPage from './pages/DashboardPage';
import PlatformOverviewPage from './pages/PlatformOverviewPage';
import TicketsPage from './pages/TicketsPage';
import UsersPage from './pages/UsersPage';
import SlaPage from './pages/SlaPage';
import PublicTicketSharePage from './pages/PublicTicketSharePage';

const NewTicketPage = lazy(() => import('./pages/NewTicketPage'));
const TicketDetailPage = lazy(() => import('./pages/TicketDetailPage'));
const FilesPage = lazy(() => import('./features/files/FilesPage'));
const SambaPage = lazy(() => import('./features/samba/SambaPage'));
const AssetsPage = lazy(() => import('./features/cop/AssetsPage'));
const AssetDetailPage = lazy(() => import('./features/cop/AssetsPage').then(module => ({ default: module.AssetDetailPage })));
const PartsPage = lazy(() => import('./features/cop/PartsPage'));
const PartDetailPage = lazy(() => import('./features/cop/PartsPage').then(module => ({ default: module.PartDetailPage })));
const InventoryPage = lazy(() => import('./features/cop/InventoryPage'));
const OrganizationPage = lazy(() => import('./features/cop/OrganizationPage'));
const AssetImportPage = lazy(() => import('./features/cop/AssetImportPage'));

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage key="login" /> },
  { path: '/login/admin', element: <LoginPage key="admin-login" /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/share/:token', element: <PublicTicketSharePage /> },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <AppLayout />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <PlatformOverviewPage /> },
      {
        path: 'platform',
        element: (
          <ProtectedRoute anyPermissions={PLATFORM_PERMISSIONS}>
            <AdministrationPage />
          </ProtectedRoute>
        ),
      },
      { path: 'settings', element: <ProfilePage /> },
      { path: 'directory-settings', element: <ProtectedRoute permission="user:manage"><DirectorySettingsPage /></ProtectedRoute> },
      { path: 'profile', element: <Navigate to="/settings" replace /> },
      {
        path: 'assets',
        element: (
          <ProtectedRoute permission="asset:read">
            <AssetsPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'assets/import',
        element: (
          <ProtectedRoute permission="asset:manage">
            <AssetImportPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'assets/:id',
        element: (
          <ProtectedRoute permission="asset:read">
            <AssetDetailPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'spare-parts',
        element: (
          <ProtectedRoute permission="inventory:read">
            <PartsPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'spare-parts/:id',
        element: (
          <ProtectedRoute permission="inventory:read">
            <PartDetailPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'inventory',
        element: (
          <ProtectedRoute permission="inventory:read">
            <InventoryPage />
          </ProtectedRoute>
        ),
      },
      { path: 'samba', element: <Navigate to="/samba/users" replace /> },
      { path: 'samba/overview', element: <ProtectedRoute permission="samba:read"><AdministrationPage directoryMode /></ProtectedRoute> },
      { path: 'files', element: <FilesPage /> },
      {
        path: 'samba/:section/:id?',
        element: (
          <ProtectedRoute permission="samba:read">
            <SambaPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'organization',
        element: (
          <ProtectedRoute permission="organization:manage">
            <OrganizationPage />
          </ProtectedRoute>
        ),
      },
      { path: 'tickets', element: <ProtectedRoute permission="ticket:read"><TicketsPage /></ProtectedRoute> },
      {
        path: 'tickets/dashboard',
        element: (
          <ProtectedRoute permission="ticket:read">
            <DashboardPage />
          </ProtectedRoute>
        ),
      },
      { path: 'tickets/new', element: <ProtectedRoute permission="ticket:create"><NewTicketPage /></ProtectedRoute> },
      { path: 'tickets/:id', element: <ProtectedRoute permission="ticket:read"><TicketDetailPage /></ProtectedRoute> },
      {
        path: 'users',
        element: (
          <ProtectedRoute permission="user:manage">
            <UsersPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'sla',
        element: (
          <ProtectedRoute permission="queue:manage">
            <SlaPage />
          </ProtectedRoute>
        ),
      },
      { path: 'queues', element: <Navigate to="/tickets" replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
