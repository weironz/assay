import SambaPage from './features/samba/SambaPage';
import AdministrationPage from './pages/AdministrationPage';
import FilesPage from './features/files/FilesPage';
import DirectorySettingsPage from './pages/DirectorySettingsPage';
import { PLATFORM_PERMISSIONS } from './lib/business-navigation';
import AssetsPage, { AssetDetailPage } from './features/cop/AssetsPage';
import PartsPage, { PartDetailPage } from './features/cop/PartsPage';
import InventoryPage from './features/cop/InventoryPage';
import OrganizationPage from './features/cop/OrganizationPage';
import AssetImportPage from './features/cop/AssetImportPage';
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
import NewTicketPage from './pages/NewTicketPage';
import TicketDetailPage from './pages/TicketDetailPage';
import UsersPage from './pages/UsersPage';
import QueuesPage from './pages/QueuesPage';
import SlaPage from './pages/SlaPage';
import PublicTicketSharePage from './pages/PublicTicketSharePage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
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
      { path: 'tickets', element: <TicketsPage /> },
      {
        path: 'tickets/dashboard',
        element: (
          <ProtectedRoute permission="ticket:read">
            <DashboardPage />
          </ProtectedRoute>
        ),
      },
      { path: 'tickets/new', element: <NewTicketPage /> },
      { path: 'tickets/:id', element: <TicketDetailPage /> },
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
      {
        path: 'queues',
        element: (
          <ProtectedRoute permission="queue:manage">
            <QueuesPage />
          </ProtectedRoute>
        ),
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
