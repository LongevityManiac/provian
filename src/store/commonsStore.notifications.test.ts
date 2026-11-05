import { beforeEach, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ getPendingConsents: vi.fn(), unreadThreads: vi.fn(), getMyReplies: vi.fn() }));
vi.mock('../core/commons/CommonsService', () => service);
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => '0') } }));
import useCommonsStore from './commonsStore';

beforeEach(() => {
  useCommonsStore.getState().reset();
  service.getPendingConsents.mockReset().mockResolvedValue({ consents: [] });
  service.unreadThreads.mockReset().mockResolvedValue({ count: 0, threads: [] });
  service.getMyReplies.mockReset().mockResolvedValue({ replies: [] });
});

function holdFirstConsentRead() {
  let release = () => {};
  const pending = new Promise<{ consents: [] }>(resolve => { release = () => resolve({ consents: [] }); });
  service.getPendingConsents.mockImplementationOnce(() => pending);
  return release;
}

it('an older refresh cannot restore an unread badge after a successful read refresh', async () => {
  const release = holdFirstConsentRead();
  service.unreadThreads.mockResolvedValueOnce({ count: 1, threads: [] });
  const beforeRead = useCommonsStore.getState().refreshNotifications();
  await useCommonsStore.getState().refreshNotifications();
  expect(useCommonsStore.getState().inboxUnread).toBe(0);
  release(); await beforeRead;
  expect(useCommonsStore.getState().unreadThreads).toBe(0);
  expect(useCommonsStore.getState().inboxUnread).toBe(0);
});

it('reset invalidates pending notification reads', async () => {
  const release = holdFirstConsentRead();
  service.unreadThreads.mockResolvedValueOnce({ count: 1, threads: [] });
  const pending = useCommonsStore.getState().refreshNotifications();
  useCommonsStore.getState().reset();
  release(); await pending;
  expect(useCommonsStore.getState().inboxUnread).toBe(0);
});

it('a failed newer refresh keeps known counts and cannot be overwritten by a stale round', async () => {
  useCommonsStore.setState({ unreadThreads: 3, inboxUnread: 3 });
  const release = holdFirstConsentRead();
  service.unreadThreads.mockResolvedValueOnce({ count: 1, threads: [] });
  const stale = useCommonsStore.getState().refreshNotifications();
  service.getPendingConsents.mockRejectedValueOnce(new Error('offline'));
  service.unreadThreads.mockRejectedValueOnce(new Error('offline'));
  service.getMyReplies.mockRejectedValueOnce(new Error('offline'));
  await useCommonsStore.getState().refreshNotifications();
  expect(useCommonsStore.getState().inboxUnread).toBe(3);
  release(); await stale;
  expect(useCommonsStore.getState().inboxUnread).toBe(3);
});
