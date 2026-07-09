import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useUnreadCount,
  useNotifications,
  useMarkRead,
  useMarkAllRead,
} from '../features/notifications/api';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: unread = 0 } = useUnreadCount();
  const { data: list } = useNotifications(open);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const openNotif = (id: string, ticketId: string | null) => {
    markRead.mutate(id);
    if (ticketId) {
      setOpen(false);
      navigate(`/tickets/${ticketId}`);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
        title="通知"
      >
        <span className="text-lg">🔔</span>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-auto z-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-800">
              <span className="text-sm font-medium">通知</span>
              <button
                onClick={() => markAll.mutate()}
                className="text-xs text-blue-600 hover:underline"
              >
                全部已读
              </button>
            </div>
            {!list?.length && (
              <p className="px-3 py-6 text-center text-sm text-gray-400">
                暂无通知
              </p>
            )}
            <ul>
              {list?.map((n) => (
                <li
                  key={n.id}
                  onClick={() => openNotif(n.id, n.ticketId)}
                  className={`px-3 py-2 border-b border-gray-50 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ${
                    n.isRead ? 'opacity-60' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!n.isRead && (
                      <span className="mt-1.5 w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm text-gray-800 dark:text-gray-200 truncate">
                        {n.title}
                      </p>
                      {n.content && (
                        <p className="text-xs text-gray-400 truncate">
                          {n.content}
                        </p>
                      )}
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        {new Date(n.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
