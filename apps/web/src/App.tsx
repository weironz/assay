import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { useAuth } from './stores/auth';

// 模块级单例：登出时通过 resetQueryCache 清空，避免换账号后渲染上一用户的缓存数据
const queryClient = new QueryClient();

export function resetQueryCache() {
  queryClient.clear();
}

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
