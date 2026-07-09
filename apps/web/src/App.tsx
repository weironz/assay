import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { useAuth } from './stores/auth';

const queryClient = new QueryClient();

export default function App() {
  const fetchMe = useAuth((s) => s.fetchMe);
  const clear = useAuth((s) => s.clear);

  useEffect(() => {
    fetchMe();
    const onUnauthorized = () => clear();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, [fetchMe, clear]);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
